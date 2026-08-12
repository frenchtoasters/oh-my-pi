/**
 * Process sandbox: OS-enforced isolation for spawned commands.
 *
 * Uses nono (Landlock on Linux, Seatbelt on macOS) to restrict filesystem
 * and network access for shell-spawned processes. Domain-level network filtering
 * is provided via nono-proxy CONNECT tunnel.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SandboxAccessMode, SandboxCaps, SandboxProxy, sandboxIsSupported } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveLocalRoot } from "../internal-urls/local-protocol";
import type { ToolSession } from "../tools/index";
import { ToolError } from "../tools/tool-errors";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type SandboxMode = "off" | "warn" | "enforce";

export interface SandboxProfileFs {
	path: string;
	mode: "read" | "readwrite";
}

export type SandboxNetworkMode = "blocked" | "allow-all" | { allowedHosts: string[] };

export interface SandboxProfile {
	fs: SandboxProfileFs[];
	network: SandboxNetworkMode;
}

// ═══════════════════════════════════════════════════════════════════════════
// Built-in Profiles
// ═══════════════════════════════════════════════════════════════════════════

export const BUILTIN_PROFILES: Record<string, SandboxProfile> = {
	explore: {
		fs: [{ path: "$CWD", mode: "read" }],
		network: "blocked",
	},
	reviewer: {
		fs: [{ path: "$CWD", mode: "read" }],
		network: "blocked",
	},
	"ultra-review-gemini": {
		fs: [{ path: "$CWD", mode: "read" }],
		network: "blocked",
	},
	"ultra-review-opus": {
		fs: [{ path: "$CWD", mode: "read" }],
		network: "blocked",
	},
	"ultra-review-sonnet": {
		fs: [{ path: "$CWD", mode: "read" }],
		network: "blocked",
	},
	librarian: {
		fs: [
			{ path: "$CWD", mode: "read" },
			{ path: "$HOME/.bun", mode: "read" },
		],
		network: {
			allowedHosts: ["registry.npmjs.org", "*.crates.io", "docs.rs", "*.pypi.org"],
		},
	},
	plan: {
		fs: [{ path: "$CWD", mode: "read" }],
		network: "blocked",
	},
	designer: {
		fs: [{ path: "$CWD", mode: "readwrite" }],
		network: "blocked",
	},
	task: {
		fs: [
			{ path: "$CWD", mode: "readwrite" },
			{ path: "$HOME/.bun", mode: "read" },
			{ path: "$HOME/.cargo", mode: "read" },
		],
		network: "blocked",
	},
	quick_task: {
		fs: [{ path: "$CWD", mode: "readwrite" }],
		network: "blocked",
	},
	init: {
		fs: [{ path: "$CWD", mode: "readwrite" }],
		network: {
			allowedHosts: ["registry.npmjs.org", "*.crates.io"],
		},
	},
};

// System paths always granted read access for executable resolution.
const SYSTEM_READ_PATHS = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/dev/null", "/dev/zero", "/dev/urandom"];

const SYSTEM_READWRITE_PATHS = ["/tmp"];

// macOS-specific paths needed for process execution.
const MACOS_SYSTEM_PATHS = [
	"/private/etc",
	"/private/tmp",
	"/private/var/folders",
	"/System",
	"/Library",
	"/opt/homebrew",
];

// ═══════════════════════════════════════════════════════════════════════════
// Profile Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve a sandbox profile for a given agent name.
 *
 * Resolution order:
 * 1. User override from settings
 * 2. Built-in profile
 * 3. Fallback (CWD read/write, network blocked)
 */
export function resolveProfile(agentName: string, profileOverrides: Record<string, SandboxProfile>): SandboxProfile {
	return (
		profileOverrides[agentName] ??
		BUILTIN_PROFILES[agentName] ?? {
			fs: [{ path: "$CWD", mode: "readwrite" as const }],
			network: "blocked" as const,
		}
	);
}

/**
 * Expand path variables ($CWD, $HOME, env vars). Unset variables are left as-is:
 * substituting "" would turn "$UNSET/foo" into "/foo", granting an unintended path.
 */
function expandPath(pathStr: string, cwd: string): string {
	return pathStr
		.replace(/\$CWD/g, cwd)
		.replace(/\$HOME/g, os.homedir())
		.replace(/\$(\w+)/g, (match, name) => process.env[name] ?? match);
}

// ═══════════════════════════════════════════════════════════════════════════
// Capability Building
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a SandboxCaps instance from a resolved profile.
 *
 * Adds system paths, profile-defined paths, and network mode.
 */
