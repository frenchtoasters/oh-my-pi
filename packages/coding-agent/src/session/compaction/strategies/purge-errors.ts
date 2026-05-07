import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { turnAtIndex } from "./utils.js";

export interface PurgeErrorsConfig {
	turnThreshold: number;
	protectedTools: string[];
}

export function purgeErrorInputs(
	messages: AgentMessage[],
	currentTurn: number,
	config: PurgeErrorsConfig,
): AgentMessage[] {
	// Build a map from toolCallId -> {tool name, turn}
	const toolCallMeta = new Map<string, { tool: string; turn: number }>();

	messages.forEach((msg, msgIndex) => {
		if (msg.role === "assistant") {
			const turn = turnAtIndex(messages, msgIndex);
			msg.content.forEach(block => {
				if (block.type === "toolCall") {
					toolCallMeta.set(block.id, { tool: block.name, turn });
				}
			});
		}
	});

	// 1. Identify which tool calls to prune based on error results
	const prunedIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError) {
			const meta = toolCallMeta.get(message.toolCallId);

			if (!meta) continue;
			if (config.protectedTools.includes(meta.tool)) continue;
			if (currentTurn - meta.turn < config.turnThreshold) continue;

			prunedIds.add(message.toolCallId);
		}
	}

	if (prunedIds.size === 0) {
		return messages;
	}

	// 2. Replace pruned tool call arguments (keep the call, blank its inputs)
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
