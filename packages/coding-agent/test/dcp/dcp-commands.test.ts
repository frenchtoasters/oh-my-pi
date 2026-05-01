import { describe, expect, test } from "bun:test";
import { createBlock, deactivateBlock } from "../../src/session/compaction/compression-blocks";
import {
	handleDCPContext,
	handleDCPStats,
	handleDecompress,
	handleRecompress,
} from "../../src/session/compaction/dcp-commands";
import { createDCPState, type DCPState } from "../../src/session/compaction/dcp-state";

function setupStateWithBlock(): DCPState {
	const state = createDCPState();
	// Set up message ID map
	for (let i = 1; i <= 10; i++) {
		state.messageIdMap.set(`m${i.toString().padStart(4, "0")}`, String(i - 1));
	}
	// Create a block
	createBlock(state, {
		mode: "range",
		topic: "Test block",
		startId: "m0003",
		endId: "m0005",
		summary: "Test summary of messages 3-5",
		// Reverse mapping for block creation
		messageIdMap: new Map(Array.from(state.messageIdMap.entries()).map(([k, v]) => [Number(v), k])),
	});
	return state;
}

describe("DCP Commands", () => {
	test("handleDecompress: valid block", () => {
		const state = setupStateWithBlock();
		const blockId = Array.from(state.compressionBlocks.keys())[0];
		const result = handleDecompress(state, blockId);
		expect(result.success).toBe(true);
		expect(state.compressionBlocks.get(blockId)?.active).toBe(false);
	});

	test("handleDecompress: non-existent block", () => {
		const state = setupStateWithBlock();
		const result = handleDecompress(state, "b99");
		expect(result.success).toBe(false);
		expect(result.message).toContain("Block b99 not found");
	});

	test("handleRecompress: valid block", () => {
		const state = setupStateWithBlock();
		const blockId = Array.from(state.compressionBlocks.keys())[0];
		deactivateBlock(state, blockId);

		const result = handleRecompress(state, blockId);
		expect(result.success).toBe(true);
		expect(state.compressionBlocks.get(blockId)?.active).toBe(true);
	});

	test("handleRecompress: already active block", () => {
		const state = setupStateWithBlock();
		const blockId = Array.from(state.compressionBlocks.keys())[0];

		const result = handleRecompress(state, blockId);
		expect(result.success).toBe(false);
		expect(result.message).toContain("already active");
	});

	test("handleDCPStats: fresh state", () => {
		const state = createDCPState();
		const result = handleDCPStats(state);
		expect(result.success).toBe(true);
		expect(result.message).toContain("Total tokens saved: 0");
	});

	test("handleDCPContext: overview", () => {
		const state = setupStateWithBlock();
		const result = handleDCPContext(state, 50000);
		expect(result.success).toBe(true);
		expect(result.message).toContain("Current context tokens: 50000");
	});
});
