import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createBlock } from "../../src/session/compaction/compression-blocks";
import type { DCPConfig } from "../../src/session/compaction/dcp-config";
import type { DCPState } from "../../src/session/compaction/dcp-state";
import { createDCPTransform } from "../../src/session/compaction/dcp-transform";
import { assignMessageIds } from "../../src/session/compaction/message-ids";

function makeToolCall(id: string, name: string, args: Record<string, any>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "tool_use",
		timestamp: Date.now(),
	} as any;
}

function makeToolResult(toolCallId: string, toolName: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as any;
}

function makeUser(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as any;
}

describe("createDCPTransform", () => {
	let state: DCPState;
	let config: DCPConfig;

	beforeEach(() => {
		state = {
			toolParameters: new Map(),
			pruneTools: new Map(),
			compressionBlocks: new Map(),
			messageIdMap: new Map(),
			currentTurn: 10, // Increased to avoid turn protection
			stats: {
				totalPrunedTokens: 0,
				prunedToolCount: 0,
				compressionBlockCount: 0,
			},
			nudgeCallCount: 0,
		} as any;

		config = {
			enabled: true,
			strategies: {
				deduplication: { enabled: true, protectedTools: [], protectedFilePatterns: [], turnProtectionTurns: 1 },
				purgeErrors: { enabled: true, turnThreshold: 5, protectedTools: [] },
				supersedeWrites: { enabled: true, protectedFilePatterns: [], writeTools: [], readTools: [] },
			},
		};
	});

	it("should return identity function if config.enabled is false", () => {
		config.enabled = false;
		const transform = createDCPTransform(state, config);
		const messages = [makeUser("hello")];
		const result = transform(messages);
		expect(result).toBe(messages);
	});

	it("should process messages through pipeline (all enabled)", async () => {
		const transform = createDCPTransform(state, config);
		const messages = [
			makeToolCall("1", "read", { file: "a.ts" }),
			makeToolResult("1", "read", "content"),
			makeToolCall("2", "read", { file: "a.ts" }), // Duplicate
			makeToolResult("2", "read", "content"),
		];

		// Setup state to track tool call 1
		state.toolParameters.set("1", { tool: "read", status: "success", turn: 1, tokenCount: 10 } as any);
		state.toolParameters.set("2", { tool: "read", status: "success", turn: 1, tokenCount: 10 } as any);

		const result = transform(messages);

		// Log results for debugging
		// console.log("Result length:", result.length, "Messages length:", messages.length);

		// Deduplication should prune tool call 2
		// Based on logic, we expect only the first call remains (plus its result)
		expect((await result).length).toBe(2);
	});

	it("should update stats after pipeline run", () => {
		// Force some pruning to happen
		config.strategies.deduplication.enabled = true;

		const transform = createDCPTransform(state, config);
		const messages = [
			makeToolCall("1", "read", { file: "a.ts" }),
			makeToolResult("1", "read", "content"),
			makeToolCall("2", "read", { file: "a.ts" }),
			makeToolResult("2", "read", "content"),
		];

		state.toolParameters.set("1", { tool: "read", status: "success", turn: 1, tokenCount: 10 } as any);
		state.toolParameters.set("2", { tool: "read", status: "success", turn: 1, tokenCount: 10 } as any);

		transform(messages);

		expect(state.stats.prunedToolCount).toBeGreaterThan(0);
	});

	it("never produces orphaned toolResults after compression", async () => {
		config.strategies.deduplication.enabled = false;
		config.strategies.purgeErrors.enabled = false;
		config.strategies.supersedeWrites.enabled = false;
		const transform = createDCPTransform(state, config);

		const messages: AgentMessage[] = [
			makeUser("start"),
			makeToolCall("tc1", "read", { file: "a.ts" }),
			makeToolResult("tc1", "read", "content of a.ts"),
			makeUser("done"),
		];

		// First run: populates state.lastAssignedIdMap and state.lastTransformMessages
		const firstResult = await transform(messages);
		expect(firstResult.length).toBeGreaterThanOrEqual(4);

		// Create a block targeting the assistant+toolResult range (m0002..m0003).
		// assignMessageIds: index 0 = user (m0001), 1 = assistant (m0002),
		//                   2 = toolResult (m0003), 3 = user (m0004).
		const rawIdMap = assignMessageIds(messages);
		const idValues = Array.from(rawIdMap.values());
		const startId = idValues[1]; // m0002 — assistant
		const endId = idValues[2]; // m0003 — toolResult

		createBlock(state, {
			mode: "range",
			topic: "test compression",
			startId,
			endId,
			summary: "compressed the tool call and result",
			messageIdMap: rawIdMap,
			messages,
		});

		// Second run: filterCompressedRanges removes the assistant+toolResult pair.
		// The result must have no orphaned toolResults.
		const secondResult = await transform(messages);

		const seenToolCallIds = new Set<string>();
		for (const msg of secondResult) {
			if (msg.role === "assistant") {
				for (const blk of (msg as any).content) {
					if (blk.type === "toolCall") seenToolCallIds.add(blk.id);
				}
			}
		}
		for (const msg of secondResult) {
			if (msg.role === "toolResult") {
				const tcId = (msg as any).toolCallId as string;
				expect(seenToolCallIds.has(tcId)).toBe(true);
			}
		}
	});

	it("falls back when compression block would orphan a toolResult", async () => {
		// Tests the validateToolPairing fallback path.
		// We manually set a compression block whose effectiveFingerprints only contains
		// the assistant fingerprint (startId==endId==assistantId). Forward expansion in
		// filterCompressedRanges should carry the toolResult, keeping the pair intact.
		// If forward expansion somehow failed, validateToolPairing would catch it.
		config.strategies.deduplication.enabled = false;
		config.strategies.purgeErrors.enabled = false;
		config.strategies.supersedeWrites.enabled = false;
		const transform = createDCPTransform(state, config);

		const messages: AgentMessage[] = [
			makeUser("before"),
			makeToolCall("tc2", "bash", { command: "ls" }),
			makeToolResult("tc2", "bash", "file1.ts"),
			makeUser("after"),
		];

		// Run once to seed state
		await transform(messages);

		// Block covers only the assistant message (startId==endId).
		// Forward expansion in filterCompressedRanges must also mark the toolResult for removal.
		const rawIdMap = assignMessageIds(messages);
		const idValues = Array.from(rawIdMap.values());
		const assistantId = idValues[1]; // m0002

		createBlock(state, {
			mode: "range",
			topic: "assistant-only block",
			startId: assistantId,
			endId: assistantId,
			summary: "removed the bash call",
			messageIdMap: rawIdMap,
			messages,
		});

		const result = await transform(messages);

		// Invariant: every toolResult in the output must have a paired assistant toolCall.
		const allToolCallIds = new Set<string>();
		for (const msg of result) {
			if (msg.role === "assistant") {
				for (const blk of (msg as any).content) {
					if (blk.type === "toolCall") allToolCallIds.add(blk.id);
				}
			}
		}
		for (const msg of result) {
			if (msg.role === "toolResult") {
				const tcId = (msg as any).toolCallId as string;
				expect(allToolCallIds.has(tcId)).toBe(true);
			}
		}
	});
});
