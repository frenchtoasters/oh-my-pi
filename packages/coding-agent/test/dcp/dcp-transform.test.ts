import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { DCPConfig } from "../../src/session/compaction/dcp-config";
import type { DCPState } from "../../src/session/compaction/dcp-state";
import { createDCPTransform } from "../../src/session/compaction/dcp-transform";

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
});
