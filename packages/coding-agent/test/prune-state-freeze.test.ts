import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { computePruneState, type PruneConfig } from "../src/session/compaction/strategies/prune-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantWithToolCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "tool_use",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as unknown as AgentMessage;
}

function toolResult(toolCallId: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as AgentMessage;
}

const baseConfig: PruneConfig = {
	deduplication: {
		protectedTools: [],
		protectedFilePatterns: [],
		turnProtectionTurns: 1,
	},
	purgeErrors: {
		turnThreshold: 2,
		protectedTools: [],
	},
	supersedeWrites: {
		protectedFilePatterns: [],
		writeTools: ["write"],
		readTools: ["read"],
	},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prune-state freeze-prefix", () => {
	describe("deduplication respects frozenBeforeIndex", () => {
		it("does NOT deduplicate tool calls at indices below frozenBeforeIndex", () => {
			// Messages: [user, assistant(tc-1, bash), result, user, assistant(tc-2, bash same args), result]
			// tc-1 is at message index 1, tc-2 at index 4 — both have same signature
			const messages: AgentMessage[] = [
				userMsg("first"),
				assistantWithToolCall("tc-1", "bash", { command: "echo hi" }),
				toolResult("tc-1", "hi"),
				userMsg("second"),
				assistantWithToolCall("tc-2", "bash", { command: "echo hi" }),
				toolResult("tc-2", "hi"),
			];

			// Without freeze: tc-1 (at index 1, turn 0) should be deduped at currentTurn=5
			const unfrozen = computePruneState(messages, 5, baseConfig, 0);
			expect(unfrozen.dedupRemovedIds.has("tc-1")).toBe(true);

			// With frozenBeforeIndex=3: tc-1 is at index 1 < 3, so it should be protected
			const frozen = computePruneState(messages, 5, baseConfig, 3);
			expect(frozen.dedupRemovedIds.has("tc-1")).toBe(false);
			// tc-2 is the latest, so it's never removed (it's the "kept" one)
			expect(frozen.dedupRemovedIds.has("tc-2")).toBe(false);
		});

		it("deduplicates tool calls at indices >= frozenBeforeIndex", () => {
			// Three duplicate calls — freeze protects only the first
			const messages: AgentMessage[] = [
				userMsg("first"),
				assistantWithToolCall("tc-1", "bash", { command: "echo hi" }),
				toolResult("tc-1", "hi"),
				userMsg("second"),
				assistantWithToolCall("tc-2", "bash", { command: "echo hi" }),
				toolResult("tc-2", "hi"),
				userMsg("third"),
				assistantWithToolCall("tc-3", "bash", { command: "echo hi" }),
				toolResult("tc-3", "hi"),
			];

			// frozenBeforeIndex=3 protects tc-1 (index 1) but not tc-2 (index 4)
			const state = computePruneState(messages, 10, baseConfig, 3);
			expect(state.dedupRemovedIds.has("tc-1")).toBe(false); // frozen
			expect(state.dedupRemovedIds.has("tc-2")).toBe(true); // unfrozen duplicate
			expect(state.dedupRemovedIds.has("tc-3")).toBe(false); // latest kept
		});
	});

	describe("error-purge respects frozenBeforeIndex", () => {
		it("does NOT purge error tool calls at indices below frozenBeforeIndex", () => {
			const messages: AgentMessage[] = [
				userMsg("first"),
				assistantWithToolCall("tc-1", "bash", { command: "bad" }),
				toolResult("tc-1", "error: command failed", true),
				userMsg("next"),
				assistantWithToolCall("tc-2", "bash", { command: "good" }),
				toolResult("tc-2", "ok"),
			];

			// Without freeze: tc-1 errored at turn 0, currentTurn=5, threshold=2 → purge
			const unfrozen = computePruneState(messages, 5, baseConfig, 0);
			expect(unfrozen.errorPurgedIds.has("tc-1")).toBe(true);

			// With frozenBeforeIndex=3: tc-1 is at index 1 < 3 → protected
			const frozen = computePruneState(messages, 5, baseConfig, 3);
			expect(frozen.errorPurgedIds.has("tc-1")).toBe(false);
		});
	});

	describe("supersede-writes respects frozenBeforeIndex", () => {
		it("does NOT supersede writes at indices below frozenBeforeIndex", () => {
			const messages: AgentMessage[] = [
				userMsg("first"),
				assistantWithToolCall("tc-write", "write", { path: "foo.ts", content: "old" }),
				toolResult("tc-write", "ok"),
				userMsg("second"),
				assistantWithToolCall("tc-read", "read", { path: "foo.ts" }),
				toolResult("tc-read", "new content"),
			];

			// Without freeze: write at index 1, read at index 4 → superseded
			const unfrozen = computePruneState(messages, 5, baseConfig, 0);
			expect(unfrozen.supersededIds.has("tc-write")).toBe(true);

			// With frozenBeforeIndex=3: write at index 1 < 3 → protected
			const frozen = computePruneState(messages, 5, baseConfig, 3);
			expect(frozen.supersededIds.has("tc-write")).toBe(false);
		});

		it("supersedes writes at indices >= frozenBeforeIndex", () => {
			const messages: AgentMessage[] = [
				userMsg("first"),
				assistantWithToolCall("tc-write-old", "write", { path: "foo.ts", content: "old" }),
				toolResult("tc-write-old", "ok"),
				userMsg("second"),
				assistantWithToolCall("tc-write-new", "write", { path: "foo.ts", content: "new" }),
				toolResult("tc-write-new", "ok"),
				userMsg("third"),
				assistantWithToolCall("tc-read", "read", { path: "foo.ts" }),
				toolResult("tc-read", "content"),
			];

			// frozenBeforeIndex=3: tc-write-old (index 1) frozen, tc-write-new (index 4) not frozen
			const state = computePruneState(messages, 5, baseConfig, 3);
			expect(state.supersededIds.has("tc-write-old")).toBe(false); // frozen
			expect(state.supersededIds.has("tc-write-new")).toBe(true); // unfrozen, superseded by read at 7
		});
	});

	describe("frozenBeforeIndex advances correctly", () => {
		it("after advancing frozenBeforeIndex, previously-unfrozen IDs below new threshold are protected", () => {
			const messages: AgentMessage[] = [
				userMsg("first"),
				assistantWithToolCall("tc-1", "bash", { command: "echo hi" }),
				toolResult("tc-1", "hi"),
				userMsg("second"),
				assistantWithToolCall("tc-2", "bash", { command: "echo hi" }),
				toolResult("tc-2", "hi"),
				userMsg("third"),
				assistantWithToolCall("tc-3", "bash", { command: "echo hi" }),
				toolResult("tc-3", "hi"),
			];

			// Initially frozen at 0 → tc-1 and tc-2 are duplicates, tc-1 is pruned
			const state1 = computePruneState(messages, 10, baseConfig, 0);
			expect(state1.dedupRemovedIds.has("tc-1")).toBe(true);
			expect(state1.dedupRemovedIds.has("tc-2")).toBe(true);

			// Advance frozenBeforeIndex to 6 (simulating post-compaction)
			// Now tc-1 (index 1) and tc-2 (index 4) are both frozen
			const state2 = computePruneState(messages, 10, baseConfig, 6);
			expect(state2.dedupRemovedIds.has("tc-1")).toBe(false);
			expect(state2.dedupRemovedIds.has("tc-2")).toBe(false);
			expect(state2.dedupRemovedIds.has("tc-3")).toBe(false); // latest, never pruned
		});
	});

	it("returns frozenBeforeIndex in the state", () => {
		const messages: AgentMessage[] = [userMsg("hello")];
		const state = computePruneState(messages, 0, baseConfig, 7);
		expect(state.frozenBeforeIndex).toBe(7);
	});
});
