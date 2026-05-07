/**
 * Structured security event logger for NIST AU-2 (Audit Events),
 * AU-3 (Content of Audit Records), and AU-12.1 (Session Correlation) compliance.
 *
 * Writes append-only JSONL audit logs to ~/.omp/logs/audit.YYYY-MM-DD.log
 * with 0o600 permissions and a SHA-256 hash chain for tamper detection.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "./dirs";

// =============================================================================
// Types
// =============================================================================

export enum SecurityEventType {
	AUTH_SUCCESS = "AUTH_SUCCESS",
	AUTH_FAILURE = "AUTH_FAILURE",
	CREDENTIAL_ACCESS = "CREDENTIAL_ACCESS",
	CREDENTIAL_MODIFY = "CREDENTIAL_MODIFY",
	CONFIG_CHANGE = "CONFIG_CHANGE",
	TOOL_EXECUTION = "TOOL_EXECUTION",
	TOOL_BLOCKED = "TOOL_BLOCKED",
	PERMISSION_DENIED = "PERMISSION_DENIED",
	SESSION_START = "SESSION_START",
	SESSION_END = "SESSION_END",
	INTEGRITY_VIOLATION = "INTEGRITY_VIOLATION",
}

export type SecurityEventOutcome = "success" | "failure" | "blocked";

export interface SecurityEvent {
	/** UUIDv4 from crypto.randomUUID() */
	eventId: string;
	/** ISO 8601 UTC timestamp */
	timestamp: string;
	eventType: SecurityEventType;
	actor: string;
	resource: string;
	outcome: SecurityEventOutcome;
	metadata?: Record<string, unknown>;
	/** SHA-256 hex of the previous line (genesis seed for first entry) */
	prevHash?: string;
	/** AU-12.1: cross-session correlation ID */
	sessionId?: string;
}

// =============================================================================
// Internal helpers
// =============================================================================

function sha256(data: string): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

/** Stable genesis hash — matches CryptoParams.hashChain.genesisSeed */
const GENESIS_HASH = sha256("omp-audit-genesis-v1");
// =============================================================================
// Session ID state (AU-12.1 correlation)
// =============================================================================

let currentSessionId: string | undefined;

/**
 * Sets the module-level session ID appended to all subsequent audit events.
 * AU-12.1: enables cross-session correlation of audit records.
 */
export function setAuditSessionId(id: string): void {
	currentSessionId = id;
}

/** Returns the currently active session ID, if any. */
export function getAuditSessionId(): string | undefined {
	return currentSessionId;
}

/** Clears the module-level session ID. Use during session teardown or in tests. */
export function clearAuditSessionId(): void {
	currentSessionId = undefined;
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

// =============================================================================
// SecurityAuditLogger
// =============================================================================

export class SecurityAuditLogger {
	#logDir: string;
	#currentDate: string;
	#fd: number | null;
	#lastHash: string;

	constructor(opts?: { logDir?: string }) {
		this.#logDir = opts?.logDir ?? getLogsDir();
		this.#currentDate = todayIso();
		this.#fd = null;
		this.#lastHash = GENESIS_HASH;
	}

	#getAuditLogPath(date: string): string {
		return path.join(this.#logDir, `audit.${date}.log`);
	}

	/**
	 * Opens or rotates the log file.  File is opened with O_APPEND|O_CREAT,
	 * mode 0o600 so only the owning user can read audit records.
	 */
	#ensureOpen(): void {
		const today = todayIso();

		if (this.#fd !== null && today === this.#currentDate) {
			// Still on the same day — nothing to do.
			return;
		}

		// Rotate: close the old descriptor before opening the new one.
		if (this.#fd !== null) {
			try {
				fs.closeSync(this.#fd);
			} catch {
				// Best-effort; proceed to open the new file.
			}
			this.#fd = null;
			// Reset chain so the rotated file starts fresh from genesis.
			this.#lastHash = GENESIS_HASH;
		}

		this.#currentDate = today;
		const logPath = this.#getAuditLogPath(today);

		// Ensure the logs directory exists.
		if (!fs.existsSync(this.#logDir)) {
			fs.mkdirSync(this.#logDir, { recursive: true });
		}

		// O_APPEND | O_CREAT — safe for concurrent writers on POSIX.
		this.#fd = fs.openSync(logPath, "a", 0o600);
	}

	/**
	 * Emits a security event synchronously.  Returns the completed event
	 * including the assigned eventId, timestamp, and prevHash.
	 *
	 * Note: The `metadata.pid` field is always set to `process.pid` regardless of
	 * caller-supplied metadata (system-enforced). The `sessionId` field is always
	 * set from the module-level session ID when available (AU-12.1 correlation).
	 * These fields are intentionally non-overridable to preserve audit integrity.
	 */
	emit(event: Omit<SecurityEvent, "eventId" | "timestamp" | "prevHash">): SecurityEvent {
		this.#ensureOpen();

		const full: SecurityEvent = {
			...event,
			eventId: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			prevHash: this.#lastHash,
			...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
			metadata: {
				...event.metadata,
				pid: process.pid,
			},
		};

		const line = `${JSON.stringify(full)}\n`;
		const buf = Buffer.from(line, "utf8");

		// fd is guaranteed non-null after #ensureOpen succeeds; the non-null
		// assertion is safe here — any open failure would have thrown.
		fs.writeSync(this.#fd!, buf);

		this.#lastHash = sha256(line);
		return full;
	}

	/** Closes the underlying file descriptor. Safe to call multiple times. */
	close(): void {
		if (this.#fd !== null) {
			try {
				fs.closeSync(this.#fd);
			} catch {
				// Ignore — we're tearing down anyway.
			}
			this.#fd = null;
		}
	}

	/** Returns the SHA-256 hex of the last emitted line (or genesis hash). */
	getLastHash(): string {
		return this.#lastHash;
	}
}

// =============================================================================
// Singleton + convenience API
// =============================================================================

export const securityAudit = new SecurityAuditLogger();

export function emitSecurityEvent(
	eventType: SecurityEventType,
	resource: string,
	outcome: SecurityEventOutcome,
	metadata?: Record<string, unknown>,
	actor = "system",
): SecurityEvent {
	return securityAudit.emit({ eventType, actor, resource, outcome, metadata });
}
