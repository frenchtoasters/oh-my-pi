import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { SandboxAccessMode, SandboxCaps, SandboxProxy, Shell, sandboxIsSupported } from "@oh-my-pi/pi-natives";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	BUILTIN_PROFILES,
	buildSandboxCaps,
	enforceSandboxAccess,
	enforceSandboxNetwork,
	resolveProfile,
	type SandboxMode,
	type SandboxProfile,
} from "../../src/security/sandbox";

// ═══════════════════════════════════════════════════════════════════════════
// Test fixtures: real directories on disk (required by Landlock/Seatbelt).
// All paths are realpath-resolved because nono canonicalizes internally and
// queryPath checks against the canonicalized stored paths.
// ═══════════════════════════════════════════════════════════════════════════

let testDir: string; // realpath-resolved
let testSubDir: string; // realpath-resolved

beforeAll(async () => {
	const raw = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"));
	testDir = fsSync.realpathSync(raw);
	testSubDir = path.join(testDir, "subdir");
	await fs.mkdir(testSubDir, { recursive: true });
	await fs.writeFile(path.join(testSubDir, "file.ts"), "export const x = 1;\n");
});

function makeSession(mode: SandboxMode, caps?: SandboxCaps): ToolSession {
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "security.sandbox": mode }),
		sandboxCaps: caps,
	} as unknown as ToolSession;
}

