import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

export interface DeduplicationConfig {
	protectedTools: string[];
	protectedFilePatterns: string[];
	turnProtectionTurns: number;
}

function getToolSignature(name: string, args: Record<string, unknown>): string {
	return JSON.stringify({ name, args });
}

/** Count assistant messages up to (but not including) msgIndex. */
function turnAtIndex(messages: AgentMessage[], msgIndex: number): number {
	let turn = 0;
	for (let i = 0; i < msgIndex; i++) {
		if (messages[i].role === "assistant") turn++;
	}
	return turn;
}

export function deduplicateToolCalls(
	messages: AgentMessage[],
	currentTurn: number,
	config: DeduplicationConfig,
): AgentMessage[] {
	// Pre-compile globs for protected file patterns
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	// Map: signature -> {messageIndex, toolCallId, tokenCount, turn}[]
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
					// Protection: Protected tools (never deduplicate these)
					if (config.protectedTools.includes(block.name)) return;

					// Protection: Protected file patterns (never deduplicate these)
					const filePath = block.arguments.filePath;
					if (typeof filePath === "string" && protectedGlobs.some(glob => glob.match(filePath))) {
						return;
					}

					const signature = getToolSignature(block.name, block.arguments as Record<string, unknown>);
					// Rough token estimate: JSON length / 4
					const tokenCount = JSON.stringify(block.arguments).length / 4;
					const turn = turnAtIndex(messages, msgIndex);

					const list = signatureMap.get(signature) ?? [];
					list.push({ messageIndex: msgIndex, toolCallId: block.id, tokenCount, turn });
					signatureMap.set(signature, list);
				}
			});
		}
	});

	// 2. Determine which tool call IDs to prune (all but the last, unless turn-protected)
	const prunedToolCallIds = new Set<string>();
	for (const [_signature, entries] of signatureMap.entries()) {
		if (entries.length > 1) {
			for (let i = 0; i < entries.length - 1; i++) {
				const entry = entries[i];
				if (entry.turn >= currentTurn - config.turnProtectionTurns) {
					continue;
				}
				prunedToolCallIds.add(entry.toolCallId);
			}
		}
	}

	// 3. Rebuild messages, dropping pruned tool calls and their results
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
