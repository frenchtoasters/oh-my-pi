import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxAccessMode, SandboxCaps, SandboxProxy, sandboxIsSupported } from "@oh-my-pi/pi-natives";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	BUILTIN_PROFILES,
	type SandboxMode,
	type SandboxProfile,
	buildSandboxCaps,
	enforceSandboxAccess,
	resolveProfile,
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
		const caps = new SandboxCaps()
			.allowPath(testDir, SandboxAccessMode.ReadWrite)
			.blockNetwork();
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

	it("returns fallback profile for unknown agent names with no override", () => {
		const profile = resolveProfile("unknown-agent-xyz", {});
		expect(profile.fs).toEqual([{ path: "$CWD", mode: "readwrite" }]);
		expect(profile.network).toBe("allow-all");
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
		for (const name of ["explore", "reviewer", "ultra-review-gemini", "ultra-review-opus", "ultra-review-sonnet", "plan"]) {
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

	function createSession(mode: SandboxMode, caps?: SandboxCaps): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "security.sandbox": mode }),
			sandboxCaps: caps,
		} as unknown as ToolSession;
	}

	describe("mode = off", () => {
		it("allows all access regardless of caps — sandbox disabled", () => {
			const caps = new SandboxCaps(); // denies everything
			const session = createSession("off", caps);
			expect(() => enforceSandboxAccess(session, "/etc/passwd", "read")).not.toThrow();
			expect(() => enforceSandboxAccess(session, "/etc/shadow", "write")).not.toThrow();
		});

		it("allows access when caps is undefined", () => {
			const session = createSession("off", undefined);
			expect(() => enforceSandboxAccess(session, "/any/path", "read")).not.toThrow();
		});
	});

	describe("mode = warn", () => {
		it("logs warning but does not throw for denied paths", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = createSession("warn", caps);

			// Path outside testDir (use canonical form)
			expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).not.toThrow();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Sandbox: read access denied"),
			);
		});

		it("does not warn for allowed paths", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = createSession("warn", caps);

			// Use canonical path under testDir
			enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read");
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("does not warn or throw when caps is undefined", () => {
			const session = createSession("warn", undefined);
			expect(() => enforceSandboxAccess(session, "/etc/passwd", "read")).not.toThrow();
			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe("mode = enforce", () => {
		it("throws ToolError when read access is denied", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = createSession("enforce", caps);

			expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);
		});

		it("throws ToolError when write access is denied (read-only path)", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.Read);
			const session = createSession("enforce", caps);

			// testDir is read-only, so write should be denied
			expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).toThrow(ToolError);
		});

		it("error message includes the denied path and access mode", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = createSession("enforce", caps);

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
			const session = createSession("enforce", caps);

			try {
				enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect((e as ToolError).message).toContain("write access denied");
			}
		});

		it("allows access to paths covered by the capability set", () => {
			const caps = new SandboxCaps().allowPath(testDir, SandboxAccessMode.ReadWrite);
			const session = createSession("enforce", caps);

			expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read")).not.toThrow();
			expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "write")).not.toThrow();
		});

		it("does not throw when caps is undefined (sandbox not initialized)", () => {
			const session = createSession("enforce", undefined);
			expect(() => enforceSandboxAccess(session, "/etc/passwd", "read")).not.toThrow();
		});

		it("write mode checks ReadWrite access (not just Write)", () => {
			// Read-only path should deny writes; readwrite path should allow writes
			const realTmp = fsSync.realpathSync("/tmp");
			const caps = new SandboxCaps()
				.allowPath(testDir, SandboxAccessMode.Read)
				.allowPath(realTmp, SandboxAccessMode.ReadWrite);
			const session = createSession("enforce", caps);

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
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: buildSandboxCaps + enforceSandboxAccess end-to-end
// ═══════════════════════════════════════════════════════════════════════════

describe("integration: buildSandboxCaps -> enforceSandboxAccess", () => {
	function createSession(mode: SandboxMode, profile: SandboxProfile, proxyPort?: number): ToolSession {
		const caps = buildSandboxCaps(profile, testDir, proxyPort);
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "security.sandbox": mode }),
			sandboxCaps: caps,
		} as unknown as ToolSession;
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
			expect(() => enforceSandboxAccess(session, path.join(bunDir, "install/cache/pkg"), "write")).toThrow(ToolError);
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
