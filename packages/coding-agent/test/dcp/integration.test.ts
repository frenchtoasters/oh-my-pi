import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createBlock, deactivateBlock } from "../../src/session/compaction/compression-blocks";
import type { DCPConfig } from "../../src/session/compaction/dcp-config";
import { createDCPState, registerToolCall } from "../../src/session/compaction/dcp-state";
import { createDCPTransform } from "../../src/session/compaction/dcp-transform";
import { assignMessageIds } from "../../src/session/compaction/message-ids";

// Define message structures
interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
}

function defaultConfig(): DCPConfig {
	return {
		enabled: true,
		strategies: {
			deduplication: {
				enabled: true,
				protectedTools: ["task", "skill", "todowrite", "todoread", "compress", "write", "edit", "read"],
				protectedFilePatterns: [],
				turnProtectionTurns: 2,
			},
			purgeErrors: { enabled: true, turnThreshold: 4, protectedTools: ["task", "skill"] },
			supersedeWrites: {
				enabled: true,
				protectedFilePatterns: [],
				writeTools: ["write", "edit"],
				readTools: ["read"],
			},
		},
	};
}

const now = Date.now();
const usage = {
	input: 100,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: now } as AgentMessage;
}

function assistantMsg(content: any): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage,
		stopReason: "end_turn",
		timestamp: now,
	} as unknown as AgentMessage;
}

function toolCall(id: string, name: string, args: Record<string, any>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function toolResult(toolCallId: string, toolName: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: now,
	} as AgentMessage;
}

