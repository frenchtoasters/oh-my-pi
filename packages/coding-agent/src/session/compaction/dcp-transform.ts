import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { filterCompressedRanges } from "./compression-blocks";
import type { DCPConfig } from "./dcp-config";
import { type DCPState, registerToolCall } from "./dcp-state";
import { assignMessageIds, injectMessageIdTags } from "./message-ids";
import { createNudgeMessage, injectNudge, shouldInjectNudge } from "./nudges";
import { deduplicateToolCalls } from "./strategies/deduplication";
import { purgeErrorInputs } from "./strategies/purge-errors";
import { supersedeWrites } from "./strategies/supersede-writes";
import { countTokens, countTokensForMessages } from "./tokenizer";
import type { TransformContextFn } from "./transform-compose";

export function createDCPTransform(state: DCPState, config: DCPConfig): TransformContextFn {
	if (!config.enabled) {
		return (messages: AgentMessage[]) => messages;
	}

	return (messages: AgentMessage[]) => {
		let currentMessages = messages;

		// 0. Sync tool parameters from message history into state
		syncToolParameters(currentMessages, state);

		// 2. Deduplication
		if (config.strategies.deduplication.enabled) {
			const before = currentMessages.length;
			currentMessages = deduplicateToolCalls(currentMessages, state, config.strategies.deduplication);
			logger.debug("DCP: Deduplication applied", { prunedCount: before - currentMessages.length });
		}

		// 3. Purge errors
		if (config.strategies.purgeErrors.enabled) {
			const before = currentMessages.length;
			currentMessages = purgeErrorInputs(currentMessages, state, config.strategies.purgeErrors);
			logger.debug("DCP: Purge errors applied", { prunedCount: before - currentMessages.length });
		}

		// 4. Supersede writes
		if (config.strategies.supersedeWrites.enabled) {
			const before = currentMessages.length;
			currentMessages = supersedeWrites(currentMessages, state, config.strategies.supersedeWrites);
			logger.debug("DCP: Supersede writes applied", { prunedCount: before - currentMessages.length });
		}

		// 5. Filter compressed ranges using the stable (pre-pruning) ID map
		const beforeCompression = currentMessages.length;
		const preFilterIdMap = assignMessageIds(currentMessages);
		currentMessages = filterCompressedRanges(currentMessages, state, preFilterIdMap);
		logger.debug("DCP: Compression ranges filtered", { prunedCount: beforeCompression - currentMessages.length });

		// 6. Re-assign message IDs after filtering (indices changed)
		const finalIdMap = assignMessageIds(currentMessages);

		// Store the final ID map in state for the compress tool to use
		state.lastAssignedIdMap = finalIdMap;

		// 7. Inject message ID tags into messages
		currentMessages = injectMessageIdTags(currentMessages, finalIdMap);
		logger.debug("DCP: Message IDs injected");

		// 8. Nudge injection (if configured)
		if (config.nudge?.enabled) {
			const tokenCount = countTokensForMessages(currentMessages);
			const messagesSinceLastUser = countMessagesSinceLastUser(currentMessages);
			const isAtTurnBoundary = isUserAssistantBoundary(messages);
			const nudgeType = shouldInjectNudge(state, config.nudge, tokenCount, messagesSinceLastUser, isAtTurnBoundary);
			if (nudgeType) {
				const nudgeMsg = createNudgeMessage(nudgeType);
				currentMessages = injectNudge(currentMessages, nudgeMsg);
				logger.debug("DCP: Nudge injected", { type: nudgeType });
			}
		}

		return currentMessages;
	};
}

/**
 * Sync tool call info from messages into state.toolParameters so that
 * turn protection and purge-errors can look up per-tool metadata.
 */
function syncToolParameters(messages: AgentMessage[], state: DCPState): void {
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "toolCall" && !state.toolParameters.has(block.id)) {
					registerToolCall(state, block.id, {
						tool: block.name,
						parameters: block.arguments,
						status: "success",
						turn: state.currentTurn,
						tokenCount: countTokens(JSON.stringify(block.arguments)),
					});
				}
			}
		}
		if (msg.role === "toolResult") {
			const existing = state.toolParameters.get(msg.toolCallId);
			if (existing) {
				if (msg.isError) {
					existing.status = "error";
				}
			}
		}
	}
}

function countMessagesSinceLastUser(messages: AgentMessage[]): number {
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") break;
		count++;
	}
	return count;
}

function isUserAssistantBoundary(messages: AgentMessage[]): boolean {
	if (messages.length < 2) return false;
	const last = messages[messages.length - 1];
	// transformContext runs before the LLM generates its assistant response,
	// so the last message is never "assistant". Detect the boundary as the
	// user's new message being the final one (the LLM is about to respond).
	return last.role === "user";
}
