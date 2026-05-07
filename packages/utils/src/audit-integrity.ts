/**
 * Hash-chain verification for NIST AU-9 (Protection of Audit Information),
 * AU-9.3 (HMAC verification), and AU-10 (Non-repudiation) compliance.
 *
 * Reads audit log files produced by SecurityAuditLogger and verifies
 * that the SHA-256 hash chain is intact — detecting any tampering,
 * deletion, or insertion of log entries.  Optionally verifies per-line
 * HMAC-SHA256 signatures stored in metadata.hmac (AU-9.3).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogsDir } from "./dirs";
import type { SecurityEvent } from "./security-audit";

// =============================================================================
// Types
// =============================================================================

export interface AuditVerificationResult {
	valid: boolean;
	entriesChecked: number;
	/** 0-based index of the first invalid entry, if any. */
	firstInvalidEntry?: number;
	error?: string;
}

/** AU-9.3: Extends AuditVerificationResult with optional HMAC validity flag. */
export interface HmacVerificationResult extends AuditVerificationResult {
	/** True when all lines passed HMAC verification; false if any failed; undefined if no key was supplied. */
	hmacValid?: boolean;
}

// =============================================================================
// Internal helpers
// =============================================================================

function sha256(data: string): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

/** Matches SecurityAuditLogger's genesis seed. */
const GENESIS_HASH = sha256("omp-audit-genesis-v1");

function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function auditLogPath(logDir: string, date: string): string {
	return path.join(logDir, `audit.${date}.log`);
}

