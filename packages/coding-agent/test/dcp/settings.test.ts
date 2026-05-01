import { describe, expect, test } from "bun:test";
import { getDefault, getType } from "../../src/config/settings-schema";

describe("DCP settings schema", () => {
	test("dcp.enabled defaults to true", () => {
		expect(getDefault("dcp.enabled")).toBe(true);
	});

	test("dcp.strategies.deduplication.enabled defaults to true", () => {
		expect(getDefault("dcp.strategies.deduplication.enabled")).toBe(true);
	});

	test("dcp.strategies.purgeErrors.enabled defaults to true", () => {
		expect(getDefault("dcp.strategies.purgeErrors.enabled")).toBe(true);
	});

	test("dcp.strategies.purgeErrors.turnThreshold defaults to 4", () => {
		expect(getDefault("dcp.strategies.purgeErrors.turnThreshold")).toBe(4);
	});

	test("dcp.strategies.supersedeWrites.enabled defaults to true", () => {
		expect(getDefault("dcp.strategies.supersedeWrites.enabled")).toBe(true);
	});

	test("dcp.nudge.enabled defaults to true", () => {
		expect(getDefault("dcp.nudge.enabled")).toBe(true);
	});

	test("dcp.nudge.maxContextLimit defaults to 100000", () => {
		expect(getDefault("dcp.nudge.maxContextLimit")).toBe(100000);
	});

	test("dcp.nudge.minContextLimit defaults to 50000", () => {
		expect(getDefault("dcp.nudge.minContextLimit")).toBe(50000);
	});

	test("dcp.nudge.frequency defaults to 5", () => {
		expect(getDefault("dcp.nudge.frequency")).toBe(5);
	});

	test("dcp.nudge.iterationThreshold defaults to 15", () => {
		expect(getDefault("dcp.nudge.iterationThreshold")).toBe(15);
	});

	test("dcp.turnProtection.turns defaults to 2", () => {
		expect(getDefault("dcp.turnProtection.turns")).toBe(2);
	});

	test("dcp.protectedTools defaults to expected list", () => {
		const tools = [...(getDefault("dcp.protectedTools") as readonly string[])];
		expect(tools).toContain("task");
		expect(tools).toContain("skill");
		expect(tools).toContain("todowrite");
		expect(tools).toContain("todoread");
		expect(tools).toContain("compress");
		expect(tools).toContain("write");
		expect(tools).toContain("edit");
		expect(tools).toContain("read");
	});

	test("dcp.protectedFilePatterns defaults to empty array", () => {
		expect(getDefault("dcp.protectedFilePatterns")).toEqual([]);
	});

	test("all dcp settings have correct types", () => {
		expect(getType("dcp.enabled")).toBe("boolean");
		expect(getType("dcp.strategies.deduplication.enabled")).toBe("boolean");
		expect(getType("dcp.strategies.purgeErrors.enabled")).toBe("boolean");
		expect(getType("dcp.strategies.purgeErrors.turnThreshold")).toBe("number");
		expect(getType("dcp.strategies.supersedeWrites.enabled")).toBe("boolean");
		expect(getType("dcp.nudge.enabled")).toBe("boolean");
		expect(getType("dcp.nudge.maxContextLimit")).toBe("number");
		expect(getType("dcp.nudge.minContextLimit")).toBe("number");
		expect(getType("dcp.nudge.frequency")).toBe("number");
		expect(getType("dcp.nudge.iterationThreshold")).toBe("number");
		expect(getType("dcp.turnProtection.turns")).toBe("number");
		expect(getType("dcp.protectedTools")).toBe("array");
		expect(getType("dcp.protectedFilePatterns")).toBe("array");
	});
});
