import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuditCapacityMonitor } from "../src/audit-capacity";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-capacity-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a file of exactly `bytes` length into the temp dir. */
async function writeFile(name: string, bytes: number): Promise<void> {
	await fs.writeFile(path.join(tmpDir, name), Buffer.alloc(bytes, 0x61));
}

// ---------------------------------------------------------------------------
// checkCapacity — level classification
// ---------------------------------------------------------------------------

describe("checkCapacity", () => {
	it("returns normal level for empty directory", () => {
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, tmpDir);
		const status = monitor.checkCapacity();
		expect(status.level).toBe("normal");
		expect(status.currentBytes).toBe(0);
		expect(status.maxBytes).toBe(1000);
		expect(status.percentUsed).toBe(0);
	});

	it("returns warning when dir size exceeds 80% of max", async () => {
		// 850 bytes / 1000 max = 85% — above warn (80%), below critical (95%)
		await writeFile("a.log", 850);
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, tmpDir);
		const status = monitor.checkCapacity();
		expect(status.level).toBe("warning");
		expect(status.percentUsed).toBeGreaterThanOrEqual(80);
		expect(status.percentUsed).toBeLessThan(95);
	});

	it("returns critical when dir size exceeds 95% of max", async () => {
		// 970 bytes / 1000 max = 97% — above critical (95%)
		await writeFile("a.log", 970);
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, tmpDir);
		const status = monitor.checkCapacity();
		expect(status.level).toBe("critical");
		expect(status.percentUsed).toBeGreaterThanOrEqual(95);
	});

	it("returns normal when dir size is exactly at 79% of max", async () => {
		// 790 bytes / 1000 max = 79% — strictly below warn threshold
		await writeFile("a.log", 790);
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, tmpDir);
		const status = monitor.checkCapacity();
		expect(status.level).toBe("normal");
	});

	it("returns 0 bytes for non-existent directory", () => {
		const missing = path.join(tmpDir, "nonexistent");
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, missing);
		const status = monitor.checkCapacity();
		expect(status.currentBytes).toBe(0);
		expect(status.level).toBe("normal");
	});
});

// ---------------------------------------------------------------------------
// checkCapacity — config overrides
// ---------------------------------------------------------------------------

describe("checkCapacity with custom thresholds", () => {
	it("respects custom warnThresholdPct", async () => {
		// 600 bytes / 1000 max = 60%; set warn at 50% and critical at 90%
		await writeFile("a.log", 600);
		const monitor = new AuditCapacityMonitor(
			{ maxLogDirBytes: 1000, warnThresholdPct: 50, criticalThresholdPct: 90 },
			tmpDir,
		);
		const status = monitor.checkCapacity();
		expect(status.level).toBe("warning");
	});

	it("respects custom criticalThresholdPct", async () => {
		// 700 bytes / 1000 max = 70%; set warn at 50% and critical at 65%
		await writeFile("a.log", 700);
		const monitor = new AuditCapacityMonitor(
			{ maxLogDirBytes: 1000, warnThresholdPct: 50, criticalThresholdPct: 65 },
			tmpDir,
		);
		const status = monitor.checkCapacity();
		expect(status.level).toBe("critical");
	});
});

// ---------------------------------------------------------------------------
// ensureCapacity
// ---------------------------------------------------------------------------

describe("ensureCapacity", () => {
	it("returns true for empty directory (normal)", () => {
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, tmpDir);
		expect(monitor.ensureCapacity()).toBe(true);
	});

	it("returns true for warning level", async () => {
		await writeFile("a.log", 850);
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, tmpDir);
		expect(monitor.ensureCapacity()).toBe(true);
	});

	it("returns false for critical level", async () => {
		await writeFile("a.log", 970);
		const monitor = new AuditCapacityMonitor({ maxLogDirBytes: 1000 }, tmpDir);
		expect(monitor.ensureCapacity()).toBe(false);
	});
});