// ═══════════════════════════════════════════════════════════════════════════
// Native SandboxCaps class behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("SandboxCaps (native class)", () => {
	it("empty capability set denies all paths", () => {
		const caps = new SandboxCaps();
		expect(caps.queryPath("/etc/passwd", SandboxAccessMode.Read)).toBe(false);
		expect(caps.queryPath(testDir, SandboxAccessMode.Write)).toBe(false);
		expect(caps.queryPath(os.homedir(), SandboxAccessMode.ReadWrite)).toBe(false);
	});

	it("allowPath grants read access to the specified directory tree", () => {
		const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.Read);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Read)).toBe(true);
		expect(caps.queryPath(testDir, SandboxAccessMode.Read)).toBe(true);
	});

	it("allowPath with Read does not grant write access", () => {
		const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.Read);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Write)).toBe(false);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.ReadWrite)).toBe(false);
	});

	it("allowPath with ReadWrite grants both read and write", () => {
		const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Read)).toBe(true);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Write)).toBe(true);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.ReadWrite)).toBe(true);
	});

	it("allowPath does not grant access outside the specified tree", () => {
		const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
		const realEtc = fsSync.realpathSync("/etc");
		expect(caps.queryPath(path.join(realEtc, "hosts"), SandboxAccessMode.Read)).toBe(false);
	});

	it("multiple allowPath calls combine additively", () => {
		const caps = new SandboxCaps()
			.allowPath(testDir, SandboxAccessMode.ReadWrite)
			.allowPath("/usr", SandboxAccessMode.Read);

		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Write)).toBe(true);
		expect(caps.queryPath("/usr/bin/git", SandboxAccessMode.Read)).toBe(true);
		expect(caps.queryPath("/usr/bin/git", SandboxAccessMode.Write)).toBe(false);
	});

	it("is immutable — allowPath returns a new instance", () => {
		const empty = new SandboxCaps();
		const withPath = empty.allowPath(testDir, SandboxAccessMode.Read);

		// Original remains unchanged
		expect(empty.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Read)).toBe(false);
		// New instance has the path
		expect(withPath.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Read)).toBe(true);
	});

	it("blockNetwork preserves file permissions on the new instance", () => {
		const base = new SandboxCaps().allowPath(testDir, SandboxAccessMode.Read);
		const blocked = base.blockNetwork();
		expect(blocked.queryPath(path.join(testDir, "subdir"), SandboxAccessMode.Read)).toBe(true);
	});

	it("proxyOnly preserves file permissions on the new instance", () => {
		const base = new SandboxCaps().allowPath(testDir, SandboxAccessMode.Read);
		const proxied = base.proxyOnly(8080);
		expect(proxied.queryPath(path.join(testDir, "subdir"), SandboxAccessMode.Read)).toBe(true);
	});

	it("summary returns a non-empty string describing capabilities", () => {
		const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite).blockNetwork();
		const summary = caps.summary();
		expect(typeof summary).toBe("string");
		expect(summary.length).toBeGreaterThan(0);
		// Summary should mention the path and access mode
		expect(summary).toContain(testDir);
		expect(summary).toContain("read+write");
	});

	it("allowPath throws for non-existent paths", () => {
		const caps = new SandboxCaps();
		expect(() => caps.allowPath("/nonexistent/path/that/does/not/exist", SandboxAccessMode.Read)).toThrow(
			/does not exist/i,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// sandboxIsSupported()
// ═══════════════════════════════════════════════════════════════════════════

describe("sandboxIsSupported()", () => {
	it("returns a boolean", () => {
		expect(typeof sandboxIsSupported()).toBe("boolean");
	});

	if (process.platform === "darwin" || process.platform === "linux") {
		it("returns true on unix platforms", () => {
			expect(sandboxIsSupported()).toBe(true);
		});
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Profile Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveProfile()", () => {
	it("returns the built-in profile for known agent names", () => {
		const profile = resolveProfile("explore", {});
		expect(profile).toEqual(BUILTIN_PROFILES.explore);
		expect(profile.fs).toEqual([{ path: "$CWD", mode: "read" }]);
		expect(profile.network).toBe("blocked");
	});

	it("returns built-in task profile with correct filesystem permissions", () => {
		const profile = resolveProfile("task", {});
		expect(profile.fs).toContainEqual({ path: "$CWD", mode: "readwrite" });
		expect(profile.fs).toContainEqual({ path: "$HOME/.bun", mode: "read" });
		expect(profile.fs).toContainEqual({ path: "$HOME/.cargo", mode: "read" });
		expect(profile.network).toBe("blocked");
	});

	it("returns librarian profile with network hosts for package registries", () => {
		const profile = resolveProfile("librarian", {});
		expect(profile.network).toEqual({
			allowedHosts: ["registry.npmjs.org", "*.crates.io", "docs.rs", "*.pypi.org"],
		});
		expect(profile.fs.some(f => f.path === "$CWD")).toBe(true);
	});

	it("user overrides take precedence over built-in profiles", () => {
		const customProfile: SandboxProfile = {
			fs: [{ path: "/custom/path", mode: "readwrite" }],
			network: "allow-all",
		};
		const profile = resolveProfile("explore", { explore: customProfile });
		expect(profile).toEqual(customProfile);
		expect(profile).not.toEqual(BUILTIN_PROFILES.explore);
	});

	it("fails closed for unknown agent names: network blocked, not allow-all", () => {
		// Agent definitions are discoverable from project directories, so an
		// unrecognized name must never grant unrestricted egress.
		const profile = resolveProfile("unknown-agent-xyz", {});
		expect(profile.fs).toEqual([{ path: "$CWD", mode: "readwrite" }]);
		expect(profile.network).toBe("blocked");
	});

	it("unknown agent with user override returns the override", () => {
		const customProfile: SandboxProfile = {
			fs: [{ path: "/only/here", mode: "read" }],
			network: "blocked",
		};
		const profile = resolveProfile("my-custom-agent", { "my-custom-agent": customProfile });
		expect(profile).toEqual(customProfile);
	});

	it("all built-in read-only agents have network blocked", () => {
		for (const name of [
			"explore",
			"reviewer",
			"ultra-review-gemini",
			"ultra-review-opus",
			"ultra-review-sonnet",
			"plan",
		]) {
			const profile = resolveProfile(name, {});
			expect(profile.network).toBe("blocked");
			expect(profile.fs.every(f => f.mode === "read")).toBe(true);
		}
	});

	it("init profile has readwrite CWD and limited network", () => {
		const profile = resolveProfile("init", {});
		expect(profile.fs).toContainEqual({ path: "$CWD", mode: "readwrite" });
		expect(typeof profile.network).toBe("object");
		if (typeof profile.network === "object") {
			expect(profile.network.allowedHosts).toContain("registry.npmjs.org");
			expect(profile.network.allowedHosts).toContain("*.crates.io");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// buildSandboxCaps()
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSandboxCaps()", () => {
	it("includes existing system read paths for executable resolution", () => {
		const profile: SandboxProfile = { fs: [], network: "blocked" };
		const caps = buildSandboxCaps(profile, testDir);

		// /usr always exists and should be readable
		expect(caps.queryPath("/usr/bin/git", SandboxAccessMode.Read)).toBe(true);
	});

	it("system read paths do not grant write", () => {
		const profile: SandboxProfile = { fs: [], network: "blocked" };
		const caps = buildSandboxCaps(profile, testDir);

		expect(caps.queryPath("/usr/bin/something", SandboxAccessMode.Write)).toBe(false);
	});

	it("/tmp is readwrite (system temp dir)", () => {
		const profile: SandboxProfile = { fs: [], network: "blocked" };
		const caps = buildSandboxCaps(profile, testDir);

		// On macOS, /tmp -> /private/tmp; query with realpath
		const realTmp = fsSync.realpathSync("/tmp");
		expect(caps.queryPath(path.join(realTmp, "some-file"), SandboxAccessMode.ReadWrite)).toBe(true);
	});

	it("expands $CWD in profile paths to the provided cwd", () => {
		const profile: SandboxProfile = {
			fs: [{ path: "$CWD", mode: "readwrite" }],
			network: "blocked",
		};
		const caps = buildSandboxCaps(profile, testDir);

		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.ReadWrite)).toBe(true);
	});

	it("expands $HOME in profile paths", () => {
		const home = fsSync.realpathSync(os.homedir());
		const profile: SandboxProfile = {
			fs: [{ path: "$HOME", mode: "read" }],
			network: "blocked",
		};
		const caps = buildSandboxCaps(profile, testDir);

		expect(caps.queryPath(path.join(home, "somefile"), SandboxAccessMode.Read)).toBe(true);
		expect(caps.queryPath(path.join(home, "somefile"), SandboxAccessMode.Write)).toBe(false);
	});

	it("read mode in profile does not grant write", () => {
		const profile: SandboxProfile = {
			fs: [{ path: "$CWD", mode: "read" }],
			network: "blocked",
		};
		const caps = buildSandboxCaps(profile, testDir);

		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Read)).toBe(true);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Write)).toBe(false);
	});

	it("readwrite mode in profile grants both read and write", () => {
		const profile: SandboxProfile = {
			fs: [{ path: "$CWD", mode: "readwrite" }],
			network: "blocked",
		};
		const caps = buildSandboxCaps(profile, testDir);

		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Read)).toBe(true);
		expect(caps.queryPath(path.join(testSubDir, "file.ts"), SandboxAccessMode.Write)).toBe(true);
	});

	it("paths outside profile and system paths are denied", () => {
		const profile: SandboxProfile = {
			fs: [{ path: "$CWD", mode: "readwrite" }],
			network: "blocked",
		};
		const caps = buildSandboxCaps(profile, testDir);

		// Path well outside any allowed tree
		expect(caps.queryPath("/root/.ssh/id_rsa", SandboxAccessMode.Read)).toBe(false);
	});

	it("gracefully skips non-existent system paths without throwing", () => {
		// Should not throw even though /lib, /lib64 don't exist on macOS
		const profile: SandboxProfile = { fs: [], network: "blocked" };
		expect(() => buildSandboxCaps(profile, testDir)).not.toThrow();
	});

	if (process.platform === "darwin") {
		it("includes macOS-specific system paths on darwin", () => {
			const profile: SandboxProfile = { fs: [], network: "blocked" };
			const caps = buildSandboxCaps(profile, testDir);

			// /opt/homebrew exists on Apple Silicon macs; /System always exists
			if (fsSync.existsSync("/System")) {
				expect(caps.queryPath("/System/Library/Frameworks", SandboxAccessMode.Read)).toBe(true);
			}
			if (fsSync.existsSync("/opt/homebrew")) {
				expect(caps.queryPath("/opt/homebrew/bin/git", SandboxAccessMode.Read)).toBe(true);
			}
		});
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// enforceSandboxAccess()
//
// This function queries the *advisory* capability set (not kernel-enforced).
// queryPath checks against canonicalized paths, but enforceSandboxAccess
// receives an absolutePath and queries directly. For enforcement to work,
// the absolutePath passed to enforceSandboxAccess should match the
// canonical form used internally by nono.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforceSandboxAccess()", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("mode = off", () => {
		it("allows all access regardless of caps — sandbox disabled", () => {
			const caps = new SandboxCaps(); // denies everything
			const session = makeSession("off", caps);
			expect(() => enforceSandboxAccess(session, "/etc/passwd", "read")).not.toThrow();
			expect(() => enforceSandboxAccess(session, "/etc/shadow", "write")).not.toThrow();
		});

		it("allows access when caps is undefined", () => {
			const session = makeSession("off", undefined);
			expect(() => enforceSandboxAccess(session, "/any/path", "read")).not.toThrow();
		});
	});

	describe("mode = warn", () => {
		it("logs warning but does not throw for denied paths", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = makeSession("warn", caps);

			// Path outside testDir (use canonical form)
			expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).not.toThrow();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Sandbox: read access denied"));
		});

		it("does not warn for allowed paths", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = makeSession("warn", caps);

			// Use canonical path under testDir
			enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read");
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("does not warn or throw when caps is undefined", () => {
			const session = makeSession("warn", undefined);
			expect(() => enforceSandboxAccess(session, "/etc/passwd", "read")).not.toThrow();
			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe("mode = enforce", () => {
		it("throws ToolError when read access is denied", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = makeSession("enforce", caps);

			expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
		});

		it("throws ToolError when write access is denied (read-only path)", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.Read);
			const session = makeSession("enforce", caps);

			// testDir is read-only, so write should be denied
			expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).toThrow(ToolError);
		});

		it("error message includes the denied path and access mode", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = makeSession("enforce", caps);

			try {
				enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(ToolError);
				expect((e as ToolError).message).toContain("/root/.ssh/id_rsa");
				expect((e as ToolError).message).toContain("read access denied");
			}
		});

		it("error message distinguishes read vs write denials", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.Read);
			const session = makeSession("enforce", caps);

			try {
				enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect((e as ToolError).message).toContain("write access denied");
			}
		});

		it("allows access to paths covered by the capability set", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = makeSession("enforce", caps);

			expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read")).not.toThrow();
			expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).not.toThrow();
		});

		it("does not throw when caps is undefined (sandbox not initialized)", () => {
			const session = makeSession("enforce", undefined);
			expect(() => enforceSandboxAccess(session, "/etc/passwd", "read")).not.toThrow();
		});

		it("write mode checks ReadWrite access (not just Write)", () => {
			// Read-only path should deny writes; readwrite path should allow writes
			const realTmp = fsSync.realpathSync("/tmp");
			const caps = new SandboxCaps()
				.allowPath(testDir, SandboxAccessMode.Read)
				.allowPath(realTmp, SandboxAccessMode.ReadWrite);
			const session = makeSession("enforce", caps);

			expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).toThrow(ToolError);
			expect(() => enforceSandboxAccess(session, path.join(realTmp, "workfile.txt"), "write")).not.toThrow();
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// SandboxProxy
// ═══════════════════════════════════════════════════════════════════════════

describe("SandboxProxy (native class)", () => {
	it("constructor creates instance without starting", () => {
		const proxy = new SandboxProxy();
		// Should be safe to call shutdown on unstarted proxy
		expect(() => proxy.shutdown()).not.toThrow();
	});

	it("shutdown is idempotent — no error on repeated calls", () => {
		const proxy = new SandboxProxy();
		expect(() => proxy.shutdown()).not.toThrow();
		expect(() => proxy.shutdown()).not.toThrow();
		expect(() => proxy.shutdown()).not.toThrow();
	});

	it("start() succeeds outside a tokio runtime context and returns proxy env", () => {
		// Regression: `start` previously used `tokio::runtime::Handle::current()`,
		// which panics (SIGABRT) when called from the JS thread. Any profile with
		// an allowlist therefore aborted the process.
		const proxy = new SandboxProxy();
		try {
			const started = proxy.start(["example.com"]);
			expect(started.port).toBeGreaterThan(0);
			const env = Object.fromEntries(started.envVars.map(v => [v.key, v.value]));
			expect(env.HTTPS_PROXY).toContain(`127.0.0.1:${started.port}`);
			expect(env.HTTP_PROXY).toContain(`127.0.0.1:${started.port}`);
		} finally {
			proxy.shutdown();
		}
	});

	it("start() is safe to call repeatedly across instances", () => {
		for (let i = 0; i < 3; i++) {
			const proxy = new SandboxProxy();
			const started = proxy.start(["example.com"]);
			expect(started.port).toBeGreaterThan(0);
			proxy.shutdown();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: buildSandboxCaps + enforceSandboxAccess end-to-end
// ═══════════════════════════════════════════════════════════════════════════

describe("integration: buildSandboxCaps -> enforceSandboxAccess", () => {
	function createSession(mode: SandboxMode, profile: SandboxProfile, proxyPort?: number): ToolSession {
		return makeSession(mode, buildSandboxCaps(profile, testDir, proxyPort));
	}

	it("explore agent: read CWD allowed, write CWD denied, outside CWD denied", () => {
		const session = createSession("enforce", BUILTIN_PROFILES.explore);

		// Read within CWD should work
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read")).not.toThrow();
		// Write within CWD should fail (explore is read-only)
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).toThrow(ToolError);
		// Read outside CWD should fail (non-system path)
		expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
	});

	it("task agent: read+write CWD, read .bun and .cargo, deny sensitive paths", () => {
		const home = fsSync.realpathSync(os.homedir());
		const session = createSession("enforce", BUILTIN_PROFILES.task);

		// CWD should be readable and writable
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read")).not.toThrow();
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).not.toThrow();

		// .bun should be readable if it exists
		const bunDir = path.join(home, ".bun");
		if (fsSync.existsSync(bunDir)) {
			expect(() => enforceSandboxAccess(session, path.join(bunDir, "install/cache/pkg"), "read")).not.toThrow();
			// .bun should NOT be writable
			expect(() => enforceSandboxAccess(session, path.join(bunDir, "install/cache/pkg"), "write")).toThrow(
				ToolError,
			);
		}

		// Sensitive paths should be blocked
		expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
	});

	it("system paths are always readable regardless of profile", () => {
		const session = createSession("enforce", { fs: [], network: "blocked" });

		// /usr always exists and should be readable
		expect(() => enforceSandboxAccess(session, "/usr/bin/git", "read")).not.toThrow();
	});

	it("system paths are not writable (except /tmp)", () => {
		const session = createSession("enforce", { fs: [], network: "blocked" });

		expect(() => enforceSandboxAccess(session, "/usr/bin/malicious", "write")).toThrow(ToolError);
		// /tmp is the exception — always readwrite (query with canonicalized path)
		const realTmp = fsSync.realpathSync("/tmp");
		expect(() => enforceSandboxAccess(session, path.join(realTmp, "workfile.txt"), "write")).not.toThrow();
	});

	it("fallback profile (unknown agent): CWD readwrite, outside CWD denied", () => {
		const profile = resolveProfile("unknown-agent", {});
		const session = createSession("enforce", profile);

		// CWD should be fully accessible
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read")).not.toThrow();
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).not.toThrow();
		// Outside CWD (non-system) denied
		expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
	});

	it("user override profile restricts to custom paths only", () => {
		const customProfile: SandboxProfile = {
			fs: [{ path: testSubDir, mode: "read" }],
			network: "blocked",
		};
		const session = createSession("enforce", customProfile);

		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read")).not.toThrow();
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).toThrow(ToolError);
		// A path outside the custom profile (and outside system) is denied
		expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
	});

	it("designer agent can write to CWD but cannot read sensitive paths", () => {
		const session = createSession("enforce", BUILTIN_PROFILES.designer);

		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).not.toThrow();
		expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
	});

	it("empty profile with no filesystem entries still allows system paths", () => {
		const session = createSession("enforce", { fs: [], network: "allow-all" });

		// System path readable
		expect(() => enforceSandboxAccess(session, "/usr/bin/ls", "read")).not.toThrow();
		// Non-system denied
		expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression: network policy must be applied to the capability set itself.
//
// These assert on the built caps (via summary()), not on the profile object.
// The previous tests only checked profile shape, which is why an allowlist
// profile silently degrading to unrestricted egress went unnoticed.
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSandboxCaps() network enforcement", () => {
	function networkOf(caps: SandboxCaps): string {
		return caps.summary().split("Network:")[1].trim();
	}

	it("blocked profile blocks outbound network", () => {
		const caps = buildSandboxCaps({ fs: [], network: "blocked" }, testDir);
		expect(networkOf(caps)).toContain("blocked");
	});

	it("allow-all profile leaves network unrestricted", () => {
		const caps = buildSandboxCaps({ fs: [], network: "allow-all" }, testDir);
		expect(networkOf(caps)).toContain("allowed");
	});

	it("allowlist profile with a proxy port restricts to that proxy", () => {
		const caps = buildSandboxCaps({ fs: [], network: { allowedHosts: ["registry.npmjs.org"] } }, testDir, 18080);
		expect(networkOf(caps)).toContain("18080");
	});

	it("allowlist profile WITHOUT a proxy port fails closed (blocks), not open", () => {
		const caps = buildSandboxCaps({ fs: [], network: { allowedHosts: ["registry.npmjs.org"] } }, testDir);
		expect(networkOf(caps)).toContain("blocked");
		expect(networkOf(caps)).not.toContain("allowed");
	});

	it("every built-in allowlist profile is network-restricted without a proxy", () => {
		for (const [name, profile] of Object.entries(BUILTIN_PROFILES)) {
			if (typeof profile.network !== "object") continue;
			const caps = buildSandboxCaps(profile, testDir);
			expect(networkOf(caps), `profile ${name} must not allow unrestricted egress`).toContain("blocked");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression: symlinks must not be usable to escape the sandbox scope.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforceSandboxAccess() symlink escape", () => {
	it("denies reads through a symlink pointing outside the allowed scope", async () => {
		// Must live outside the system read paths (which include the OS temp dir),
		// so anchor it under the repo working directory instead.
		const outsideDir = fsSync.realpathSync(await fs.mkdtemp(path.join(process.cwd(), "sandbox-outside-")));
		try {
			const secret = path.join(outsideDir, "secret.txt");
			await fs.writeFile(secret, "secret");

			// Sandbox allows only testSubDir; the link lives inside it but resolves out.
			const caps = buildSandboxCaps({ fs: [{ path: testSubDir, mode: "read" }], network: "blocked" }, testDir);
			const session = makeSession("enforce", caps);

			const link = path.join(testSubDir, "escape-link");
			await fs.rm(link, { force: true });
			await fs.symlink(secret, link);

			// Direct access to the real path is denied ...
			expect(() => enforceSandboxAccess(session, secret, "read")).toThrow(ToolError);
			// ... and so is the lexically-in-scope symlink that resolves to it.
			expect(() => enforceSandboxAccess(session, link, "read")).toThrow(ToolError);

			await fs.rm(link, { force: true });
		} finally {
			await fs.rm(outsideDir, { recursive: true, force: true });
		}
	});

	it("still allows a not-yet-existing file inside the allowed scope", () => {
		const caps = buildSandboxCaps({ fs: [{ path: testSubDir, mode: "readwrite" }], network: "blocked" }, testDir);
		const session = makeSession("enforce", caps);

		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "brand-new-file.ts"), "write")).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression: in-process network tools must honour the sandbox network policy.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforceSandboxNetwork()", () => {
	function createSession(mode: SandboxMode, network?: SandboxProfile["network"]): ToolSession {
		return { ...makeSession(mode), sandboxNetwork: network } as unknown as ToolSession;
	}

	it("allows everything when the sandbox is off", () => {
		const session = createSession("off", "blocked");
		expect(() => enforceSandboxNetwork(session, "https://evil.example")).not.toThrow();
	});

	it("blocks all hosts under a blocked profile", () => {
		const session = createSession("enforce", "blocked");
		expect(() => enforceSandboxNetwork(session, "https://example.com")).toThrow(ToolError);
	});

	it("allows any host under allow-all", () => {
		const session = createSession("enforce", "allow-all");
		expect(() => enforceSandboxNetwork(session, "https://example.com")).not.toThrow();
	});

	it("permits exact allowlist matches and denies others", () => {
		const session = createSession("enforce", { allowedHosts: ["registry.npmjs.org"] });
		expect(() => enforceSandboxNetwork(session, "https://registry.npmjs.org/pkg")).not.toThrow();
		expect(() => enforceSandboxNetwork(session, "https://example.com")).toThrow(ToolError);
	});

	it("wildcard matches subdomains but not unrelated suffixes", () => {
		const session = createSession("enforce", { allowedHosts: ["*.crates.io"] });
		expect(() => enforceSandboxNetwork(session, "https://static.crates.io/x")).not.toThrow();
		// Suffix-confusion attempt must be denied.
		expect(() => enforceSandboxNetwork(session, "https://static.crates.io.attacker.com")).toThrow(ToolError);
	});

	it("requireUnrestricted denies under any restricted policy", () => {
		const allowlisted = createSession("enforce", { allowedHosts: ["registry.npmjs.org"] });
		expect(() =>
			enforceSandboxNetwork(allowlisted, "https://registry.npmjs.org", { requireUnrestricted: true }),
		).toThrow(ToolError);

		const open = createSession("enforce", "allow-all");
		expect(() => enforceSandboxNetwork(open, "anything", { requireUnrestricted: true })).not.toThrow();
	});

	it("warn mode logs instead of throwing", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const session = createSession("warn", "blocked");
		expect(() => enforceSandboxNetwork(session, "https://example.com")).not.toThrow();
		expect(warnSpy).toHaveBeenCalled();
		vi.restoreAllMocks();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Shell builtins / I/O redirections (kernel `pre_exec` does NOT cover these)
// ═══════════════════════════════════════════════════════════════════════════

describe("shell builtin + redirection enforcement", () => {
	// The kernel sandbox is applied via `pre_exec`, which only covers *spawned*
	// processes. Redirections and builtins are handled in-process by the shell,
	// so they are enforced in `Shell::open_file` instead. Without that check an
	// agent could read and write anywhere using only `>`, `<`, `read`, etc.
	// Grant only `testDir` so that anything outside it is unambiguously denied for
	// both reads and writes. `buildSandboxCaps` additionally grants system paths
	// (/tmp, /usr, /etc, ...), which would make "outside" hard to express.
	const caps = () => new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite).blockNetwork();

	async function runShell(command: string): Promise<string> {
		const shell = new Shell({ sessionEnv: {} });
		shell.setSandbox(caps());
		let out = "";
		await shell.run({ command, cwd: testDir, env: {}, timeoutMs: 20_000 }, (_e, chunk) => {
			out += chunk;
		});
		return out;
	}

	// A sibling of the granted directory: outside every capability.
	let outsidePath: string;
	beforeAll(() => {
		outsidePath = path.join(path.dirname(testDir), "omp-sandbox-regression-probe.txt");
		if (fsSync.existsSync(outsidePath)) fsSync.unlinkSync(outsidePath);
	});
	afterEach(() => {
		if (fsSync.existsSync(outsidePath)) fsSync.unlinkSync(outsidePath);
	});

	// All of these are shell builtins or redirections handled in-process, so the
	// kernel `pre_exec` sandbox never sees them.
	it.each([
		["truncating write `>`", (p: string) => `echo pwned > "${p}"`],
		["appending write `>>`", (p: string) => `echo pwned >> "${p}"`],
		["clobber `>|`", (p: string) => `echo pwned >| "${p}"`],
		["read redirect `<`", (p: string) => `read -r line < "${p}"; echo "$line"`],
		["read/write `<>`", (p: string) => `echo x 9<> "${p}"`],
		["`mapfile`", (p: string) => `mapfile -t arr < "${p}"; echo "\${arr[0]}"`],
		["command substitution `$(<file)`", (p: string) => `echo "$(<"${p}")"`],
		["`source`", (p: string) => `source "${p}"`],
	])("denies out-of-scope access via %s", async (_label, build) => {
		const out = await runShell(build(outsidePath));
		expect(out).toMatch(/is not permitted|failed to source/);
		expect(fsSync.existsSync(outsidePath)).toBe(false);
	});

	it("leaks no file content when a read redirection is denied", async () => {
		fsSync.writeFileSync(outsidePath, "TOP_SECRET_VALUE\n");
		const out = await runShell(`read -r line < "${outsidePath}"; echo "$line"`);
		expect(out).not.toContain("TOP_SECRET_VALUE");
		expect(out).toContain("is not permitted");
	});

	it("still permits redirections inside granted paths", async () => {
		const target = path.join(testDir, "builtin-allowed.txt");
		const out = await runShell(`echo hello > "${target}"; read -r line < "${target}"; echo "got:$line"`);
		expect(out).not.toContain("is not permitted");
		expect(out).toContain("got:hello");
	});

	it("permits reads of system paths granted by buildSandboxCaps", async () => {
		const shell = new Shell({ sessionEnv: {} });
		shell.setSandbox(buildSandboxCaps({ fs: [{ path: "$CWD", mode: "readwrite" }], network: "blocked" }, testDir));
		let out = "";
		await shell.run(
			{ command: `read -r line < /etc/hosts; echo ok`, cwd: testDir, env: {}, timeoutMs: 20_000 },
			(_e, c) => {
				out += c;
			},
		);
		expect(out).not.toContain("is not permitted");
		expect(out).toContain("ok");
	});

	it("honors union-of-grants: narrow readwrite nested under a broad read grant", async () => {
		// The kernel grants the union of all capabilities. A broad `/` read grant
		// must not shadow a nested readwrite grant.
		const shell = new Shell({ sessionEnv: {} });
		shell.setSandbox(
			buildSandboxCaps(
				{
					fs: [
						{ path: "/", mode: "read" },
						{ path: "$CWD", mode: "readwrite" },
					],
					network: "blocked",
				},
				testDir,
			),
		);
		const target = path.join(testDir, "union.txt");
		let out = "";
		await shell.run(
			{ command: `echo u > "${target}"; echo done`, cwd: testDir, env: {}, timeoutMs: 20_000 },
			(_e, c) => {
				out += c;
			},
		);
		expect(out).not.toContain("is not permitted");
		expect(out).toContain("done");
	});
});
