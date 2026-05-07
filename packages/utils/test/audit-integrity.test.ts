import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listAuditLogs, verifyAuditLog } from "../src/audit-integrity";
import * as dirs from "../src/dirs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data: string): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

const GENESIS_HASH = sha256("omp-audit-genesis-v1");

interface MinimalEvent {
	eventId: string;
	timestamp: string;
	eventType: string;
	actor: string;
	resource: string;
	outcome: string;
	prevHash: string;
}

/**
 * Builds a valid JSONL audit log string from scratch, reproducing the exact
 * serialization that SecurityAuditLogger produces.
 */
function buildValidLog(count: number): { content: string; lines: string[] } {
	const lines: string[] = [];
	let prevHash = GENESIS_HASH;

	for (let i = 0; i < count; i++) {
		const event: MinimalEvent = {
			eventId: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			eventType: "AUTH_SUCCESS",
			actor: "test",
			resource: `/res/${i}`,
			outcome: "success",
			prevHash,
		};
		const line = JSON.stringify(event);
		lines.push(line);
		prevHash = sha256(`${line}\n`);
	}

	return { content: lines.join("\n") + (lines.length > 0 ? "\n" : ""), lines };
}

async function writeLog(logDir: string, date: string, content: string): Promise<void> {
	await fs.mkdir(logDir, { recursive: true });
	await fs.writeFile(path.join(logDir, `audit.${date}.log`), content, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-integrity-test-"));
	vi.spyOn(dirs, "getLogsDir").mockReturnValue(tmpDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verifyAuditLog tests
// ---------------------------------------------------------------------------

describe("valid log passes verification", () => {
	it("returns valid=true and correct entriesChecked", async () => {
		const { content } = buildValidLog(5);
		await writeLog(tmpDir, "2025-01-01", content);

		const result = await verifyAuditLog("2025-01-01");

		expect(result.valid).toBe(true);
		expect(result.entriesChecked).toBe(5);
		expect(result.firstInvalidEntry).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it("returns valid=true for a single entry", async () => {
		const { content } = buildValidLog(1);
		await writeLog(tmpDir, "2025-01-02", content);

		const result = await verifyAuditLog("2025-01-02");

		expect(result.valid).toBe(true);
		expect(result.entriesChecked).toBe(1);
	});
});

describe("empty file is valid", () => {
	it("returns valid=true with entriesChecked=0", async () => {
		await writeLog(tmpDir, "2025-02-01", "");

		const result = await verifyAuditLog("2025-02-01");

		expect(result.valid).toBe(true);
		expect(result.entriesChecked).toBe(0);
	});
});

describe("missing file returns error", () => {
	it("returns valid=false with an error message", async () => {
		const result = await verifyAuditLog("1999-12-31");

		expect(result.valid).toBe(false);
		expect(result.entriesChecked).toBe(0);
		expect(result.error).toBeDefined();
		expect(typeof result.error).toBe("string");
		// The error must reference the missing date
		expect(result.error).toContain("1999-12-31");
	});
});

describe("modified entry breaks chain", () => {
	it("detects tampered entry and reports correct firstInvalidEntry", async () => {
		const { lines } = buildValidLog(4);

		// Tamper with the second entry (index 1): change its resource field
		const parsed = JSON.parse(lines[1]) as MinimalEvent;
		parsed.resource = "/tampered";
		lines[1] = JSON.stringify(parsed);

		const tampered = `${lines.join("\n")}\n`;
		await writeLog(tmpDir, "2025-03-01", tampered);

		const result = await verifyAuditLog("2025-03-01");

		expect(result.valid).toBe(false);
		// Entry 0 is fine; entry 1's prevHash is still correct (it was not changed),
		// but entry 2's prevHash will no longer match because line 1 was mutated.
		// firstInvalidEntry should be 2.
		expect(result.firstInvalidEntry).toBe(2);
		expect(result.error).toBeDefined();
	});

	it("detects tampered prevHash field directly", async () => {
		const { lines } = buildValidLog(3);

		// Overwrite the prevHash of entry 1 with garbage
		const parsed = JSON.parse(lines[1]) as MinimalEvent;
		parsed.prevHash = "deadbeef".repeat(8);
		lines[1] = JSON.stringify(parsed);

		const tampered = `${lines.join("\n")}\n`;
		await writeLog(tmpDir, "2025-03-02", tampered);

		const result = await verifyAuditLog("2025-03-02");

		expect(result.valid).toBe(false);
		// The bad prevHash is at entry 1 itself
		expect(result.firstInvalidEntry).toBe(1);
	});

	it("detects insertion of a new entry", async () => {
		const { lines } = buildValidLog(2);

		// Insert a foreign entry between existing entries — its prevHash will be wrong
		const foreign: MinimalEvent = {
			eventId: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			eventType: "TOOL_BLOCKED",
			actor: "attacker",
			resource: "/injected",
			outcome: "blocked",
			prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
		};
		lines.splice(1, 0, JSON.stringify(foreign));

		const tampered = `${lines.join("\n")}\n`;
		await writeLog(tmpDir, "2025-03-03", tampered);

		const result = await verifyAuditLog("2025-03-03");

		expect(result.valid).toBe(false);
		// The injected entry at index 1 has an incorrect prevHash
		expect(result.firstInvalidEntry).toBeDefined();
	});
});

describe("listAuditLogs returns sorted dates", () => {
	it("returns empty array when no log files exist", async () => {
		const dates = await listAuditLogs();
		expect(dates).toEqual([]);
	});

	it("returns only audit log dates in chronological order", async () => {
		// Create log files in non-sorted order
		for (const date of ["2025-03-15", "2025-01-01", "2025-06-30", "2025-02-14"]) {
			await writeLog(tmpDir, date, "");
		}

		// Also create a non-audit file that should not appear
		await fs.writeFile(path.join(tmpDir, "omp.2025-01-01.log"), "irrelevant");

		const dates = await listAuditLogs();

		expect(dates).toEqual(["2025-01-01", "2025-02-14", "2025-03-15", "2025-06-30"]);
	});

	it("ignores files that do not match audit.YYYY-MM-DD.log pattern", async () => {
		await writeLog(tmpDir, "2025-05-01", "");
		await fs.writeFile(path.join(tmpDir, "audit.log"), "");
		await fs.writeFile(path.join(tmpDir, "audit.2025-05-0x.log"), "");
		await fs.writeFile(path.join(tmpDir, "not-audit.2025-05-02.log"), "");

		const dates = await listAuditLogs();

		expect(dates).toEqual(["2025-05-01"]);
	});

	it("returns empty array when log directory does not exist", async () => {
		// Point spy at a non-existent directory
		vi.spyOn(dirs, "getLogsDir").mockReturnValue(path.join(tmpDir, "nonexistent"));

		const dates = await listAuditLogs();

		expect(dates).toEqual([]);
	});
});
