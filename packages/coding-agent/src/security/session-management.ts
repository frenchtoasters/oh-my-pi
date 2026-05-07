/**
 * Concurrent session control via PID file tracking for NIST AC-10 compliance.
 * Limits the number of concurrent sessions per user by tracking the active
 * process with a PID file under the OMP config root.
 *
 * @nist AC-10 Concurrent Session Control
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { emitSecurityEvent, getConfigRootDir, SecurityEventType } from "@oh-my-pi/pi-utils";

export interface SessionInfo {
	pid: number;
	startedAt: string;
	cwd: string;
}

export interface ConcurrentSessionCheck {
	allowed: boolean;
	existingSession?: SessionInfo;
}

export class SessionManager {
	#pidFilePath: string;

	constructor(pidFilePath?: string) {
		this.#pidFilePath = pidFilePath ?? path.join(getConfigRootDir(), "agent.pid");
	}

	/**
	 * Check if another instance is running.
	 * If a stale PID file is found (process no longer alive), it is removed and
	 * the session is allowed. If a live process is found, emits a blocked
	 * SESSION_START event and returns `{ allowed: false }`.
	 */
	checkConcurrentSession(): ConcurrentSessionCheck {
		let raw: string;
		try {
			raw = fs.readFileSync(this.#pidFilePath, "utf8");
		} catch {
			// No PID file — no concurrent session.
			return { allowed: true };
		}

		let session: SessionInfo;
		try {
			session = JSON.parse(raw) as SessionInfo;
		} catch {
			// Corrupt PID file — remove it and allow.
			this.#removePidFile();
			return { allowed: true };
		}

		const alive = this.#isProcessAlive(session.pid);
		if (!alive) {
			// Stale PID file — clean up and allow.
			this.#removePidFile();
			return { allowed: true };
		}

		emitSecurityEvent(SecurityEventType.SESSION_START, this.#pidFilePath, "blocked", {
			existingPid: session.pid,
			existingCwd: session.cwd,
			existingStartedAt: session.startedAt,
		});

		return { allowed: false, existingSession: session };
	}

	/**
	 * Register this session by writing a PID file with the current process ID,
	 * start time, and working directory.
	 *
	 * Note: The check+register sequence is not atomic. A TOCTOU race exists where
	 * another process may register between checkConcurrentSession() and register().
	 * This is acceptable for a single-user CLI tool — last writer wins. For stricter
	 * AC-10 enforcement, advisory file locking (flock) would be needed.
	 */
	register(): void {
		const info: SessionInfo = {
			pid: process.pid,
			startedAt: new Date().toISOString(),
			cwd: process.cwd(),
		};

		const dir = path.dirname(this.#pidFilePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		try {
			fs.writeFileSync(this.#pidFilePath, JSON.stringify(info), { flag: "wx", mode: 0o600 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				// Race: another process registered between our check and register.
				// Overwrite is acceptable for a single-user CLI — the last writer wins.
				fs.writeFileSync(this.#pidFilePath, JSON.stringify(info), { mode: 0o600 });
			} else {
				throw err;
			}
		}
	}

	/**
	 * Unregister this session by removing the PID file.
	 * Best-effort: errors are silently ignored.
	 */
	unregister(): void {
		this.#removePidFile();
	}

	#isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	#removePidFile(): void {
		try {
			fs.unlinkSync(this.#pidFilePath);
		} catch {
			// Best-effort.
		}
	}
}
