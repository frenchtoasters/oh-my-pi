import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { DCPConfig } from "../../src/session/compaction/dcp-config";
import { createDCPState, registerToolCall } from "../../src/session/compaction/dcp-state";
import { createDCPTransform } from "../../src/session/compaction/dcp-transform";

const usage = {
	input: 100,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function generateSession(count: number): { messages: AgentMessage[]; state: ReturnType<typeof createDCPState> } {
	const state = createDCPState();
	state.currentTurn = 100;
	const now = Date.now();
	const messages: AgentMessage[] = [];

	for (let i = 0; i < count; i++) {
		const idx = i % 5;
		if (idx === 0) {
			// User message
			messages.push({ role: "user", content: `Question ${i}`, timestamp: now } as unknown as AgentMessage);
		} else if (idx === 1) {
			// Assistant with tool call
			const toolId = `t${i}`;
			const toolName = i % 20 === 1 ? "grep" : `tool_${i % 7}`;
			const args = { query: i % 20 === 1 ? "duplicate-search" : `unique-${i}`, filePath: `/tmp/file${i}.ts` };
			messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id: toolId, name: toolName, arguments: args }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage,
				stopReason: "end_turn",
				timestamp: now,
			} as unknown as AgentMessage);
			registerToolCall(state, toolId, {
				tool: toolName,
				parameters: args,
				status: i % 15 === 0 ? "error" : "success",
				turn: Math.floor(i / 5),
				tokenCount: 50,
			});
		} else if (idx === 2) {
			// Tool result
			const toolId = `t${i - 1}`;
			messages.push({
				role: "toolResult",
				toolCallId: toolId,
				toolName: `tool_${(i - 1) % 7}`,
				content: [{ type: "text", text: `Result for query ${i}: ${"x".repeat(200)}` }],
				isError: (i - 1) % 15 === 0,
				timestamp: now,
			} as unknown as AgentMessage);
		} else if (idx === 3) {
			// Assistant text
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: `Analysis of result ${i}: ${"y".repeat(300)}` }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage,
				stopReason: "end_turn",
				timestamp: now,
			} as unknown as AgentMessage);
		} else {
			// Developer message
			messages.push({ role: "developer", content: `System note ${i}`, timestamp: now } as unknown as AgentMessage);
		}
	}

	return { messages, state };
}

describe("DCP Performance", () => {
	it("should process 1000 messages in under 50ms", async () => {
		const { messages, state } = generateSession(1000);
		const config = defaultConfig();
		const transform = createDCPTransform(state, config);

		// Warm up
		await transform(messages.slice(0, 10));

		// Measure
		const start = performance.now();
		const output = await transform(messages);
		const elapsed = performance.now() - start;

		expect(output.length).toBeGreaterThan(0);
		expect(output.length).toBeLessThanOrEqual(messages.length);
		expect(elapsed).toBeLessThan(50);
	});

	it("should process 5000 messages in under 250ms", async () => {
		const { messages, state } = generateSession(5000);
		const config = defaultConfig();
		const transform = createDCPTransform(state, config);

		// Warm up
		await transform(messages.slice(0, 10));

		const start = performance.now();
		const output = await transform(messages);
		const elapsed = performance.now() - start;

		expect(output.length).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(250);
	});

	it("should be O(n) — doubling messages should roughly double time", async () => {
		const config = defaultConfig();

		const small = generateSession(500);
		const large = generateSession(1000);

		const transformSmall = createDCPTransform(small.state, config);
		const transformLarge = createDCPTransform(large.state, config);

		// Warm up
		await transformSmall(small.messages.slice(0, 10));
		await transformLarge(large.messages.slice(0, 10));

		const startSmall = performance.now();
		await transformSmall(small.messages);
		const elapsedSmall = performance.now() - startSmall;

		const startLarge = performance.now();
		await transformLarge(large.messages);
		const elapsedLarge = performance.now() - startLarge;

		// Ratio should be roughly 2x (allow up to 4x for overhead)
		const ratio = elapsedLarge / Math.max(elapsedSmall, 0.01);
		expect(ratio).toBeLessThan(4);
	});
});
