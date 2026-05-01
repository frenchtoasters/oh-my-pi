import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type DCPState, markForPruning } from "../dcp-state";

export interface PurgeErrorsConfig {
	enabled: boolean;
	turnThreshold: number;
	protectedTools: string[];
}

export function purgeErrorInputs(messages: AgentMessage[], state: DCPState, config: PurgeErrorsConfig): AgentMessage[] {
	if (!config.enabled) {
		return messages;
	}

	const prunedIds = new Set<string>();

	// 1. Identify which tool calls to prune
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError) {
			const entry = state.toolParameters.get(message.toolCallId);

			if (!entry) {
				continue;
			}

			if (config.protectedTools.includes(entry.tool)) {
				continue;
			}

			if (state.currentTurn - entry.turn < config.turnThreshold) {
				continue;
			}

			// Mark in state for consistency
			markForPruning(state, message.toolCallId, entry.tokenCount);
			prunedIds.add(message.toolCallId);
		}
	}

	if (prunedIds.size === 0) {
		return messages;
	}

	// 2. Build new messages array with pruned tool call arguments
	return messages.map(message => {
		if (message.role === "assistant") {
			const hasPruned = message.content.some(c => c.type === "toolCall" && prunedIds.has(c.id));

			if (!hasPruned) return message;

			return {
				...message,
				content: message.content.map(c => {
					if (c.type === "toolCall" && prunedIds.has(c.id)) {
						return {
							...c,
							arguments: { _pruned: true, _reason: "error-input-purged" },
						};
					}
					return c;
				}),
			};
		}

		return message;
	});
}
