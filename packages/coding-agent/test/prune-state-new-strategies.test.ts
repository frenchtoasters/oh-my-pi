import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { applyPruneState, computePruneState, type PruneConfig } from "../src/session/compaction/strategies/prune-state";

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

function toolResult(
	toolCallId: string,
	text: string,
	opts?: { isError?: boolean; toolName?: string; details?: Record<string, unknown> },
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: opts?.toolName ?? "bash",
		content: [{ type: "text", text }],
		isError: opts?.isError ?? false,
		details: opts?.details,
		timestamp: Date.now(),
	} as AgentMessage;
}

const configWithNewStrategies: PruneConfig = {
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
		writeTools: ["write", "edit"],
		readTools: ["read"],
	},
	supersedeReads: {
		writeTools: ["write", "edit"],
		readTools: ["read"],
		turnProtection: 2,
	},
	collapseBashRetries: {
		minConsecutiveFailures: 2,
		turnProtection: 1,
	},
	directoryListingExpiry: {
		turnThreshold: 2,
		readTools: ["read"],
	},
};

// ---------------------------------------------------------------------------
// Supersede stale reads
// ---------------------------------------------------------------------------

describe("prune-state: supersede stale reads", () => {
	it("stubs a read result when a later write targets the same file", () => {
		const messages: AgentMessage[] = [
			userMsg("read foo"),
			assistantWithToolCall("r1", "read", { path: "src/foo.ts" }),
			toolResult("r1", "const x = 1;", { toolName: "read" }),
			userMsg("edit foo"),
			assistantWithToolCall("w1", "edit", { path: "src/foo.ts", edits: [] }),
			toolResult("w1", "ok", { toolName: "edit" }),
			userMsg("next task"),
			assistantWithToolCall("r2", "read", { path: "src/bar.ts" }),
			toolResult("r2", "const y = 2;", { toolName: "read" }),
		];

		// currentTurn = 4 (4 assistant messages counted by turnAtIndex for the last position)
		const state = computePruneState(messages, 4, configWithNewStrategies);
		expect(state.supersededReadIds.has("r1")).toBe(true);
		expect(state.supersededReadIds.has("r2")).toBe(false);

		const result = applyPruneState(messages, state);
		const r1Result = result.find(m => m.role === "toolResult" && (m as any).toolCallId === "r1");
		expect(r1Result).toBeDefined();
		expect((r1Result as any).content[0].text).toBe("[Read output superseded - file was subsequently modified]");
	});

	it("strips selector suffix when matching read paths to write paths", () => {
		const messages: AgentMessage[] = [
			userMsg("read foo range"),
			assistantWithToolCall("r1", "read", { path: "src/foo.ts:50-100" }),
			toolResult("r1", "some content", { toolName: "read" }),
			userMsg("edit foo"),
			assistantWithToolCall("w1", "edit", { path: "src/foo.ts", edits: [] }),
			toolResult("w1", "ok", { toolName: "edit" }),
			userMsg("continue"),
			assistantWithToolCall("x1", "bash", { command: "echo done" }),
			toolResult("x1", "done", { toolName: "bash" }),
		];

		const state = computePruneState(messages, 4, configWithNewStrategies);
		expect(state.supersededReadIds.has("r1")).toBe(true);
	});

	it("protects reads within turnProtection window", () => {
		const messages: AgentMessage[] = [
			userMsg("read foo"),
			assistantWithToolCall("r1", "read", { path: "src/foo.ts" }),
			toolResult("r1", "const x = 1;", { toolName: "read" }),
			userMsg("edit foo"),
			assistantWithToolCall("w1", "edit", { path: "src/foo.ts", edits: [] }),
			toolResult("w1", "ok", { toolName: "edit" }),
		];

		// currentTurn = 2, turnProtection = 2, read is at turn 0 → diff is 2, not < 2
		// Actually: turn at r1's assistant msg index=1 → turnAtIndex counts assistant msgs before index 1 = 0
		// currentTurn - 0 = 2, which is not < turnProtection(2), so NOT protected
		const state = computePruneState(messages, 2, configWithNewStrategies);
		expect(state.supersededReadIds.has("r1")).toBe(true);

		// With currentTurn=1 → diff is 1, which is < 2, so protected
		const stateProtected = computePruneState(messages, 1, configWithNewStrategies);
		expect(stateProtected.supersededReadIds.has("r1")).toBe(false);
	});

	it("does not supersede reads when no later write exists for that file", () => {
		const messages: AgentMessage[] = [
			userMsg("read foo"),
			assistantWithToolCall("r1", "read", { path: "src/foo.ts" }),
			toolResult("r1", "const x = 1;", { toolName: "read" }),
			userMsg("read bar"),
			assistantWithToolCall("r2", "read", { path: "src/bar.ts" }),
			toolResult("r2", "const y = 2;", { toolName: "read" }),
			userMsg("next"),
			assistantWithToolCall("b1", "bash", { command: "echo hi" }),
			toolResult("b1", "hi", { toolName: "bash" }),
		];

		const state = computePruneState(messages, 4, configWithNewStrategies);
		expect(state.supersededReadIds.has("r1")).toBe(false);
		expect(state.supersededReadIds.has("r2")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Collapse bash retries
// ---------------------------------------------------------------------------

describe("prune-state: collapse bash retries", () => {
	it("collapses consecutive bash failures, keeping only the last", () => {
		const messages: AgentMessage[] = [
			userMsg("try build"),
			assistantWithToolCall("b1", "bash", { command: "bun build", cwd: "src" }),
			toolResult("b1", "error: cannot find module", { isError: true, toolName: "bash" }),
			userMsg("fix"),
			assistantWithToolCall("b2", "bash", { command: "bun build --fix", cwd: "src" }),
			toolResult("b2", "error: still broken", { isError: true, toolName: "bash" }),
			userMsg("try again"),
			assistantWithToolCall("b3", "bash", { command: "bun build --verbose", cwd: "src" }),
			toolResult("b3", "error: detailed failure", { isError: true, toolName: "bash" }),
			userMsg("investigate"),
			assistantWithToolCall("x1", "bash", { command: "echo done" }),
			toolResult("x1", "done", { toolName: "bash" }),
		];

		// currentTurn = 4 (4 assistant messages total), all bash failures at turns 0,1,2
		const state = computePruneState(messages, 4, configWithNewStrategies);
		// b1 and b2 should be collapsed (older failures in streak), b3 kept (last failure)
		expect(state.collapsedBashRetryIds.has("b1")).toBe(true);
		expect(state.collapsedBashRetryIds.has("b2")).toBe(true);
		expect(state.collapsedBashRetryIds.has("b3")).toBe(false);

		const result = applyPruneState(messages, state);
		const b1Result = result.find(m => m.role === "toolResult" && (m as any).toolCallId === "b1");
		expect((b1Result as any).content[0].text).toBe("[Bash failure collapsed - superseded by later retry]");
	});

	it("does not collapse when fewer than minConsecutiveFailures", () => {
		const messages: AgentMessage[] = [
			userMsg("try build"),
			assistantWithToolCall("b1", "bash", { command: "bun build", cwd: "src" }),
			toolResult("b1", "error: broken", { isError: true, toolName: "bash" }),
			userMsg("next"),
			assistantWithToolCall("x1", "bash", { command: "echo done" }),
			toolResult("x1", "done", { toolName: "bash" }),
		];

		const state = computePruneState(messages, 3, configWithNewStrategies);
		expect(state.collapsedBashRetryIds.size).toBe(0);
	});

	it("breaks streak on different cwd", () => {
		const messages: AgentMessage[] = [
			userMsg("build A"),
			assistantWithToolCall("b1", "bash", { command: "bun build", cwd: "pkgA" }),
			toolResult("b1", "error", { isError: true, toolName: "bash" }),
			userMsg("build B"),
			assistantWithToolCall("b2", "bash", { command: "bun build", cwd: "pkgB" }),
			toolResult("b2", "error", { isError: true, toolName: "bash" }),
			userMsg("build B again"),
			assistantWithToolCall("b3", "bash", { command: "bun build --fix", cwd: "pkgB" }),
			toolResult("b3", "error", { isError: true, toolName: "bash" }),
			userMsg("next"),
			assistantWithToolCall("x1", "bash", { command: "echo hi" }),
			toolResult("x1", "hi", { toolName: "bash" }),
		];

		const state = computePruneState(messages, 5, configWithNewStrategies);
		// b1 alone in pkgA streak (length 1, below min 2) — not collapsed
		expect(state.collapsedBashRetryIds.has("b1")).toBe(false);
		// b2 and b3 in pkgB streak (length 2, meets min) — b2 collapsed, b3 kept
		expect(state.collapsedBashRetryIds.has("b2")).toBe(true);
		expect(state.collapsedBashRetryIds.has("b3")).toBe(false);
	});

	it("protects recent turns from collapsing", () => {
		const messages: AgentMessage[] = [
			userMsg("build"),
			assistantWithToolCall("b1", "bash", { command: "bun build", cwd: "src" }),
			toolResult("b1", "error", { isError: true, toolName: "bash" }),
			userMsg("retry"),
			assistantWithToolCall("b2", "bash", { command: "bun build", cwd: "src" }),
			toolResult("b2", "error", { isError: true, toolName: "bash" }),
		];

		// currentTurn = 2, turnProtection = 1
		// b1 at turn 0 → diff 2, not < 1 → can collapse
		// b2 at turn 1 → diff 1, not < 1 → can collapse but it's the last in streak, so kept
		const state = computePruneState(messages, 2, configWithNewStrategies);
		expect(state.collapsedBashRetryIds.has("b1")).toBe(true);
		expect(state.collapsedBashRetryIds.has("b2")).toBe(false); // last in streak

		// currentTurn = 1, turnProtection = 1
		// b1 at turn 0 → diff 1, not < 1 → can collapse
		const stateEarly = computePruneState(messages, 1, configWithNewStrategies);
		expect(stateEarly.collapsedBashRetryIds.has("b1")).toBe(true);

		// currentTurn = 0 → both at turn 0, diff 0 < 1 → protected
		const stateProtected = computePruneState(messages, 0, configWithNewStrategies);
		expect(stateProtected.collapsedBashRetryIds.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Directory listing expiry
// ---------------------------------------------------------------------------

describe("prune-state: directory listing expiry", () => {
	it("stubs directory listing results older than turnThreshold", () => {
		const messages: AgentMessage[] = [
			userMsg("list dir"),
			assistantWithToolCall("d1", "read", { path: "src/tools/" }),
			toolResult("d1", "bash.ts\nread.ts\nedit.ts", { toolName: "read", details: { isDirectory: true } }),
			userMsg("now read a file"),
			assistantWithToolCall("r1", "read", { path: "src/tools/bash.ts" }),
			toolResult("r1", "export class BashTool {}", { toolName: "read" }),
			userMsg("do something"),
			assistantWithToolCall("b1", "bash", { command: "echo hi" }),
			toolResult("b1", "hi", { toolName: "bash" }),
		];

		// currentTurn = 3 (3 assistant msgs total), directory at turn 0 → diff 3 >= threshold 2
		const state = computePruneState(messages, 3, configWithNewStrategies);
		expect(state.expiredDirectoryListingIds.has("d1")).toBe(true);

		const result = applyPruneState(messages, state);
		const d1Result = result.find(m => m.role === "toolResult" && (m as any).toolCallId === "d1");
		expect((d1Result as any).content[0].text).toBe("[Directory listing expired - re-read if needed]");

		// The tool call args should be pruned with path preserved
		const d1Call = result.find(
			m => m.role === "assistant" && (m as any).content.some((c: any) => c.id === "d1"),
		) as any;
		const callContent = d1Call.content.find((c: any) => c.id === "d1");
		expect(callContent.arguments._pruned).toBe(true);
		expect(callContent.arguments._reason).toBe("expired-directory-listing");
		expect(callContent.arguments.path).toBe("src/tools/");
	});

	it("does not expire directory listings within turnThreshold", () => {
		const messages: AgentMessage[] = [
			userMsg("list dir"),
			assistantWithToolCall("d1", "read", { path: "src/" }),
			toolResult("d1", "tools/\nconfig/", { toolName: "read", details: { isDirectory: true } }),
			userMsg("next"),
			assistantWithToolCall("b1", "bash", { command: "echo hi" }),
			toolResult("b1", "hi", { toolName: "bash" }),
		];

		// currentTurn = 2, directory at turn 0 → diff 2, threshold 2 → NOT expired (< not <=)
		// Wait — the condition is `currentTurn - turn < config.turnThreshold`, so 2 < 2 = false → expired
		const state = computePruneState(messages, 2, configWithNewStrategies);
		expect(state.expiredDirectoryListingIds.has("d1")).toBe(true);

		// currentTurn = 1 → diff 1 < 2 → protected
		const stateProtected = computePruneState(messages, 1, configWithNewStrategies);
		expect(stateProtected.expiredDirectoryListingIds.has("d1")).toBe(false);
	});

	it("does not expire non-directory read results", () => {
		const messages: AgentMessage[] = [
			userMsg("read file"),
			assistantWithToolCall("r1", "read", { path: "src/foo.ts" }),
			toolResult("r1", "const x = 1;", { toolName: "read", details: { isDirectory: false } }),
			userMsg("next"),
			assistantWithToolCall("b1", "bash", { command: "echo hi" }),
			toolResult("b1", "hi", { toolName: "bash" }),
			userMsg("next2"),
			assistantWithToolCall("b2", "bash", { command: "echo bye" }),
			toolResult("b2", "bye", { toolName: "bash" }),
		];

		const state = computePruneState(messages, 4, configWithNewStrategies);
		expect(state.expiredDirectoryListingIds.has("r1")).toBe(false);
	});

	it("does not expire directory listings with no details", () => {
		const messages: AgentMessage[] = [
			userMsg("read dir"),
			assistantWithToolCall("r1", "read", { path: "src/" }),
			toolResult("r1", "files here", { toolName: "read" }),
			userMsg("next"),
			assistantWithToolCall("b1", "bash", { command: "echo hi" }),
			toolResult("b1", "hi", { toolName: "bash" }),
			userMsg("next2"),
			assistantWithToolCall("b2", "bash", { command: "echo bye" }),
			toolResult("b2", "bye", { toolName: "bash" }),
		];

		const state = computePruneState(messages, 4, configWithNewStrategies);
		expect(state.expiredDirectoryListingIds.has("r1")).toBe(false);
	});
});
