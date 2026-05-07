import * as path from "node:path";
import { emitSecurityEvent, SecurityEventType } from "@oh-my-pi/pi-utils";

export type ExecutionPolicyMode = "permissive" | "strict";

export interface ExecutionPolicyConfig {
	mode: ExecutionPolicyMode;
	/** Additional commands to deny in strict mode */
	denyCommands?: string[];
	/** Additional commands to allow in strict mode */
	allowCommands?: string[];
	/** Maximum output size in bytes (0 = unlimited) */
	maxOutputBytes?: number;
	/** Restrict filesystem access to CWD only in strict mode */
	cwdOnly?: boolean;
}

export interface PolicyCheckResult {
	allowed: boolean;
	reason?: string;
}

export class ExecutionPolicy {
	#config: ExecutionPolicyConfig;
	#cwd: string;

	static readonly STRICT_DENY_COMMANDS = [
		"curl",
		"wget",
		"nc",
		"ncat",
		"netcat",
		"ssh",
		"scp",
		"sftp",
		"rsync",
		"docker",
		"podman",
		"sudo",
		"su",
		"doas",
		"rm -rf /",
		"mkfs",
		"dd",
		"shutdown",
		"reboot",
		"halt",
		"iptables",
		"ip6tables",
		"nft",
	] as const;

	static readonly STRICT_ALLOW_COMMANDS = [
		"ls",
		"cat",
		"head",
		"tail",
		"grep",
		"find",
		"wc",
		"echo",
		"printf",
		"test",
		"git",
		"bun",
		"node",
		"npm",
		"npx",
		"cargo",
		"rustc",
		"rustup",
		"python",
		"python3",
		"pip",
		"mkdir",
		"cp",
		"mv",
		"rm",
		"touch",
		"sed",
		"awk",
		"sort",
		"uniq",
		"tr",
		"cut",
		"diff",
		"patch",
		"which",
		"env",
		"printenv",
	] as const;

	constructor(config: ExecutionPolicyConfig, cwd: string) {
		this.#config = config;
		this.#cwd = cwd;
	}

	checkCommand(command: string): PolicyCheckResult {
		if (this.#config.mode === "permissive") {
			emitSecurityEvent(SecurityEventType.TOOL_EXECUTION, command, "success", { mode: "permissive" });
			return { allowed: true };
		}

		// Detect shell injection metacharacters before allow/deny checks
		const SHELL_INJECTION_RE = /[;|&`$(){}[\]<>]/;
		if (SHELL_INJECTION_RE.test(command)) {
			const reason = "Command contains shell injection metacharacters";
			emitSecurityEvent(SecurityEventType.TOOL_BLOCKED, command, "blocked", { mode: "strict", reason });
			return { allowed: false, reason };
		}

		// strict mode: extract the first token as the executable
		const executable = command.trimStart().split(/\s+/)[0] ?? "";

		// Build deny set: static defaults + config overrides
		const denySet = new Set<string>([...ExecutionPolicy.STRICT_DENY_COMMANDS, ...(this.#config.denyCommands ?? [])]);

		if (denySet.has(executable)) {
			const reason = `Command '${executable}' is explicitly denied in strict mode`;
			emitSecurityEvent(SecurityEventType.TOOL_BLOCKED, command, "blocked", { mode: "strict", executable, reason });
			return { allowed: false, reason };
		}

		// Build allow set: static defaults + config overrides
		const allowSet = new Set<string>([
			...ExecutionPolicy.STRICT_ALLOW_COMMANDS,
			...(this.#config.allowCommands ?? []),
		]);

		if (!allowSet.has(executable)) {
			const reason = "Command not in strict mode allowlist";
			emitSecurityEvent(SecurityEventType.TOOL_BLOCKED, command, "blocked", { mode: "strict", executable, reason });
			return { allowed: false, reason };
		}

		emitSecurityEvent(SecurityEventType.TOOL_EXECUTION, command, "success", { mode: "strict", executable });
		return { allowed: true };
	}

	checkFilePath(filePath: string): PolicyCheckResult {
		if (this.#config.mode === "permissive") {
			return { allowed: true };
		}

		if (!this.#config.cwdOnly) {
			return { allowed: true };
		}

		// Reject paths containing null bytes (obfuscation attempt)
		if (filePath.includes("\x00")) {
			const reason = "Path contains null bytes";
			emitSecurityEvent(SecurityEventType.PERMISSION_DENIED, filePath, "blocked", {
				mode: "strict",
				reason,
			});
			return { allowed: false, reason };
		}

		// URL-decode before resolving to prevent %2e%2e%2f traversal
		let decoded: string;
		try {
			decoded = decodeURIComponent(filePath);
		} catch {
			decoded = filePath;
		}

		const resolved = path.resolve(decoded);
		// Ensure the resolved path is under #cwd (with trailing sep to avoid prefix collisions)
		const cwdWithSep = this.#cwd.endsWith(path.sep) ? this.#cwd : this.#cwd + path.sep;

		if (resolved !== this.#cwd && !resolved.startsWith(cwdWithSep)) {
			const reason = `Path '${resolved}' is outside the working directory '${this.#cwd}'`;
			emitSecurityEvent(SecurityEventType.PERMISSION_DENIED, filePath, "blocked", {
				mode: "strict",
				resolved,
				cwd: this.#cwd,
				reason,
			});
			return { allowed: false, reason };
		}

		return { allowed: true };
	}

	static fromSettings(mode: ExecutionPolicyMode, cwd: string): ExecutionPolicy {
		return new ExecutionPolicy({ mode }, cwd);
	}
}
