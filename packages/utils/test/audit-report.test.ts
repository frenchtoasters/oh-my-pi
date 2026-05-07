import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateAuditReport, getAuditStats } from "../src/audit-report";
import * as dirs from "../src/dirs";
import type { SecurityEvent } from "../src/security-audit";
import { SecurityEventType } from "../src/security-audit";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-test-"));
	vi.spyOn(dirs, "getLogsDir").mockReturnValue(tmpDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SecurityEvent JSONL line. */
function makeEvent(overrides: Partial<SecurityEvent> & { timestamp: string }): SecurityEvent {
	return {
		eventId: "00000000-0000-0000-0000-000000000001",
		eventType: SecurityEventType.AUTH_SUCCESS,
		actor: "test-actor",
		resource: "/test/resource",
		outcome: "success",
		...overrides,
	} as SecurityEvent;
}

/** Write JSONL audit log for a given date. */
async function writeAuditLog(date: string, events: SecurityEvent[]): Promise<void> {
	const lines = `${events.map(e => JSON.stringify(e)).join("\n")}\n`;
	await fs.writeFile(path.join(tmpDir, `audit.${date}.log`), lines, "utf8");
}

// ---------------------------------------------------------------------------
// generateAuditReport — empty / missing log
// ---------------------------------------------------------------------------

describe("generateAuditReport with no log files", () => {
	it("returns empty report when log directory has no audit files", async () => {
		const report = await generateAuditReport({});
		expect(report.totalRecords).toBe(0);
		expect(report.records).toEqual([]);
		expect(typeof report.generatedAt).toBe("string");
	});

	it("returns empty report when log file for requested date is missing", async () => {
		const report = await generateAuditReport({
			startDate: "2024-01-01",
			endDate: "2024-01-31",
		});
		expect(report.totalRecords).toBe(0);
		expect(report.records).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// generateAuditReport — date range filtering
// ---------------------------------------------------------------------------

describe("generateAuditReport date range filtering", () => {
	beforeEach(async () => {
		await writeAuditLog("2025-01-10", [makeEvent({ timestamp: "2025-01-10T12:00:00.000Z" })]);
		await writeAuditLog("2025-02-15", [makeEvent({ timestamp: "2025-02-15T08:00:00.000Z" })]);
		await writeAuditLog("2025-03-20", [makeEvent({ timestamp: "2025-03-20T18:00:00.000Z" })]);
	});

	it("returns all records with no date filter", async () => {
		const report = await generateAuditReport({});
		expect(report.totalRecords).toBe(3);
	});

	it("filters records by startDate", async () => {
		const report = await generateAuditReport({ startDate: "2025-02-01" });
		expect(report.totalRecords).toBe(2);
		for (const r of report.records) {
			expect(r.timestamp.slice(0, 10) >= "2025-02-01").toBe(true);
		}
	});

	it("filters records by endDate", async () => {
		const report = await generateAuditReport({ endDate: "2025-02-28" });
		expect(report.totalRecords).toBe(2);
		for (const r of report.records) {
			expect(r.timestamp.slice(0, 10) <= "2025-02-28").toBe(true);
		}
	});

	it("filters records by startDate and endDate (inclusive)", async () => {
		const report = await generateAuditReport({
			startDate: "2025-01-10",
			endDate: "2025-02-15",
		});
		expect(report.totalRecords).toBe(2);
	});

	it("returns empty report when date range excludes all records", async () => {
		const report = await generateAuditReport({
			startDate: "2026-01-01",
			endDate: "2026-12-31",
		});
		expect(report.totalRecords).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// generateAuditReport — eventType filtering
// ---------------------------------------------------------------------------

describe("generateAuditReport eventType filtering", () => {
	beforeEach(async () => {
		await writeAuditLog("2025-05-01", [
			makeEvent({ timestamp: "2025-05-01T10:00:00.000Z", eventType: SecurityEventType.AUTH_SUCCESS }),
			makeEvent({ timestamp: "2025-05-01T11:00:00.000Z", eventType: SecurityEventType.AUTH_FAILURE }),
			makeEvent({ timestamp: "2025-05-01T12:00:00.000Z", eventType: SecurityEventType.TOOL_BLOCKED }),
		]);
	});

	it("returns only records matching requested eventTypes", async () => {
		const report = await generateAuditReport({
			eventTypes: [SecurityEventType.AUTH_FAILURE],
		});
		expect(report.totalRecords).toBe(1);
		expect(report.records[0].eventType).toBe(SecurityEventType.AUTH_FAILURE);
	});

	it("returns multiple types when multiple are requested", async () => {
		const report = await generateAuditReport({
			eventTypes: [SecurityEventType.AUTH_SUCCESS, SecurityEventType.TOOL_BLOCKED],
		});
		expect(report.totalRecords).toBe(2);
	});

	it("returns empty result when no records match requested eventType", async () => {
		const report = await generateAuditReport({
			eventTypes: [SecurityEventType.SESSION_START],
		});
		expect(report.totalRecords).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// generateAuditReport — outcome filtering
// ---------------------------------------------------------------------------

describe("generateAuditReport outcome filtering", () => {
	beforeEach(async () => {
		await writeAuditLog("2025-06-01", [
			makeEvent({ timestamp: "2025-06-01T10:00:00.000Z", outcome: "success" }),
			makeEvent({ timestamp: "2025-06-01T11:00:00.000Z", outcome: "failure" }),
			makeEvent({ timestamp: "2025-06-01T12:00:00.000Z", outcome: "blocked" }),
		]);
	});

	it("returns only records matching the requested outcome", async () => {
		const report = await generateAuditReport({ outcome: "failure" });
		expect(report.totalRecords).toBe(1);
		expect(report.records[0].outcome).toBe("failure");
	});

	it("returns records with success outcome", async () => {
		const report = await generateAuditReport({ outcome: "success" });
		expect(report.totalRecords).toBe(1);
		expect(report.records[0].outcome).toBe("success");
	});
});

// ---------------------------------------------------------------------------
// getAuditStats
// ---------------------------------------------------------------------------

describe("getAuditStats", () => {
	beforeEach(async () => {
		await writeAuditLog("2025-07-01", [
			makeEvent({
				timestamp: "2025-07-01T10:00:00.000Z",
				eventType: SecurityEventType.AUTH_SUCCESS,
				outcome: "success",
			}),
			makeEvent({
				timestamp: "2025-07-01T11:00:00.000Z",
				eventType: SecurityEventType.AUTH_SUCCESS,
				outcome: "success",
			}),
			makeEvent({
				timestamp: "2025-07-01T12:00:00.000Z",
				eventType: SecurityEventType.AUTH_FAILURE,
				outcome: "failure",
			}),
			makeEvent({
				timestamp: "2025-07-01T13:00:00.000Z",
				eventType: SecurityEventType.TOOL_BLOCKED,
				outcome: "blocked",
			}),
		]);
	});

	it("returns correct total count", async () => {
		const stats = await getAuditStats("2025-07-01", "2025-07-01");
		expect(stats.total).toBe(4);
	});

	it("returns correct byType counts", async () => {
		const stats = await getAuditStats("2025-07-01", "2025-07-01");
		expect(stats.byType[SecurityEventType.AUTH_SUCCESS]).toBe(2);
		expect(stats.byType[SecurityEventType.AUTH_FAILURE]).toBe(1);
		expect(stats.byType[SecurityEventType.TOOL_BLOCKED]).toBe(1);
	});

	it("returns correct byOutcome counts", async () => {
		const stats = await getAuditStats("2025-07-01", "2025-07-01");
		expect(stats.byOutcome.success).toBe(2);
		expect(stats.byOutcome.failure).toBe(1);
		expect(stats.byOutcome.blocked).toBe(1);
	});

	it("returns zero totals for empty date range", async () => {
		const stats = await getAuditStats("2020-01-01", "2020-12-31");
		expect(stats.total).toBe(0);
		expect(Object.keys(stats.byType)).toHaveLength(0);
		expect(Object.keys(stats.byOutcome)).toHaveLength(0);
	});
});
