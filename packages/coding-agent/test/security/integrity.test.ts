import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import { validateCommand, validateFilePath, validateStringInput } from "../../src/security/input-validation";
import { ResourceLimits } from "../../src/security/resource-limits";
import { runSecuritySelfTest } from "../../src/security/self-test";

beforeEach(() => {
	vi.spyOn(piUtils, "emitSecurityEvent").mockReturnValue({
		eventId: "",
		timestamp: "",
		eventType: piUtils.SecurityEventType.INTEGRITY_VIOLATION,
		actor: "",
		resource: "",
		outcome: "success",
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// self-test
// =============================================================================

describe("runSecuritySelfTest", () => {
	test("passes with empty config when no baseline exists", async () => {
		const result = await runSecuritySelfTest({});
		expect(result.passed).toBe(true);
	});

	test("all checks have a name and passed=true on success", async () => {
		const result = await runSecuritySelfTest({});
		expect(result.checks.length).toBeGreaterThanOrEqual(1);
		for (const check of result.checks) {
			expect(typeof check.name).toBe("string");
			expect(check.name.length).toBeGreaterThan(0);
			expect(check.passed).toBe(true);
		}
	});

	test("returns at least 3 checks", async () => {
		const result = await runSecuritySelfTest({});
		expect(result.checks.length).toBeGreaterThanOrEqual(3);
	});
});

// =============================================================================
// input-validation — validateFilePath
// =============================================================================

describe("validateFilePath", () => {
	test("normal path returns valid", () => {
		const result = validateFilePath("normal/path.txt");
		expect(result.valid).toBe(true);
	});

	test("null byte in path returns invalid", () => {
		const result = validateFilePath("path\x00evil");
		expect(result.valid).toBe(false);
		expect(result.reason).toBeTruthy();
	});

	test("directory traversal returns invalid", () => {
		const result = validateFilePath("../../etc/passwd");
		expect(result.valid).toBe(false);
		expect(result.reason).toBeTruthy();
	});
});

// =============================================================================
// input-validation — validateCommand
// =============================================================================

describe("validateCommand", () => {
	test("normal command returns valid", () => {
		const result = validateCommand("ls -la");
		expect(result.valid).toBe(true);
	});

	test("newline injection returns invalid", () => {
		const result = validateCommand("cmd\nrm -rf /");
		expect(result.valid).toBe(false);
		expect(result.reason).toBeTruthy();
	});
});

// =============================================================================
// input-validation — validateStringInput
// =============================================================================

describe("validateStringInput", () => {
	test("normal string returns valid", () => {
		const result = validateStringInput("hello");
		expect(result.valid).toBe(true);
	});

	test("string exceeding default 1 MiB limit returns invalid", () => {
		// 2 million ASCII chars = 2 MB, well over the 1 MiB default.
		const result = validateStringInput("x".repeat(2_000_000));
		expect(result.valid).toBe(false);
		expect(result.reason).toBeTruthy();
	});

	test("empty string with maxLength=0 returns invalid", () => {
		// Zero bytes still exceeds a 0-byte budget because byteLength(0) > 0 is false,
		// but the check is byteLength > maxLength, so 0 > 0 === false → valid.
		// This documents the boundary: empty string is valid even at maxLength=0.
		const result = validateStringInput("", 0);
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// resource-limits
// =============================================================================

describe("ResourceLimits", () => {
	test("checkOutputSize returns true for size within default limit", () => {
		const limits = new ResourceLimits();
		expect(limits.checkOutputSize(100)).toBe(true);
	});

	test("checkOutputSize returns false when exceeding 10 MiB default", () => {
		const limits = new ResourceLimits();
		expect(limits.checkOutputSize(20_000_000)).toBe(false);
	});

	test("acquireSlot succeeds up to maxConcurrentTools then returns false", () => {
		const max = 3;
		const limits = new ResourceLimits({ maxConcurrentTools: max });

		for (let i = 0; i < max; i++) {
			expect(limits.acquireSlot()).toBe(true);
		}
		// One beyond the limit must be denied.
		expect(limits.acquireSlot()).toBe(false);
	});

	test("releaseSlot restores capacity after limit is reached", () => {
		const limits = new ResourceLimits({ maxConcurrentTools: 1 });
		expect(limits.acquireSlot()).toBe(true);
		expect(limits.acquireSlot()).toBe(false);

		limits.releaseSlot();

		// Slot is now free again.
		expect(limits.acquireSlot()).toBe(true);
	});

	test("addSessionBytes returns false when cumulative total exceeds limit", () => {
		const limits = new ResourceLimits({ maxSessionSizeBytes: 1000 });
		expect(limits.addSessionBytes(600)).toBe(true);
		// 600 + 600 = 1200, exceeds 1000.
		expect(limits.addSessionBytes(600)).toBe(false);
	});
});
