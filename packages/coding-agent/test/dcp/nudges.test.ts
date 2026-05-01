import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createDCPState, type DCPState } from "../../src/session/compaction/dcp-state";
import {
	createNudgeMessage,
	injectNudge,
	type NudgeConfig,
	shouldInjectNudge,
} from "../../src/session/compaction/nudges";

function makeState(overrides?: Partial<DCPState>): DCPState {
	return { ...createDCPState(), ...overrides };
}

function defaultConfig(overrides?: Partial<NudgeConfig>): NudgeConfig {
	return {
		enabled: true,
		maxContextLimit: 100_000,
		minContextLimit: 50_000,
		frequency: 5,
		iterationThreshold: 15,
		...overrides,
	};
}

describe("Nudge System", () => {
	it("should return context_limit when over max limit", () => {
		const state = makeState({ nudgeCallCount: 0 });
		const config = defaultConfig();
		const result = shouldInjectNudge(state, config, 120_000, 0, false);
		expect(result).toBe("context_limit");
	});

	it("should return turn when over min limit, at boundary, and frequency passes", () => {
		const state = makeState({ nudgeCallCount: 4 }); // 5th call
		const config = defaultConfig();
		const result = shouldInjectNudge(state, config, 60_000, 0, true);
		expect(result).toBe("turn");
	});

	it("should return iteration when over min limit, threshold met, and frequency passes", () => {
		// nudgeCallCount is only incremented at turn boundaries, so set to 4
		// and call with isAtTurnBoundary=false — counter stays at 4 (not divisible by 5).
		// Use nudgeCallCount=0 (already divisible by 5 after increment at boundary).
		const state = makeState({ nudgeCallCount: 5 }); // already at frequency multiple
		const config = defaultConfig();
		// isAtTurnBoundary=false so counter won't increment, but 5 % 5 === 0 passes
		const result = shouldInjectNudge(state, config, 60_000, 20, false);
		expect(result).toBe("iteration");
	});

	it("should return null when below min threshold", () => {
		const state = makeState({ nudgeCallCount: 0 });
		const config = defaultConfig();
		const result = shouldInjectNudge(state, config, 30_000, 0, false);
		expect(result).toBeNull();
	});

	it("should return null on non-frequency call", () => {
		const state = makeState({ nudgeCallCount: 3 }); // 4th call, frequency 5
		const config = defaultConfig();
		const result = shouldInjectNudge(state, config, 60_000, 0, true);
		expect(result).toBeNull();
	});

	it("should ignore frequency for context limit", () => {
		const state = makeState({ nudgeCallCount: 0 }); // 1st call, frequency 5
		const config = defaultConfig();
		const result = shouldInjectNudge(state, config, 120_000, 0, false);
		expect(result).toBe("context_limit");
	});

	it("should return null when disabled", () => {
		const state = makeState({ nudgeCallCount: 4 });
		const config = defaultConfig({ enabled: false });
		const result = shouldInjectNudge(state, config, 120_000, 0, false);
		expect(result).toBeNull();
	});

	it("createNudgeMessage returns developer message", () => {
		const msg = createNudgeMessage("context_limit");
		expect(msg.role).toBe("developer");
		expect(typeof (msg as any).content).toBe("string");
		expect((msg as any).content.length).toBeGreaterThan(0);
	});

	it("injectNudge returns new array with message appended", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }];
		const nudge: AgentMessage = { role: "developer", content: "nudge", timestamp: 2 };
		const result = injectNudge(messages, nudge);
		expect(result).toHaveLength(2);
		expect(result[1]).toBe(nudge);
		expect(messages).toHaveLength(1); // Original unchanged
	});
});
