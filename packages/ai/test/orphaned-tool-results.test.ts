import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai/types";

/**
 * Regression test for: "The number of toolResult blocks at messages.N.content
 * exceeds the number of toolUse blocks of previous turn."
 *
 * When compaction removes an assistant message but leaves its tool_result
 * messages, transformMessages must silently drop the orphaned tool_results.
 */

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-3-5-sonnet-20241022",
	name: "Claude 3.5 Sonnet",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: true,
};

const usage = {
	input: 100,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistant(toolCalls: { id: string; name: string }[], stopReason: string = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls.map(tc => ({
			type: "toolCall" as const,
			id: tc.id,
			name: tc.name,
			arguments: {},
		})),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		usage,
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function makeToolResult(toolCallId: string, text: string = "result", isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "tool",
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

describe("Orphaned Tool Results", () => {
	it("drops tool_result after user message (no preceding assistant)", () => {
		const messages: Message[] = [{ role: "user", content: "hi", timestamp: Date.now() }, makeToolResult("orphan_1")];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(m => m.role === "toolResult");
		expect(toolResults).toHaveLength(0);
		expect(transformed).toHaveLength(1);
	});

	it("drops tool_result after assistant with no tool calls", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "Here is my answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-3-5-sonnet-20241022",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			} as AssistantMessage,
			makeToolResult("orphan_1"),
		];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(m => m.role === "toolResult");
		expect(toolResults).toHaveLength(0);
	});

	it("drops tool_result with non-matching tool call ID", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			makeAssistant([{ id: "tool_real", name: "read" }]),
			makeToolResult("tool_orphan"),
		];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(m => m.role === "toolResult") as ToolResultMessage[];

		// Orphan dropped; synthetic "No result provided" injected for the real tool call
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("tool_real");
		const content0 = toolResults[0].content[0];
		expect(content0.type).toBe("text");
		expect((content0 as TextContent).text).toContain("No result provided");
	});

	it("keeps valid tool_results and drops orphaned ones in mixed sequence", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			makeAssistant([{ id: "tool_valid", name: "read" }]),
			makeToolResult("tool_valid", "valid result"),
			makeToolResult("tool_orphan", "orphan result"),
		];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(m => m.role === "toolResult") as ToolResultMessage[];

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("tool_valid");
	});

	it("drops tool_result at start of message array", () => {
		const messages: Message[] = [makeToolResult("orphan_1")];

		const transformed = transformMessages(messages, model);
		expect(transformed).toHaveLength(0);
	});

	it("drops multiple consecutive orphaned tool_results", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			makeToolResult("orphan_1"),
			makeToolResult("orphan_2"),
			makeToolResult("orphan_3"),
		];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(m => m.role === "toolResult");
		expect(toolResults).toHaveLength(0);
		expect(transformed).toHaveLength(1);
	});

	it("keeps valid tool_result when developer message separates assistant from its result", () => {
		const messages: Message[] = [
			makeAssistant([{ id: "tool_valid", name: "read" }]),
			{ role: "developer", content: "guidance text", timestamp: Date.now() },
			makeToolResult("tool_valid", "valid result"),
		];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(m => m.role === "toolResult") as ToolResultMessage[];

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("tool_valid");
	});

	it("keeps tool_result for aborted assistant (regression guard)", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: Date.now() },
			makeAssistant([{ id: "tool_aborted", name: "read" }], "aborted"),
			makeToolResult("tool_aborted", "Partial result"),
		];

		const transformed = transformMessages(messages, model);
		const toolResults = transformed.filter(m => m.role === "toolResult") as ToolResultMessage[];

		expect(toolResults).toHaveLength(1);
		const content0 = toolResults[0].content[0];
		expect(content0.type).toBe("text");
		expect((content0 as TextContent).text).toBe("Partial result");
	});
});
