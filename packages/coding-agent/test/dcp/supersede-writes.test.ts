import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createDCPState } from "../../src/session/compaction/dcp-state";
import {
	DEFAULT_SUPERSEDE_WRITES_CONFIG,
	supersedeWrites,
} from "../../src/session/compaction/strategies/supersede-writes";

const BASE_ASSISTANT_MSG = {
	role: "assistant" as const,
	api: "anthropic-messages" as const,
	provider: "anthropic" as const,
	model: "claude-sonnet-4-20250514",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse" as const,
	timestamp: Date.now(),
};

describe("supersedeWrites", () => {
	it("returns messages unchanged when disabled", () => {
		const msg: AgentMessage = { ...BASE_ASSISTANT_MSG, content: [] };
		const result = supersedeWrites([msg], createDCPState(), { ...DEFAULT_SUPERSEDE_WRITES_CONFIG, enabled: false });
		expect(result).toEqual([msg]);
	});

	it("supersedes write when file is subsequently read", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w1", name: "write", arguments: { filePath: "foo.ts", content: "bar" } }],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { filePath: "foo.ts" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG);
		expect((result[0] as any).content[0].arguments).toEqual({
			_pruned: true,
			_reason: "superseded-by-read",
			filePath: "foo.ts",
		});
	});

	it("does not supersede write without subsequent read", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w1", name: "write", arguments: { filePath: "foo.ts", content: "bar" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG);
		expect(result).toEqual(msgs);
	});

	it("supersedes multiple writes to same file", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w1", name: "write", arguments: { filePath: "foo.ts", content: "1" } }],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w2", name: "write", arguments: { filePath: "foo.ts", content: "2" } }],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { filePath: "foo.ts" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG);
		expect((result[0] as any).content[0].arguments._pruned).toBe(true);
		expect((result[1] as any).content[0].arguments._pruned).toBe(true);
	});

	it("does not supersede write after last read", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w1", name: "write", arguments: { filePath: "foo.ts", content: "1" } }],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { filePath: "foo.ts" } }],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w2", name: "write", arguments: { filePath: "foo.ts", content: "2" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG);
		expect((result[0] as any).content[0].arguments._pruned).toBe(true);
		expect((result[2] as any).content[0].arguments._pruned).toBeUndefined();
	});

	it("respects protected file patterns", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [
					{ type: "toolCall", id: "w1", name: "write", arguments: { filePath: "protected.ts", content: "1" } },
				],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { filePath: "protected.ts" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), {
			...DEFAULT_SUPERSEDE_WRITES_CONFIG,
			protectedFilePatterns: ["protected.ts"],
		});
		expect((result[0] as any).content[0].arguments._pruned).toBeUndefined();
	});

	it("supersedes edit tool calls too", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { filePath: "foo.ts", content: "bar" } }],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { filePath: "foo.ts" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG);
		expect((result[0] as any).content[0].arguments._pruned).toBe(true);
	});

	it("does not mutate input", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w1", name: "write", arguments: { filePath: "foo.ts", content: "bar" } }],
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { filePath: "foo.ts" } }],
			},
		];
		Object.freeze(msgs);
		Object.freeze(msgs[0]);
		expect(() => supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG)).not.toThrow();
	});

	it("handles messages without filePath", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w1", name: "write", arguments: { content: "bar" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG);
		expect(result).toEqual(msgs);
	});

	it("replaces tool result content for superseded calls", () => {
		const msgs: AgentMessage[] = [
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "w1", name: "write", arguments: { filePath: "foo.ts", content: "bar" } }],
			},
			{
				role: "toolResult",
				toolCallId: "w1",
				toolName: "write",
				content: [{ type: "text", text: "success" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				...BASE_ASSISTANT_MSG,
				content: [{ type: "toolCall", id: "r1", name: "read", arguments: { filePath: "foo.ts" } }],
			},
		];
		const result = supersedeWrites(msgs, createDCPState(), DEFAULT_SUPERSEDE_WRITES_CONFIG);
		expect((result[1] as any).content[0].text).toBe("[Write output superseded - file was subsequently read]");
	});
});
