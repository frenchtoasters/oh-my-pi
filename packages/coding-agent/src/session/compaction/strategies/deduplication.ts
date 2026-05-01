import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type DCPState, getToolSignature, markForPruning } from "../dcp-state";

export interface DeduplicationConfig {
	enabled: boolean;
	protectedTools: string[];
	protectedFilePatterns: string[];
	turnProtectionTurns: number;
}

export function deduplicateToolCalls(
	messages: AgentMessage[],
	state: DCPState,
	config: DeduplicationConfig,
): AgentMessage[] {
	if (!config.enabled) {
		return messages;
	}

	// Pre-compile globs for protected file patterns
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	// Map: signature -> {index: number, toolCallId: string, tokenCount: number}[]
	const signatureMap = new Map<
		string,
		{
			messageIndex: number;
			toolCallId: string;
			tokenCount: number;
			turn: number;
		}[]
	>();

	// 1. Build signature map
	messages.forEach((msg, msgIndex) => {
		if (msg.role === "assistant") {
			msg.content.forEach(block => {
				if (block.type === "toolCall") {
					const signature = getToolSignature(block.name, block.arguments);

					// Protection: Protected tools (never deduplicate these)
					if (config.protectedTools.includes(block.name)) return;

					// Protection: Protected file patterns (never deduplicate these)
					const filePath = block.arguments.filePath;
					if (typeof filePath === "string" && protectedGlobs.some(glob => glob.match(filePath))) {
						return;
					}

					const entry = state.toolParameters.get(block.id);
					const list = signatureMap.get(signature) ?? [];
					list.push({
						messageIndex: msgIndex,
						toolCallId: block.id,
						tokenCount: entry?.tokenCount ?? 0,
						turn: entry?.turn ?? 0,
					});
					signatureMap.set(signature, list);
				}
			});
		}
	});

	// 2. Mark for pruning (apply turn protection here, not during map building)
	const prunedToolCallIds = new Set<string>();
	for (const [_signature, entries] of signatureMap.entries()) {
		if (entries.length > 1) {
			// Mark all except the last one for pruning, unless turn-protected
			for (let i = 0; i < entries.length - 1; i++) {
				const entry = entries[i];
				if (entry.turn >= state.currentTurn - config.turnProtectionTurns) {
					continue;
				}
				markForPruning(state, entry.toolCallId, entry.tokenCount);
				prunedToolCallIds.add(entry.toolCallId);
			}
		}
	}

	// 3. Rebuild messages
	return messages
		.map(msg => {
			if (msg.role === "assistant") {
				const newContent = msg.content.filter(block => {
					if (block.type === "toolCall") {
						return !prunedToolCallIds.has(block.id);
					}
					return true;
				});

				if (newContent.length === 0) return null;

				return { ...msg, content: newContent };
			}

			if (msg.role === "toolResult") {
				if (prunedToolCallIds.has(msg.toolCallId)) {
					return null;
				}
			}

			return msg;
		})
		.filter((msg): msg is AgentMessage => msg !== null);
}