export function buildSandboxCaps(profile: SandboxProfile, cwd: string, proxyPort?: number): SandboxCaps {
	let caps = new SandboxCaps();

	// allowPath that tolerates paths missing on this platform. Profile paths pass
	// an `onError` since they are user-configured — a failure there is a
	// misconfiguration worth surfacing, not a platform difference.
	const tryAllow = (p: string, mode: SandboxAccessMode, onError?: (err: unknown) => void) => {
		try {
			caps = caps.allowPath(p, mode);
		} catch (err) {
			onError?.(err);
		}
	};

	// Add system read paths.
	for (const sysPath of SYSTEM_READ_PATHS) {
		tryAllow(sysPath, SandboxAccessMode.Read);
	}
	for (const sysPath of SYSTEM_READWRITE_PATHS) {
		tryAllow(sysPath, SandboxAccessMode.ReadWrite);
	}

	// macOS-specific system paths.
	if (process.platform === "darwin") {
		for (const sysPath of MACOS_SYSTEM_PATHS) {
			tryAllow(sysPath, SandboxAccessMode.Read);
		}
	}

	for (const entry of profile.fs) {
		const resolvedPath = expandPath(entry.path, cwd);
		const mode = entry.mode === "readwrite" ? SandboxAccessMode.ReadWrite : SandboxAccessMode.Read;
		tryAllow(resolvedPath, mode, err =>
			logger.warn("Sandbox: profile path could not be applied — it will not be accessible", {
				path: entry.path,
				resolvedPath,
				mode: entry.mode,
				err,
			}),
		);
	}

	// Apply network mode. Fails closed: an allowlist profile without a running
	// proxy blocks all egress rather than silently allowing it.
	if (profile.network === "blocked") {
		caps = caps.blockNetwork();
	} else if (typeof profile.network === "object") {
		if (proxyPort == null) {
			logger.warn("Sandbox: allowlist profile has no proxy port — blocking all network access", {
				allowedHosts: profile.network.allowedHosts,
			});
			caps = caps.blockNetwork();
		} else {
			// Proxy mode: only allow connecting to the proxy port on localhost.
			caps = caps.proxyOnly(proxyPort);
		}
	}
	// "allow-all" — no network restriction applied.

	return caps;
}

// ═══════════════════════════════════════════════════════════════════════════
// Proxy Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Active proxies keyed by their allowed-host set. Distinct host sets must get
 * distinct proxies — reusing one proxy across profiles would widen the
 * allowlist of the narrower profile to that of the first one started.
 */
const activeProxies = new Map<string, { proxy: SandboxProxy; port: number; envVars: Record<string, string> }>();

/**
 * Start the sandbox proxy for domain-level network filtering.
 *
 * Returns the proxy port and environment variables to inject into child processes.
 * Reuses an existing proxy only when it was started for the same host set.
 */
export function startSandboxProxy(allowedHosts: string[]): {
	port: number;
	envVars: Record<string, string>;
} {
	const key = allowedHosts.join("\u0000");
	const existing = activeProxies.get(key);
	if (existing) {
		return { port: existing.port, envVars: existing.envVars };
	}

	const proxy = new SandboxProxy();
	const result = proxy.start(allowedHosts);

	const envVars: Record<string, string> = {};
	for (const { key: envKey, value } of result.envVars) {
		envVars[envKey] = value;
	}
	activeProxies.set(key, { proxy, port: result.port, envVars });

	logger.debug("Sandbox proxy started", { port: result.port, hosts: allowedHosts });
	return { port: result.port, envVars };
}

/**
 * Shut down all active sandbox proxies.
 */
