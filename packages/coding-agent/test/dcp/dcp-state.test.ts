import { describe, expect, test } from "bun:test";
import {
	createDCPState,
	getStats,
	getToolSignature,
	isMarkedForPruning,
	markForPruning,
	registerToolCall,
} from "../../src/session/compaction/dcp-state";

describe("createDCPState", () => {
	test("returns empty state with all maps initialized", () => {
		const state = createDCPState();
		expect(state.toolParameters).toBeInstanceOf(Map);
		expect(state.toolParameters.size).toBe(0);
		expect(state.pruneTools).toBeInstanceOf(Map);
		expect(state.pruneTools.size).toBe(0);
		expect(state.compressionBlocks).toBeInstanceOf(Map);
		expect(state.compressionBlocks.size).toBe(0);
		expect(state.messageIdMap).toBeInstanceOf(Map);
		expect(state.currentTurn).toBe(0);
		expect(state.stats.totalPrunedTokens).toBe(0);
		expect(state.stats.prunedToolCount).toBe(0);
		expect(state.stats.compressionBlockCount).toBe(0);
	});
});

describe("getToolSignature", () => {
	test("creates deterministic signature from tool name and params", () => {
		const sig1 = getToolSignature("read", { filePath: "/a.ts" });
		const sig2 = getToolSignature("read", { filePath: "/a.ts" });
		expect(sig1).toBe(sig2);
	});

	test("different params produce different signatures", () => {
		const sig1 = getToolSignature("read", { filePath: "/a.ts" });
		const sig2 = getToolSignature("read", { filePath: "/b.ts" });
		expect(sig1).not.toBe(sig2);
	});

	test("normalizes parameter key order", () => {
		const sig1 = getToolSignature("bash", { command: "ls", timeout: 5000 });
		const sig2 = getToolSignature("bash", { timeout: 5000, command: "ls" });
		expect(sig1).toBe(sig2);
	});

	test("strips null and undefined values", () => {
		const sig1 = getToolSignature("read", { filePath: "/a.ts", encoding: null } as any);
		const sig2 = getToolSignature("read", { filePath: "/a.ts" });
		expect(sig1).toBe(sig2);
	});

	test("strips undefined values", () => {
		const sig1 = getToolSignature("read", { filePath: "/a.ts", limit: undefined });
		const sig2 = getToolSignature("read", { filePath: "/a.ts" });
		expect(sig1).toBe(sig2);
	});

	test("includes tool name in signature", () => {
		const sig1 = getToolSignature("read", { filePath: "/a.ts" });
		const sig2 = getToolSignature("write", { filePath: "/a.ts" });
		expect(sig1).not.toBe(sig2);
	});
});

describe("registerToolCall", () => {
	test("stores tool parameter entry", () => {
		const state = createDCPState();
		registerToolCall(state, "tc1", {
			tool: "read",
			parameters: { filePath: "/a.ts" },
			status: "success",
			turn: 1,
			tokenCount: 100,
		});
		expect(state.toolParameters.has("tc1")).toBe(true);
		const entry = state.toolParameters.get("tc1")!;
		expect(entry.tool).toBe("read");
		expect(entry.status).toBe("success");
		expect(entry.turn).toBe(1);
		expect(entry.tokenCount).toBe(100);
	});
});

describe("markForPruning", () => {
	test("adds tool call to prune map with token count", () => {
		const state = createDCPState();
		markForPruning(state, "tc1", 500);
		expect(state.pruneTools.has("tc1")).toBe(true);
		expect(state.pruneTools.get("tc1")).toBe(500);
	});

	test("updates stats", () => {
		const state = createDCPState();
		markForPruning(state, "tc1", 500);
		markForPruning(state, "tc2", 300);
		expect(state.stats.totalPrunedTokens).toBe(800);
		expect(state.stats.prunedToolCount).toBe(2);
	});
});

describe("isMarkedForPruning", () => {
	test("returns true for pruned tool call", () => {
		const state = createDCPState();
		markForPruning(state, "tc1", 500);
		expect(isMarkedForPruning(state, "tc1")).toBe(true);
	});

	test("returns false for non-pruned tool call", () => {
		const state = createDCPState();
		expect(isMarkedForPruning(state, "tc1")).toBe(false);
	});
});

describe("getStats", () => {
	test("returns stats from state", () => {
		const state = createDCPState();
		markForPruning(state, "tc1", 500);
		const stats = getStats(state);
		expect(stats.totalPrunedTokens).toBe(500);
		expect(stats.prunedToolCount).toBe(1);
		expect(stats.compressionBlockCount).toBe(0);
	});
});