describe("DCP Integration", () => {
	describe("full pipeline with mixed session", () => {
		it("should prune and compact messages correctly", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			const messages: AgentMessage[] = [
				userMsg("hi"),
				assistantMsg([toolCall("t1", "grep", { query: "foo" })]),
				toolResult("t1", "grep", "found"),
				assistantMsg([toolCall("t2", "grep", { query: "foo" })]), // Duplicate t1
				toolResult("t2", "grep", "found"),
				assistantMsg([toolCall("t3", "broken", {})]),
				toolResult("t3", "broken", "error", true), // Error
				assistantMsg([toolCall("t4", "write", { filePath: "a.ts", content: "..." })]),
				toolResult("t4", "write", "ok"),
				assistantMsg([toolCall("t5", "read", { filePath: "a.ts" })]), // Supersedes t4
				toolResult("t5", "read", "ok"),
				assistantMsg([toolCall("t6", "read", { filePath: "b.ts" })]), // Protected
				toolResult("t6", "read", "ok"),
			];

			// Set turns
			state.currentTurn = 10;
			registerToolCall(state, "t1", {
				tool: "grep",
				parameters: { query: "foo" },
				status: "success",
				turn: 1,
				tokenCount: 10,
			});
			registerToolCall(state, "t2", {
				tool: "grep",
				parameters: { query: "foo" },
				status: "success",
				turn: 2,
				tokenCount: 10,
			});
			registerToolCall(state, "t3", { tool: "broken", parameters: {}, status: "error", turn: 3, tokenCount: 10 });

			const transform = createDCPTransform(state, config);
			const output = await transform(messages);

			expect(output.length).toBeLessThan(messages.length);
			// Verify deduplication: only the most recent grep call should remain
			const grepResults = output.filter(m => m.role === "toolResult" && (m as any).toolName === "grep");
			expect(grepResults.length).toBe(1);

			// Verify error purging: t3 "broken" call args should be pruned (turn 3, currentTurn 10, threshold 4)
			const brokenCall = output.find(
				m =>
					m.role === "assistant" &&
					Array.isArray(m.content) &&
					(m.content as any[]).some((c: any) => c.type === "toolCall" && c.name === "broken"),
			);
			if (brokenCall) {
				const tc = (brokenCall as any).content.find((c: any) => c.type === "toolCall" && c.name === "broken");
				expect(tc.arguments._pruned).toBe(true);
				expect(tc.arguments._reason).toBe("error-input-purged");
			}

			// Verify supersede-writes: write to a.ts should be superseded by subsequent read
			const writeCall = output.find(
				m =>
					m.role === "assistant" &&
					Array.isArray(m.content) &&
					(m.content as any[]).some((c: any) => c.type === "toolCall" && c.name === "write"),
			);
			if (writeCall) {
				const tc = (writeCall as any).content.find((c: any) => c.type === "toolCall" && c.name === "write");
				expect(tc.arguments._pruned).toBe(true);
				expect(tc.arguments._reason).toBe("superseded-by-read");
			}

			// Result is a new array
			expect(output).not.toBe(messages);
		});
	});

	describe("tool call + result atomicity", () => {
		it("should remove both call and result on deduplication", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			const messages = [
				assistantMsg([toolCall("t1", "grep", { q: "dup" })]),
				toolResult("t1", "grep", "res1"),
				assistantMsg([toolCall("t2", "grep", { q: "dup" })]),
				toolResult("t2", "grep", "res2"),
			];
			state.currentTurn = 10;
			registerToolCall(state, "t1", {
				tool: "grep",
				parameters: { q: "dup" },
				status: "success",
				turn: 1,
				tokenCount: 1,
			});
			registerToolCall(state, "t2", {
				tool: "grep",
				parameters: { q: "dup" },
				status: "success",
				turn: 5,
				tokenCount: 1,
			});

			const transform = createDCPTransform(state, config);
			const output = await transform(messages);

			// Only the most recent (t2) call + result should remain
			const toolResults = output.filter(m => m.role === "toolResult");
			expect(toolResults.length).toBe(1);
			expect((toolResults[0] as any).toolCallId).toBe("t2");
		});
	});

	describe("protected tools never pruned", () => {
		it("should preserve protected tool calls", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			const messages = [
				assistantMsg([toolCall("t1", "read", { f: "f.ts" })]),
				toolResult("t1", "read", "c1"),
				assistantMsg([toolCall("t2", "read", { f: "f.ts" })]),
				toolResult("t2", "read", "c2"),
			];

			const transform = createDCPTransform(state, config);
			const output = await transform(messages);

			expect(output.length).toBe(4);
		});
	});

	describe("compression blocks", () => {
		it("should compress range into a block", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			const messages: AgentMessage[] = [userMsg("m1"), userMsg("m2"), userMsg("m3"), userMsg("m4"), userMsg("m5")];
			const idMap = assignMessageIds(messages);
			createBlock(state, {
				mode: "range",
				topic: "Test Block",
				startId: "m0002",
				endId: "m0004",
				summary: "Compressed content for messages 2-4",
				messageIdMap: idMap,
			});

			const transform = createDCPTransform(state, config);
			const output = await transform(messages);

			// m1, block summary, m5 (3 messages in range replaced by 1 summary)
			expect(output.length).toBe(3);
			const summary = output.find(
				m =>
					m.role === "developer" &&
					(Array.isArray(m.content)
						? (m.content as any[]).some((c: any) => c.type === "text" && c.text?.includes("Test Block"))
						: typeof m.content === "string" && (m.content as string).includes("Test Block")),
			);
			expect(summary).toBeDefined();
		});
	});

	describe("decompression round-trip", () => {
		it("should show original content when block is deactivated", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			const messages: AgentMessage[] = [userMsg("m1"), userMsg("m2"), userMsg("m3")];
			const idMap = assignMessageIds(messages);
			const block = createBlock(state, {
				mode: "range",
				topic: "B",
				startId: "m0001",
				endId: "m0003",
				summary: "Compressed all messages",
				messageIdMap: idMap,
			});

			const transform = createDCPTransform(state, config);
			const compressed = await transform(messages);
			// All 3 messages compressed into 1 summary
			expect(compressed.length).toBe(1);

			deactivateBlock(state, block.blockId);
			const decompressed = await transform(messages);
			expect(decompressed.length).toBe(3);
		});
	});

	describe("idempotency", () => {
		it("should produce identical output on consecutive runs", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			const messages = [userMsg("hi"), assistantMsg([toolCall("t1", "grep", { q: "x" })])];

			const transform = createDCPTransform(state, config);
			const out1 = await transform(messages);
			const out2 = await transform(messages);

			// Compare content only as IDs will differ
			expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
		});
	});

	describe("empty session", () => {
		it("should handle empty array", async () => {
			const state = createDCPState();
			const transform = createDCPTransform(state, defaultConfig());
			const output = await transform([]);
			expect(output).toEqual([]);
		});
	});

	describe("all strategies disabled", () => {
		it("should only inject IDs", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			config.strategies.deduplication.enabled = false;
			config.strategies.purgeErrors.enabled = false;
			config.strategies.supersedeWrites.enabled = false;

			const messages: AgentMessage[] = [userMsg("hi")];
			const transform = createDCPTransform(state, config);
			const output = await transform(messages);

			expect(output.length).toBe(1);
			// Message IDs are injected as XML tags in content
			const content = (output[0] as any).content;
			const text = typeof content === "string" ? content : content?.[0]?.text;
			expect(text).toContain("dcp-message-id");
		});
	});

	describe("DCP disabled", () => {
		it("should passthrough messages", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			config.enabled = false;

			const messages = [userMsg("hi")];
			const transform = createDCPTransform(state, config);
			const output = await transform(messages);

			expect(output).toBe(messages);
		});
	});

	describe("excludeFromContext messages", () => {
		it("should not assign IDs to excluded messages", async () => {
			const state = createDCPState();
			const config = defaultConfig();
			const messages = [{ ...userMsg("hi"), excludeFromContext: true } as AgentMessage];

			const transform = createDCPTransform(state, config);
			const output = await transform(messages);

			// excludeFromContext messages should NOT get dcp-message-id tags
			const content = (output[0] as any).content;
			const text = typeof content === "string" ? content : content?.[0]?.text;
			expect(text).not.toContain("dcp-message-id");
		});
	});
});