export function shutdownSandboxProxy(): void {
	for (const { proxy } of activeProxies.values()) {
		proxy.shutdown();
	}
	activeProxies.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// In-Process File Tool Enforcement
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enforce sandbox access for in-process file tool operations.
 *
 * Throws ToolError if the sandbox is enabled and the path is not covered
 * by the active profile. This provides advisory enforcement for file tools
 * (read, write, edit, find, search) running in the same process as the agent.
 *
 * Combined with kernel-enforced shell sandboxing (pre_exec), this covers:
 * - Shell commands: kernel-enforced (cannot bypass)
 * - File tools: query-enforced here (blocks tool execution)
 */
/**
 * Whether `absolutePath` falls inside omp's internal session storage root
 * (the `local://` / `artifact://` backing directory). Such paths are managed
 * by omp itself and must remain writable regardless of the sandbox profile.
 */
function isInternalStoragePath(session: ToolSession, absolutePath: string): boolean {
	let localRoot: string;
	try {
		localRoot = path.resolve(
			resolveLocalRoot({
				getArtifactsDir: session.getArtifactsDir,
				getSessionId: session.getSessionId,
			}),
		);
	} catch {
		return false;
	}
	const target = path.resolve(absolutePath);
	const rootWithSep = localRoot.endsWith(path.sep) ? localRoot : localRoot + path.sep;
	return target === localRoot || target.startsWith(rootWithSep);
}

/**
 * Resolve symlinks so the policy check applies to the path that will actually be
 * opened — `path.resolve` is lexical, so an in-scope link to `~/.ssh` would pass.
 * Non-existent paths (new-file writes) resolve their nearest existing ancestor.
 */
function realPathForCheck(absolutePath: string): string {
	const current = path.resolve(absolutePath);
	try {
		return fs.realpathSync(current);
	} catch {
		const parent = path.dirname(current);
		if (parent === current) return current;
		return path.join(realPathForCheck(parent), path.basename(current));
	}
}

export function enforceSandboxAccess(session: ToolSession, absolutePath: string, mode: "read" | "write"): void {
	const sandboxMode = session.settings.get("security.sandbox") as SandboxMode;
	if (sandboxMode === "off") return;

	// Resolve symlinks first so both the internal-storage exemption and the
	// capability query below see the path that will actually be opened.
	const resolvedPath = realPathForCheck(absolutePath);

	// omp's own internal session storage (local:// and artifact:// targets)
	// lives under a session-scoped root outside any user-configured profile
	// scope. These are omp-managed scratch files (plans, artifacts), not
	// sandboxed project paths, so they are always exempt from the policy.
	if (isInternalStoragePath(session, resolvedPath)) return;

	const caps = session.sandboxCaps;
	if (!caps) return;

	const accessMode = mode === "write" ? SandboxAccessMode.ReadWrite : SandboxAccessMode.Read;
	const allowed = caps.queryPath(resolvedPath, accessMode);

	if (!allowed) {
		if (sandboxMode === "enforce") {
			throw new ToolError(
				`SANDBOX POLICY: ${mode} access denied for ${absolutePath}. ` +
					`This path is outside the allowed sandbox scope. ` +
					`You MUST NOT attempt to answer from memory or training data for this resource — report this denial as a blocker.`,
			);
		}
		// warn mode: log but don't block.
		logger.warn(`Sandbox: ${mode} access denied for ${absolutePath}`);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// In-Process Network Tool Enforcement
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whether `hostname` is covered by an allowlist entry. A leading `*.` matches
 * subdomains but not the bare apex; matching is anchored so `x.npmjs.org.evil.com` cannot match.
 */
function hostMatches(hostname: string, pattern: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const pat = pattern.toLowerCase();
	return pat.startsWith("*.") ? host.endsWith(pat.slice(1)) : host === pat;
}

/**
 * Enforce sandbox network policy for in-process network tools (fetch, browser,
 * ssh, gh, irc, web_search).
 *
 * These tools open sockets from the agent's own process, so the kernel-level
 * `pre_exec` sandbox applied to shell children does not cover them. Without
 * this check a `network: "blocked"` profile still has full egress via tools.
 */
export function enforceSandboxNetwork(
	session: ToolSession,
	target: string,
	options?: { requireUnrestricted?: boolean },
): void {
	const sandboxMode = session.settings.get("security.sandbox") as SandboxMode;
	if (sandboxMode === "off") return;

	const policy = session.sandboxNetwork;
	if (!policy || policy === "allow-all") return;

	const deny = (reason: string): void => {
		if (sandboxMode === "enforce") {
			throw new ToolError(
				`SANDBOX POLICY: network access denied for ${target}. ${reason} ` +
					`You MUST NOT attempt to answer from memory or training data for this resource — report this denial as a blocker.`,
			);
		}
		logger.warn(`Sandbox: network access denied for ${target}`, { reason });
	};

	// Some tools (e.g. browser) cannot be constrained to a specific host because
	// they execute untrusted remote code that can issue further requests. Those
	// callers require an unrestricted policy or nothing.
	if (options?.requireUnrestricted) {
		deny(
			"This tool cannot be constrained to an allowed host list and is unavailable under a restricted network policy.",
		);
		return;
	}

	if (policy === "blocked") {
		deny("This profile blocks all network access.");
		return;
	}

	// Allowlist policy: resolve the host and test it against the patterns.
	let hostname: string;
	try {
		hostname = new URL(target).hostname;
	} catch {
		// Not a URL (e.g. an ssh host spec) — treat the raw value as the host.
		hostname = target;
	}

	if (!policy.allowedHosts.some(pattern => hostMatches(hostname, pattern))) {
		deny(`Host "${hostname}" is not in the allowed host list (${policy.allowedHosts.join(", ")}).`);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

export { SandboxAccessMode, SandboxCaps, sandboxIsSupported };
