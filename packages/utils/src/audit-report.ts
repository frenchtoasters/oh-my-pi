/**
 * Audit reduction and report generation for NIST AU-7 compliance.
 *
 * AU-7: The system provides an audit reduction and report generation capability
 * that supports on-demand analysis and after-the-fact investigations of security
 * incidents without altering original audit records.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listAuditLogs } from "./audit-integrity";
import { getLogsDir } from "./dirs";
import type { SecurityEvent, SecurityEventOutcome, SecurityEventType } from "./security-audit";

// =============================================================================
// Types
// =============================================================================

/** Filter criteria for audit report generation. @nist AU-7 */
export interface AuditReportFilter {
	/** Inclusive start date in YYYY-MM-DD format. */
	startDate?: string;
	/** Inclusive end date in YYYY-MM-DD format. */
	endDate?: string;
	/** Restrict to specific event types. */
	eventTypes?: SecurityEventType[];
	/** Filter by actor (exact match). */
	actor?: string;
	/** Filter by outcome. */
	outcome?: SecurityEventOutcome;
	/** Filter by resource substring (case-sensitive). */
	resource?: string;
}

/** Result of a report generation request. @nist AU-7 */
export interface AuditReport {
	generatedAt: string;
	filter: AuditReportFilter;
	totalRecords: number;
	records: SecurityEvent[];
}

// =============================================================================
// Internal helpers
// =============================================================================

function auditLogPath(logDir: string, date: string): string {
	return path.join(logDir, `audit.${date}.log`);
}

function dateInRange(date: string, start?: string, end?: string): boolean {
	if (start !== undefined && date < start) return false;
	if (end !== undefined && date > end) return false;
	return true;
}

function matchesFilter(event: SecurityEvent, filter: AuditReportFilter): boolean {
	if (filter.eventTypes !== undefined && !filter.eventTypes.includes(event.eventType)) {
		return false;
	}
	if (filter.actor !== undefined && event.actor !== filter.actor) {
		return false;
	}
	if (filter.outcome !== undefined && event.outcome !== filter.outcome) {
		return false;
	}
	if (filter.resource !== undefined && !event.resource.includes(filter.resource)) {
		return false;
	}
	// Date-range check on the event's ISO timestamp (YYYY-MM-DD prefix).
	const eventDate = event.timestamp.slice(0, 10);
	if (!dateInRange(eventDate, filter.startDate, filter.endDate)) {
		return false;
	}
	return true;
}

async function readLogRecords(logDir: string, date: string): Promise<SecurityEvent[]> {
	let contents: string;
	try {
		contents = await fs.readFile(auditLogPath(logDir, date), "utf8");
	} catch {
		return [];
	}

	const records: SecurityEvent[] = [];
	for (const line of contents.split("\n")) {
		if (line.length === 0) continue;
		try {
			records.push(JSON.parse(line) as SecurityEvent);
		} catch {
			// skip malformed lines — report should not fail on corrupt entries
		}
	}
	return records;
}

// =============================================================================
// Exported functions
// =============================================================================

/**
 * Generates an audit report by reading log files for the requested date range,
 * applying the given filters, and returning matching records.
 *
 * Does not modify the underlying log files (AU-7 requirement).
 *
 * @nist AU-7
 */
export async function generateAuditReport(filter: AuditReportFilter): Promise<AuditReport> {
	const logDir = getLogsDir();
	const availableDates = await listAuditLogs();

	// Narrow to dates within the requested range.
	const targetDates = availableDates.filter(d => dateInRange(d, filter.startDate, filter.endDate));

	const records: SecurityEvent[] = [];
	for (const date of targetDates) {
		const dateRecords = await readLogRecords(logDir, date);
		for (const record of dateRecords) {
			if (matchesFilter(record, filter)) {
				records.push(record);
			}
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		filter,
		totalRecords: records.length,
		records,
	};
}

/**
 * Returns aggregate event counts grouped by type and outcome for the given
 * date range.  Useful for dashboards and compliance summaries.
 *
 * @nist AU-7
 */
export async function getAuditStats(
	startDate?: string,
	endDate?: string,
): Promise<{ byType: Record<string, number>; byOutcome: Record<string, number>; total: number }> {
	const report = await generateAuditReport({ startDate, endDate });

	const byType: Record<string, number> = {};
	const byOutcome: Record<string, number> = {};

	for (const record of report.records) {
		byType[record.eventType] = (byType[record.eventType] ?? 0) + 1;
		byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
	}

	return { byType, byOutcome, total: report.totalRecords };
}
