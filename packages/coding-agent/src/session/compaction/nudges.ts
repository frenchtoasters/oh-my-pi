import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import nudgeContextLimitPrompt from "../../prompts/compaction/nudge-context-limit.md" with { type: "text" };
import nudgeIterationPrompt from "../../prompts/compaction/nudge-iteration.md" with { type: "text" };
import nudgeTurnPrompt from "../../prompts/compaction/nudge-turn.md" with { type: "text" };
import type { DCPState } from "./dcp-state";

export type NudgeType = "context_limit" | "turn" | "iteration";

export interface NudgeConfig {
	enabled: boolean;
	maxContextLimit: number;
	minContextLimit: number;
	frequency: number;
	iterationThreshold: number;
}

export function shouldInjectNudge(
	state: DCPState,
	config: NudgeConfig,
	tokenCount: number,
	messagesSinceLastUser: number,
	isAtTurnBoundary: boolean,
): NudgeType | null {
	if (!config.enabled) {
		return null;
	}

	if (tokenCount > config.maxContextLimit) {
		return "context_limit";
	}

	// Only increment the frequency counter at turn boundaries, not on every
	// transform invocation (which runs per-tool-call within a single turn).
	if (isAtTurnBoundary) {
		state.nudgeCallCount++;
	}

	if (state.nudgeCallCount === 0 || state.nudgeCallCount % config.frequency !== 0) {
		return null;
	}

	if (tokenCount > config.minContextLimit && isAtTurnBoundary) {
		return "turn";
	}

	if (tokenCount > config.minContextLimit && messagesSinceLastUser > config.iterationThreshold) {
		return "iteration";
	}

	return null;
}

export function createNudgeMessage(type: NudgeType): AgentMessage {
	let nudgeText: string;
	switch (type) {
		case "context_limit":
			nudgeText = nudgeContextLimitPrompt;
			break;
		case "turn":
			nudgeText = nudgeTurnPrompt;
			break;
		case "iteration":
			nudgeText = nudgeIterationPrompt;
			break;
		default:
			throw new Error(`Unknown nudge type: ${type}`);
	}

	return {
		role: "developer",
		content: nudgeText,
		timestamp: Date.now(),
	};
}

export function injectNudge(messages: AgentMessage[], nudgeMsg: AgentMessage): AgentMessage[] {
	return [...messages, nudgeMsg];
}
