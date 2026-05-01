import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { DCPState, ToolParameterEntry } from "../../src/session/compaction/dcp-state";
import { type PurgeErrorsConfig, purgeErrorInputs } from "../../src/session/compaction/strategies/purge-errors";

function createAssistantMessage(content: any[]): AgentMessage {
	return {
		role: "assistant",
		content,
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
	} as any;
}

function createToolResultMessage(toolCallId: string, isError: boolean): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "test-tool",
		content: [{ type: "text", text: "error details" }],
		isError,
		timestamp: Date.now(),
	} as any;
}

function createState(toolParameters: Map<string, ToolParameterEntry> = new Map()): DCPState {
	return {
		toolParameters,
		pruneTools: new Map(),
		currentTurn: 6,
		stats: { totalPrunedTokens: 0 },
	} as any;
}

describe("purgeErrorInputs", () => {
	const config: PurgeErrorsConfig = {
		enabled: true,
		turnThreshold: 4,
		protectedTools: ["protected-tool"],
	};

	it("returns messages unchanged when disabled", () => {
		const messages: AgentMessage[] = [];
		const state = createState();
		const result = purgeErrorInputs(messages, state, { ...config, enabled: false });
		expect(result).toBe(messages);
	});

	it("purges tool call arguments for old errored calls", () => {
		const toolCallId = "tc-1";
		const entry: ToolParameterEntry = {
			tool: "test-tool",
			parameters: { foo: "bar" },
			status: "error",
			turn: 1, // 5 turns ago (current 6)
			tokenCount: 100,
		};

		const state = createState(new Map([[toolCallId, entry]]));

		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "toolCall", id: toolCallId, name: "test-tool", arguments: { foo: "bar" } }]),
			createToolResultMessage(toolCallId, true),
		];

		const result = purgeErrorInputs(messages, state, config);

		const assistantMsg = result[0] as any;
		expect(assistantMsg.content[0].arguments).toEqual({ _pruned: true, _reason: "error-input-purged" });
		expect(result[1]).toEqual(messages[1]);
	});

	it("preserves error message in tool result", () => {
		const toolCallId = "tc-1";
		const entry: ToolParameterEntry = {
			tool: "test-tool",
			parameters: { foo: "bar" },
			status: "error",
			turn: 1,
			tokenCount: 100,
		};

		const state = createState(new Map([[toolCallId, entry]]));

		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "toolCall", id: toolCallId, name: "test-tool", arguments: { foo: "bar" } }]),
			createToolResultMessage(toolCallId, true),
		];

		const result = purgeErrorInputs(messages, state, config);
		expect((result[1] as any).content).toEqual([{ type: "text", text: "error details" }]);
	});

	it("skips recent errors within turn threshold", () => {
		const toolCallId = "tc-1";
		const entry: ToolParameterEntry = {
			tool: "test-tool",
			parameters: { foo: "bar" },
			status: "error",
			turn: 4, // 2 turns ago (current 6)
			tokenCount: 100,
		};

		const state = createState(new Map([[toolCallId, entry]]));

		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "toolCall", id: toolCallId, name: "test-tool", arguments: { foo: "bar" } }]),
			createToolResultMessage(toolCallId, true),
		];

		const result = purgeErrorInputs(messages, state, config);
		expect((result[0] as any).content[0].arguments).toEqual({ foo: "bar" });
	});

	it("respects protected tools", () => {
		const toolCallId = "tc-1";
		const entry: ToolParameterEntry = {
			tool: "protected-tool",
			parameters: { foo: "bar" },
			status: "error",
			turn: 1,
			tokenCount: 100,
		};

		const state = createState(new Map([[toolCallId, entry]]));

		const messages: AgentMessage[] = [
			createAssistantMessage([
				{ type: "toolCall", id: toolCallId, name: "protected-tool", arguments: { foo: "bar" } },
			]),
			createToolResultMessage(toolCallId, true),
		];

		const result = purgeErrorInputs(messages, state, config);
		expect((result[0] as any).content[0].arguments).toEqual({ foo: "bar" });
	});

	it("does not mutate input", () => {
		const toolCallId = "tc-1";
		const entry: ToolParameterEntry = {
			tool: "test-tool",
			parameters: { foo: "bar" },
			status: "error",
			turn: 1,
			tokenCount: 100,
		};

		const state = createState(new Map([[toolCallId, entry]]));

		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "toolCall", id: toolCallId, name: "test-tool", arguments: { foo: "bar" } }]),
			createToolResultMessage(toolCallId, true),
		];

		Object.freeze(messages);
		Object.freeze(messages[0]);
		Object.freeze((messages[0] as any).content[0]);

		const result = purgeErrorInputs(messages, state, config);
		expect(result).not.toBe(messages);
	});

	it("handles errored call not in state", () => {
		const state = createState();

		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "toolCall", id: "tc-1", name: "test-tool", arguments: { foo: "bar" } }]),
			createToolResultMessage("tc-1", true),
		];

		const result = purgeErrorInputs(messages, state, config);
		expect((result[0] as any).content[0].arguments).toEqual({ foo: "bar" });
	});

	it("is idempotent", () => {
		const toolCallId = "tc-1";
		const entry: ToolParameterEntry = {
			tool: "test-tool",
			parameters: { foo: "bar" },
			status: "error",
			turn: 1,
			tokenCount: 100,
		};

		const state = createState(new Map([[toolCallId, entry]]));

		const messages: AgentMessage[] = [
			createAssistantMessage([{ type: "toolCall", id: toolCallId, name: "test-tool", arguments: { foo: "bar" } }]),
			createToolResultMessage(toolCallId, true),
		];

		const result1 = purgeErrorInputs(messages, state, config);
		const result2 = purgeErrorInputs(result1, state, config);

		expect(result2).toEqual(result1);
	});

	it("handles multiple errored calls", () => {
		const toolCallId1 = "tc-1";
		const toolCallId2 = "tc-2";
		const entry1: ToolParameterEntry = {
			tool: "test-tool",
			parameters: { foo: "bar" },
			status: "error",
			turn: 1,
			tokenCount: 100,
		};
		const entry2: ToolParameterEntry = {
			tool: "test-tool",
			parameters: { baz: "qux" },
			status: "error",
			turn: 1,
			tokenCount: 100,
		};

		const state = createState(
			new Map([
				[toolCallId1, entry1],
				[toolCallId2, entry2],
			]),
		);

		const messages: AgentMessage[] = [
			createAssistantMessage([
				{ type: "toolCall", id: toolCallId1, name: "test-tool", arguments: { foo: "bar" } },
				{ type: "toolCall", id: toolCallId2, name: "test-tool", arguments: { baz: "qux" } },
			]),
			createToolResultMessage(toolCallId1, true),
			createToolResultMessage(toolCallId2, true),
		];

		const result = purgeErrorInputs(messages, state, config);

		const assistantMsg = result[0] as any;
		expect(assistantMsg.content[0].arguments).toEqual({ _pruned: true, _reason: "error-input-purged" });
		expect(assistantMsg.content[1].arguments).toEqual({ _pruned: true, _reason: "error-input-purged" });
	});
});
