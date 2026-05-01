import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createDCPState, registerToolCall } from "../../src/session/compaction/dcp-state";
import { type DeduplicationConfig, deduplicateToolCalls } from "../../src/session/compaction/strategies/deduplication";

function createMockAssistantMessage(toolCalls: any[]): AgentMessage {
	return {
		role: "assistant",
		content: toolCalls,
		timestamp: Date.now(),
	} as any;
}

function createMockToolResult(toolCallId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "test-tool",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: Date.now(),
	} as any;
}

describe("deduplication strategy", () => {
	it("returns messages unchanged when disabled", () => {
		const state = createDCPState();
		const config: DeduplicationConfig = {
			enabled: false,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};
		const msgs: AgentMessage[] = [createMockAssistantMessage([])];
		const result = deduplicateToolCalls(msgs, state, config);
		expect(result).toEqual(msgs);
	});

	it("deduplicates repeated tool calls keeping most recent", () => {
		const state = createDCPState();
		state.currentTurn = 10;
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};

		const tc1 = { type: "toolCall", id: "tc1", name: "read", arguments: { file: "a.ts" } };
		const tc2 = { type: "toolCall", id: "tc2", name: "read", arguments: { file: "a.ts" } };

		registerToolCall(state, "tc1", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 5,
			tokenCount: 10,
		});
		registerToolCall(state, "tc2", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});

		const msgs: AgentMessage[] = [createMockAssistantMessage([tc1]), createMockAssistantMessage([tc2])];

		const result = deduplicateToolCalls(msgs, state, config);
		expect(result.length).toBe(1);
		expect((result[0] as any).content[0].id).toBe("tc2");
	});

	it("removes both tool call and tool result (atomicity)", () => {
		const state = createDCPState();
		state.currentTurn = 10;
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};

		const tc1 = { type: "toolCall", id: "tc1", name: "read", arguments: { file: "a.ts" } };
		const tc2 = { type: "toolCall", id: "tc2", name: "read", arguments: { file: "a.ts" } };

		registerToolCall(state, "tc1", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 5,
			tokenCount: 10,
		});
		registerToolCall(state, "tc2", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});

		const msgs: AgentMessage[] = [
			createMockAssistantMessage([tc1]),
			createMockToolResult("tc1"),
			createMockAssistantMessage([tc2]),
			createMockToolResult("tc2"),
		];

		const result = deduplicateToolCalls(msgs, state, config);
		expect(result.length).toBe(2); // Only tc2 and its result
		expect((result[0] as any).content[0].id).toBe("tc2");
		expect((result[1] as any).toolCallId).toBe("tc2");
	});

	it("respects protected tools", () => {
		const state = createDCPState();
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: ["write"],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};

		const tc1 = { type: "toolCall", id: "tc1", name: "write", arguments: { file: "a.ts" } };
		const tc2 = { type: "toolCall", id: "tc2", name: "write", arguments: { file: "a.ts" } };

		registerToolCall(state, "tc1", {
			tool: "write",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 5,
			tokenCount: 10,
		});
		registerToolCall(state, "tc2", {
			tool: "write",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});

		const msgs: AgentMessage[] = [createMockAssistantMessage([tc1]), createMockAssistantMessage([tc2])];
		const result = deduplicateToolCalls(msgs, state, config);
		expect(result.length).toBe(2);
	});

	it("respects turn protection", () => {
		const state = createDCPState();
		state.currentTurn = 10;
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 2,
		};

		const tc1 = { type: "toolCall", id: "tc1", name: "read", arguments: { file: "a.ts" } };
		const tc2 = { type: "toolCall", id: "tc2", name: "read", arguments: { file: "a.ts" } };

		registerToolCall(state, "tc1", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});
		registerToolCall(state, "tc2", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});

		const msgs: AgentMessage[] = [createMockAssistantMessage([tc1]), createMockAssistantMessage([tc2])];
		const result = deduplicateToolCalls(msgs, state, config);
		expect(result.length).toBe(2); // Should not deduplicate because both are within protection turns
	});

	it("does not mutate input", () => {
		const state = createDCPState();
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};

		const msgs = Object.freeze([
			createMockAssistantMessage([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]),
		]) as AgentMessage[];

		expect(() => deduplicateToolCalls(msgs, state, config)).not.toThrow();
	});

	it("handles assistant messages where all tool calls removed", () => {
		const state = createDCPState();
		state.currentTurn = 10;
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};

		const tc1 = { type: "toolCall", id: "tc1", name: "read", arguments: { file: "a.ts" } };
		const tc2 = { type: "toolCall", id: "tc2", name: "read", arguments: { file: "a.ts" } };

		registerToolCall(state, "tc1", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 5,
			tokenCount: 10,
		});
		registerToolCall(state, "tc2", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});

		const msgs: AgentMessage[] = [
			createMockAssistantMessage([tc1]), // tc1 will be pruned
			createMockAssistantMessage([tc2]),
		];

		const result = deduplicateToolCalls(msgs, state, config);
		expect(result.length).toBe(1);
		expect((result[0] as any).content[0].id).toBe("tc2");
	});

	it("handles multiple signatures independently", () => {
		const state = createDCPState();
		state.currentTurn = 10;
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};

		const tc1 = { type: "toolCall", id: "tc1", name: "read", arguments: { file: "a.ts" } };
		const tc2 = { type: "toolCall", id: "tc2", name: "read", arguments: { file: "b.ts" } };
		const tc3 = { type: "toolCall", id: "tc3", name: "read", arguments: { file: "a.ts" } };

		registerToolCall(state, "tc1", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 5,
			tokenCount: 10,
		});
		registerToolCall(state, "tc2", {
			tool: "read",
			parameters: { file: "b.ts" },
			status: "success",
			turn: 5,
			tokenCount: 10,
		});
		registerToolCall(state, "tc3", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});

		const msgs: AgentMessage[] = [createMockAssistantMessage([tc1, tc2, tc3])];

		const result = deduplicateToolCalls(msgs, state, config);
		const assistantMsg = result[0] as any;
		expect(assistantMsg.content.length).toBe(2);
		// tc1 should be removed
		expect(assistantMsg.content.some((c: any) => c.id === "tc1")).toBe(false);
		expect(assistantMsg.content.some((c: any) => c.id === "tc2")).toBe(true);
		expect(assistantMsg.content.some((c: any) => c.id === "tc3")).toBe(true);
	});

	it("passes through non-tool messages unchanged", () => {
		const state = createDCPState();
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};
		const msgs: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() } as any];

		const result = deduplicateToolCalls(msgs, state, config);
		expect(result).toEqual(msgs);
	});

	it("is idempotent", () => {
		const state = createDCPState();
		state.currentTurn = 10;
		const config: DeduplicationConfig = {
			enabled: true,
			protectedTools: [],
			protectedFilePatterns: [],
			turnProtectionTurns: 0,
		};

		const tc1 = { type: "toolCall", id: "tc1", name: "read", arguments: { file: "a.ts" } };
		const tc2 = { type: "toolCall", id: "tc2", name: "read", arguments: { file: "a.ts" } };

		registerToolCall(state, "tc1", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 5,
			tokenCount: 10,
		});
		registerToolCall(state, "tc2", {
			tool: "read",
			parameters: { file: "a.ts" },
			status: "success",
			turn: 9,
			tokenCount: 10,
		});

		const msgs: AgentMessage[] = [createMockAssistantMessage([tc1]), createMockAssistantMessage([tc2])];

		const result1 = deduplicateToolCalls(msgs, state, config);
		const result2 = deduplicateToolCalls(result1, state, config);
		expect(result1).toEqual(result2);
	});
});