function stableStringify(obj: unknown): string {
	if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
	const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// =============================================================================
// Exported functions
// =============================================================================

/**
 * Verifies the SHA-256 hash chain of an audit log file.
 *
 * Each entry's `prevHash` must equal the SHA-256 of the previous JSONL line
 * (including its newline).  The first entry's `prevHash` must equal the hash
 * of the genesis seed `"omp-audit-genesis-v1"`.
 *
 * @param date - Date string in YYYY-MM-DD format; defaults to today.
 */
export async function verifyAuditLog(date?: string, contents?: string): Promise<AuditVerificationResult> {
	const targetDate = date ?? todayDate();
	let fileContents: string;
	if (contents !== undefined) {
		fileContents = contents;
	} else {
		const logPath = auditLogPath(getLogsDir(), targetDate);
		try {
			fileContents = await fs.readFile(logPath, "utf8");
		} catch (err) {
			return {
				valid: false,
				entriesChecked: 0,
				error: `Cannot read audit log for ${targetDate}: ${String(err)}`,
			};
		}
	}

	// Split on newlines; filter trailing empty line from final \n.
	const lines = fileContents.split("\n").filter(l => l.length > 0);

	if (lines.length === 0) {
		// Empty file is trivially valid.
		return { valid: true, entriesChecked: 0 };
	}

	let expectedPrevHash = GENESIS_HASH;

	for (let i = 0; i < lines.length; i++) {
		let event: SecurityEvent;
		try {
			event = JSON.parse(lines[i]) as SecurityEvent;
		} catch {
			return {
				valid: false,
				entriesChecked: i,
				firstInvalidEntry: i,
				error: `Line ${i} is not valid JSON`,
			};
		}

		if (event.prevHash !== expectedPrevHash) {
			return {
				valid: false,
				entriesChecked: i,
				firstInvalidEntry: i,
				error: `Hash chain broken at entry ${i}: expected prevHash ${expectedPrevHash}, got ${event.prevHash}`,
			};
		}

		// Advance: next entry's prevHash must equal sha256 of this line + "\n".
		expectedPrevHash = sha256(`${lines[i]}\n`);
	}

	return { valid: true, entriesChecked: lines.length };
}

/**
 * Lists available audit log dates from the logs directory.
 * Returns dates sorted chronologically (oldest first).
 */
export async function listAuditLogs(): Promise<string[]> {
	const logsDir = getLogsDir();

	let entries: string[];
	try {
		entries = await fs.readdir(logsDir);
	} catch {
		return [];
	}

	const dates: string[] = [];
	const pattern = /^audit\.(\d{4}-\d{2}-\d{2})\.log$/;

	for (const entry of entries) {
		const m = pattern.exec(entry);
		if (m) {
			dates.push(m[1]);
		}
	}

	dates.sort();
	return dates;
}

// =============================================================================
// AU-9.3 HMAC helpers
// =============================================================================

/**
 * Computes an HMAC-SHA256 over a single audit JSONL line using the given key.
 *
 * @param line - The raw JSONL line (without trailing newline).
 * @param key  - Secret key material.
 * @returns Hex-encoded HMAC digest.
 * @experimental The SecurityAuditLogger does not yet compute HMACs during emit().
 * This function is intended for use with external HMAC-aware log writers or a future
 * built-in signing implementation.
 */
export function computeAuditHmac(line: string, key: Buffer): string {
	return crypto.createHmac("sha256", key).update(line).digest("hex");
}

/**
 * Verifies the SHA-256 hash chain of an audit log file and, when a key is
 * supplied, also validates per-line HMAC-SHA256 signatures stored in each
 * entry's `metadata.hmac` field (AU-9.3).
 *
 * Hash-chain semantics are identical to {@link verifyAuditLog}.  HMAC
 * verification is layered on top: each line's stored `metadata.hmac` must
 * match `computeAuditHmac(line, hmacKey)`.  A missing `metadata.hmac` on
 * any line when a key is provided is treated as a verification failure.
 *
 * @param date    - Date string YYYY-MM-DD; defaults to today.
 * @param hmacKey - Optional secret key.  When omitted, `hmacValid` is
 *                  undefined in the result and no HMAC check is performed.
 * @experimental The SecurityAuditLogger does not yet compute HMACs during emit().
 * This function is intended for use with external HMAC-aware log writers or a future
 * built-in signing implementation. Verifying logs produced by the current logger will
 * always fail with "missing metadata.hmac field".
 */
export async function verifyAuditLogWithHmac(date?: string, hmacKey?: Buffer): Promise<HmacVerificationResult> {
	const targetDate = date ?? todayDate();
	const logPath = auditLogPath(getLogsDir(), targetDate);

	let contents: string;
	try {
		contents = await fs.readFile(logPath, "utf8");
	} catch (err) {
		return {
			valid: false,
			entriesChecked: 0,
			error: `Cannot read audit log for ${targetDate}: ${String(err)}`,
		};
	}

	const base = await verifyAuditLog(date, contents);

	if (!base.valid || hmacKey === undefined) {
		return base;
	}

	const lines = contents.split("\n").filter(l => l.length > 0);

	for (let i = 0; i < lines.length; i++) {
		let event: { metadata?: Record<string, unknown> };
		try {
			event = JSON.parse(lines[i]) as { metadata?: Record<string, unknown> };
		} catch {
			return {
				valid: false,
				entriesChecked: i,
				firstInvalidEntry: i,
				hmacValid: false,
				error: `Line ${i} is not valid JSON during HMAC verification`,
			};
		}

		const storedHmac = event.metadata?.hmac;
		if (typeof storedHmac !== "string") {
			return {
				valid: false,
				entriesChecked: i,
				firstInvalidEntry: i,
				hmacValid: false,
				error: `Line ${i} missing metadata.hmac field`,
			};
		}

		// Strip metadata.hmac before computing the canonical line so the HMAC
		// covers the event without the signature field (avoids circularity).
		delete event.metadata!.hmac;
		const canonicalLine = stableStringify(event);
		const expected = computeAuditHmac(canonicalLine, hmacKey);
		const storedBuf = Buffer.from(storedHmac, "hex");
		const expectedBuf = Buffer.from(expected, "hex");
		if (storedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(storedBuf, expectedBuf)) {
			return {
				valid: false,
				entriesChecked: i,
				firstInvalidEntry: i,
				hmacValid: false,
				error: `HMAC mismatch at entry ${i}`,
			};
		}
	}

	return { ...base, hmacValid: true };
}
