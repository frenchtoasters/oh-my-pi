/**
 * Hash-chain verification for NIST AU-9 (Protection of Audit Information)
 * and AU-10 (Non-repudiation) compliance.
 *
 * Reads audit log files produced by SecurityAuditLogger and verifies
 * that the SHA-256 hash chain is intact — detecting any tampering,
 * deletion, or insertion of log entries.
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
export async function verifyAuditLog(date?: string): Promise<AuditVerificationResult> {
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

	// Split on newlines; filter trailing empty line from final \n.
	const lines = contents.split("\n").filter(l => l.length > 0);

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
