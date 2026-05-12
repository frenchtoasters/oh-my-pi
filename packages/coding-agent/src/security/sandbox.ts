/**
 * Process sandbox: OS-enforced isolation for spawned commands.
 *
 * Uses nono (Landlock on Linux, Seatbelt on macOS) to restrict filesystem
 * and network access for shell-spawned processes. Domain-level network filtering
 * is provided via nono-proxy CONNECT tunnel.
 */

import * as os from "node:os";

import { SandboxAccessMode, SandboxCaps, SandboxProxy, sandboxIsSupported } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

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
 * 3. Fallback (CWD read/write, network allowed)
 */
export function resolveProfile(agentName: string, profileOverrides: Record<string, SandboxProfile>): SandboxProfile {
	return (
		profileOverrides[agentName] ??
		BUILTIN_PROFILES[agentName] ?? {
			fs: [{ path: "$CWD", mode: "readwrite" as const }],
			network: "allow-all" as const,
		}
	);
}

/**
 * Expand path variables ($CWD, $HOME, env vars).
 */
function expandPath(pathStr: string, cwd: string): string {
	return pathStr
		.replace(/\$CWD/g, cwd)
		.replace(/\$HOME/g, os.homedir())
		.replace(/\$(\w+)/g, (_, name) => process.env[name] ?? "");
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

	// Helper: allowPath that skips non-existent paths (system dirs vary per OS).
	const tryAllow = (p: string, mode: SandboxAccessMode) => {
		try {
			caps = caps.allowPath(p, mode);
		} catch {
			// Path does not exist on this platform — skip silently.
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

	// Add profile-defined paths (these should exist — propagate errors).
	for (const entry of profile.fs) {
		const resolvedPath = expandPath(entry.path, cwd);
		const mode = entry.mode === "readwrite" ? SandboxAccessMode.ReadWrite : SandboxAccessMode.Read;
		tryAllow(resolvedPath, mode);
	}

	// Apply network mode.
	if (profile.network === "blocked") {
		caps = caps.blockNetwork();
	} else if (typeof profile.network === "object" && proxyPort != null) {
		// Proxy mode: only allow connecting to the proxy port on localhost.
		caps = caps.proxyOnly(proxyPort);
	}
	// "allow-all" — no network restriction applied.

	return caps;
}

// ═══════════════════════════════════════════════════════════════════════════
// Proxy Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

let activeProxy: SandboxProxy | null = null;
let activeProxyPort: number | null = null;
let activeProxyEnv: Record<string, string> | null = null;

/**
 * Start the sandbox proxy for domain-level network filtering.
 *
 * Returns the proxy port and environment variables to inject into child processes.
 * Reuses existing proxy if already started.
 */
export function startSandboxProxy(allowedHosts: string[]): {
	port: number;
	envVars: Record<string, string>;
} {
	if (activeProxy && activeProxyPort != null && activeProxyEnv != null) {
		return { port: activeProxyPort, envVars: activeProxyEnv };
	}

	const proxy = new SandboxProxy();
	const result = proxy.start(allowedHosts);

	activeProxy = proxy;
	activeProxyPort = result.port;
	activeProxyEnv = {};
	for (const { key, value } of result.envVars) {
		activeProxyEnv[key] = value;
	}

	logger.debug("Sandbox proxy started", { port: result.port, hosts: allowedHosts });
	return { port: activeProxyPort, envVars: activeProxyEnv };
}

/**
 * Shut down the active sandbox proxy.
 */
export function shutdownSandboxProxy(): void {
	if (activeProxy) {
		activeProxy.shutdown();
		activeProxy = null;
		activeProxyPort = null;
		activeProxyEnv = null;
		logger.debug("Sandbox proxy shut down");
	}
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
export function enforceSandboxAccess(session: ToolSession, absolutePath: string, mode: "read" | "write"): void {
	const sandboxMode = session.settings.get("security.sandbox") as SandboxMode;
	if (sandboxMode === "off") return;

	const caps = session.sandboxCaps;
	if (!caps) return;

	const accessMode = mode === "write" ? SandboxAccessMode.ReadWrite : SandboxAccessMode.Read;
	const allowed = caps.queryPath(absolutePath, accessMode);

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
// Exports
// ═══════════════════════════════════════════════════════════════════════════

export { SandboxAccessMode, SandboxCaps, sandboxIsSupported };
