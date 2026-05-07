import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { turnAtIndex } from "./utils.js";

export interface DeduplicationConfig {
	protectedTools: string[];
	protectedFilePatterns: string[];
	turnProtectionTurns: number;
}

function getToolSignature(name: string, args: Record<string, unknown>): string {
	return JSON.stringify({ name, args });
}

export function deduplicateToolCalls(
	messages: AgentMessage[],
	currentTurn: number,
	config: DeduplicationConfig,
): AgentMessage[] {
	// Pre-compile globs for protected file patterns
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	// Map: signature -> {messageIndex, toolCallId, turn}[]
	const signatureMap = new Map<
		string,
		{
			messageIndex: number;
			toolCallId: string;
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
					// NOTE: Only checks `arguments.path` — tools using other arg names for file targets are not covered.
					const targetPath = block.arguments?.path;
					if (typeof targetPath === "string" && protectedGlobs.some(glob => glob.match(targetPath))) {
						return;
					}

					const signature = getToolSignature(block.name, block.arguments as Record<string, unknown>);
					const turn = turnAtIndex(messages, msgIndex);

					const list = signatureMap.get(signature) ?? [];
					list.push({ messageIndex: msgIndex, toolCallId: block.id, turn });
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

				// Retain a placeholder to preserve role alternation — downstream passes
				// (purgeErrors, supersedeWrites) only act on toolCall blocks, so this is safe.
				if (newContent.length === 0)
					return { ...msg, content: [{ type: "text" as const, text: "[tool calls deduplicated]" }] };

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
