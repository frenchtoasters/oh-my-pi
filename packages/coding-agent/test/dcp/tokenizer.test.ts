import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { countTokens, countTokensForMessages } from "../../src/session/compaction/tokenizer";

describe("countTokens", () => {
	test("returns accurate count for anthropic provider", () => {
		const count = countTokens("hello world", "anthropic");
		// Anthropic tokenizer should give a known value — "hello world" is typically 2 tokens
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThan(10); // sanity check
	});

	test("returns chars/4 heuristic for openai provider", () => {
		const text = "hello world test"; // 16 chars → ceil(16/4) = 4
		expect(countTokens(text, "openai")).toBe(4);
	});

	test("defaults to heuristic when no provider specified", () => {
		const text = "hello world test"; // 16 chars → ceil(16/4) = 4
		expect(countTokens(text)).toBe(4);
	});

	test("returns 0 for empty string", () => {
		expect(countTokens("")).toBe(0);
		expect(countTokens("", "anthropic")).toBe(0);
	});

	test("handles large strings efficiently", () => {
		const longString = "a".repeat(100_000);
		const start = performance.now();
		const count = countTokens(longString);
		const elapsed = performance.now() - start;
		expect(count).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(50); // generous budget
	});
});

describe("countTokensForMessages", () => {
	test("sums tokens across message content", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello world", timestamp: Date.now() },
			{ role: "user", content: "another message", timestamp: Date.now() },
		];
		const count = countTokensForMessages(messages);
		expect(count).toBeGreaterThan(0);
	});

	test("returns 0 for empty array", () => {
		expect(countTokensForMessages([])).toBe(0);
	});

	test("handles assistant messages with tool calls", () => {
		// We cast to any for this test case structure as specified
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me help" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { filePath: "/test.ts" } },
				],
				api: "messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: { input: 0, output: 0, totalTokens: 0, cost: {} },
				stopReason: "tool_use",
				timestamp: Date.now(),
			} as any,
		];
		const count = countTokensForMessages(messages);
		expect(count).toBeGreaterThan(0);
	});

	test("handles tool result messages", () => {
		const messages: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: "file content here" }],
				isError: false,
				timestamp: Date.now(),
			} as any,
		];
		const count = countTokensForMessages(messages);
		expect(count).toBeGreaterThan(0);
	});
});
