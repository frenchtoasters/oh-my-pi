/**
 * Audit log storage capacity monitoring for NIST AU-4 (Audit Log Storage Capacity)
 * and AU-5 (Response to Audit Processing Failures) compliance.
 *
 * Monitors the audit log directory size and emits security events when thresholds
 * are exceeded. Returns false from ensureCapacity() at critical levels so callers
 * can implement a fail-safe by refusing operations (AU-5).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "./dirs";
import { emitSecurityEvent, SecurityEventType } from "./security-audit";

// =============================================================================
// Types
// =============================================================================

/** Configuration for AU-4 capacity thresholds. */
export interface AuditCapacityConfig {
	/** Maximum allowed bytes for the audit log directory. Default: 500 MB. */
	maxLogDirBytes: number;
	/** Percentage of maxLogDirBytes at which a warning is emitted. Default: 80. */
	warnThresholdPct: number;
	/** Percentage of maxLogDirBytes at which a critical alert is emitted. Default: 95. */
	criticalThresholdPct: number;
}

/** Result of a capacity check. */
export interface CapacityStatus {
	currentBytes: number;
	maxBytes: number;
	percentUsed: number;
	level: "normal" | "warning" | "critical";
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_CONFIG: AuditCapacityConfig = {
	maxLogDirBytes: 500 * 1024 * 1024, // 500 MB
	warnThresholdPct: 80,
	criticalThresholdPct: 95,
};

// =============================================================================
// AuditCapacityMonitor
// =============================================================================

/**
 * Monitors audit log directory size for NIST AU-4 / AU-5 compliance.
 *
 * AU-4: Allocate audit log storage capacity to reduce the likelihood of such
 *   capacity being exceeded.
 * AU-5: Alert in the event of an audit processing failure, and take action to
 *   preserve audit records.
 */
export class AuditCapacityMonitor {
	#config: AuditCapacityConfig;
	#logDir: string;

	constructor(config?: Partial<AuditCapacityConfig>, logDir?: string) {
		this.#config = { ...DEFAULT_CONFIG, ...config };
		this.#logDir = logDir ?? getLogsDir();
	}

	/**
	 * Sums the size of all files in the log directory (non-recursive, sync).
	 * Returns 0 if the directory does not exist.
	 */
	#dirBytes(): number {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.#logDir, { withFileTypes: true });
		} catch {
			return 0;
		}

		let total = 0;
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			try {
				const stat = fs.statSync(path.join(this.#logDir, entry.name));
				total += stat.size;
			} catch {
				// skip unreadable entries
			}
		}
		return total;
	}

	/**
	 * Reads the current log directory size and computes the capacity level.
	 * Emits a security event when the level is warning or critical.
	 *
	 * @nist AU-4, AU-5
	 */
	checkCapacity(): CapacityStatus {
		const currentBytes = this.#dirBytes();
		const maxBytes = this.#config.maxLogDirBytes;
		const percentUsed = maxBytes > 0 ? (currentBytes / maxBytes) * 100 : 0;

		let level: CapacityStatus["level"] = "normal";
		if (percentUsed >= this.#config.criticalThresholdPct) {
			level = "critical";
		} else if (percentUsed >= this.#config.warnThresholdPct) {
			level = "warning";
		}

		if (level === "warning" || level === "critical") {
			emitSecurityEvent(
				SecurityEventType.INTEGRITY_VIOLATION,
				this.#logDir,
				level === "critical" ? "failure" : "success",
				{
					reason: level === "critical" ? "audit_capacity_critical" : "audit_capacity_warning",
					currentBytes,
					maxBytes,
					percentUsed: Math.round(percentUsed * 100) / 100,
					level,
				},
			);
		}

		return { currentBytes, maxBytes, percentUsed, level };
	}

	/**
	 * Returns true when audit operations can proceed, false when critical
	 * capacity is reached (AU-5 fail-safe: callers should refuse further
	 * operations until capacity is reclaimed).
	 *
	 * @nist AU-5
	 */
	ensureCapacity(): boolean {
		const status = this.checkCapacity();
		return status.level !== "critical";
	}
}
