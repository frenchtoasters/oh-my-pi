import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { DeduplicationConfig } from "./deduplication.js";
import type { PurgeErrorsConfig } from "./purge-errors.js";
import type { SupersedeWritesConfig } from "./supersede-writes.js";
import { turnAtIndex } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PruneConfig {
	deduplication: DeduplicationConfig;
	purgeErrors: PurgeErrorsConfig;
	supersedeWrites: SupersedeWritesConfig;
}

/**
 * Stores the computed prune decisions for a snapshot of the message history.
 * Each set holds tool call IDs that should be transformed on the next
 * `applyPruneState` call.
 */
export interface PruneState {
	/** IDs to remove entirely (tool call + its result). */
	dedupRemovedIds: ReadonlySet<string>;
	/** IDs whose arguments should be blanked (error-input purge). */
	errorPurgedIds: ReadonlySet<string>;
	/** IDs whose arguments and result should be stubbed (superseded writes). */
	supersededIds: ReadonlySet<string>;
}

export function createEmptyPruneState(): PruneState {
	return {
		dedupRemovedIds: new Set(),
		errorPurgedIds: new Set(),
		supersededIds: new Set(),
	};
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

function computeToolSignature(name: string, args: Record<string, unknown>): string {
	return JSON.stringify({ name, args });
}

/**
 * Runs all three pruning strategies over `messages` and returns the stable
 * set of decisions. Does NOT mutate `messages`.
 *
 * Call this at turn boundaries, not on every LLM request.
 */
export function computePruneState(messages: AgentMessage[], currentTurn: number, config: PruneConfig): PruneState {
	// --- Deduplication ---
	const dedupRemovedIds = computeDeduplicationIds(messages, currentTurn, config.deduplication);

	// --- Purge errors ---
	// Compute against the original messages; IDs already in dedupRemovedIds will
	// have been removed before the error-purge apply step runs, so they are inert.
	const errorPurgedIds = computeErrorPurgeIds(messages, currentTurn, config.purgeErrors);

	// --- Supersede writes ---
	const supersededIds = computeSupersededIds(messages, config.supersedeWrites);

	return { dedupRemovedIds, errorPurgedIds, supersededIds };
}

function computeDeduplicationIds(
	messages: AgentMessage[],
	currentTurn: number,
	config: DeduplicationConfig,
): Set<string> {
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	const signatureMap = new Map<string, { messageIndex: number; toolCallId: string; turn: number }[]>();

	messages.forEach((msg, msgIndex) => {
		if (msg.role === "assistant") {
			msg.content.forEach(block => {
				if (block.type === "toolCall") {
					if (config.protectedTools.includes(block.name)) return;
					const targetPath = block.arguments?.path;
					if (typeof targetPath === "string" && protectedGlobs.some(glob => glob.match(targetPath))) {
						return;
					}
					const signature = computeToolSignature(block.name, block.arguments as Record<string, unknown>);
					const turn = turnAtIndex(messages, msgIndex);
					const list = signatureMap.get(signature) ?? [];
					list.push({ messageIndex: msgIndex, toolCallId: block.id, turn });
					signatureMap.set(signature, list);
				}
			});
		}
	});

	const ids = new Set<string>();
	for (const [_signature, entries] of signatureMap.entries()) {
		if (entries.length > 1) {
			for (let i = 0; i < entries.length - 1; i++) {
				const entry = entries[i];
				if (entry.turn >= currentTurn - config.turnProtectionTurns) continue;
				ids.add(entry.toolCallId);
			}
		}
	}
	return ids;
}

function computeErrorPurgeIds(messages: AgentMessage[], currentTurn: number, config: PurgeErrorsConfig): Set<string> {
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

	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError) {
			const meta = toolCallMeta.get(message.toolCallId);
			if (!meta) continue;
			if (config.protectedTools.includes(meta.tool)) continue;
			if (currentTurn - meta.turn < config.turnThreshold) continue;
			ids.add(message.toolCallId);
		}
	}
	return ids;
}

function computeSupersededIds(messages: AgentMessage[], config: SupersedeWritesConfig): Set<string> {
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	const lastReadIndex: Map<string, number> = new Map();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.readTools.includes(content.name)) {
					const targetPath = content.arguments?.path;
					if (typeof targetPath === "string") {
						lastReadIndex.set(targetPath, i);
					}
				}
			}
		}
	}

	const ids = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.writeTools.includes(content.name)) {
					const targetPath = content.arguments?.path;
					if (typeof targetPath === "string" && !protectedGlobs.some(glob => glob.match(targetPath))) {
						const lastRead = lastReadIndex.get(targetPath);
						if (lastRead !== undefined && lastRead > i) {
							ids.add(content.id);
						}
					}
				}
			}
		}
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Applies a pre-computed `PruneState` to `messages` and returns the pruned
 * array. This is a pure, deterministic transform — no strategy logic runs
 * here, only the stored decisions.
 *
 * The three transforms are applied in the same order as the original strategy
 * chain: deduplication → error-purge → supersede-writes.
 */
export function applyPruneState(messages: AgentMessage[], state: PruneState): AgentMessage[] {
	let result = applyDeduplication(messages, state.dedupRemovedIds);
	result = applyErrorPurge(result, state.errorPurgedIds);
	result = applySupersededWrites(result, state.supersededIds);
	return result;
}

function applyDeduplication(messages: AgentMessage[], removedIds: ReadonlySet<string>): AgentMessage[] {
	if (removedIds.size === 0) return messages;

	return messages
		.map(msg => {
			if (msg.role === "assistant") {
				const newContent = msg.content.filter(block => {
					if (block.type === "toolCall") return !removedIds.has(block.id);
					return true;
				});
				if (newContent.length === 0) {
					return { ...msg, content: [{ type: "text" as const, text: "[tool calls deduplicated]" }] };
				}
				return { ...msg, content: newContent };
			}
			if (msg.role === "toolResult" && removedIds.has(msg.toolCallId)) {
				return null;
			}
			return msg;
		})
		.filter((msg): msg is AgentMessage => msg !== null);
}

function applyErrorPurge(messages: AgentMessage[], purgedIds: ReadonlySet<string>): AgentMessage[] {
	if (purgedIds.size === 0) return messages;

	return messages.map(message => {
		if (message.role === "assistant") {
			const hasPruned = message.content.some(c => c.type === "toolCall" && purgedIds.has(c.id));
			if (!hasPruned) return message;
			return {
				...message,
				content: message.content.map(c => {
					if (c.type === "toolCall" && purgedIds.has(c.id)) {
						return { ...c, arguments: { _pruned: true, _reason: "error-input-purged" } };
					}
					return c;
				}),
			};
		}
		return message;
	});
}

function applySupersededWrites(messages: AgentMessage[], supersededIds: ReadonlySet<string>): AgentMessage[] {
	if (supersededIds.size === 0) return messages;

	return messages.map(msg => {
		if (msg.role === "assistant") {
			return {
				...msg,
				content: msg.content.map(content => {
					if (content.type === "toolCall" && supersededIds.has(content.id)) {
						return {
							...content,
							arguments: {
								_pruned: true,
								_reason: "superseded-by-read",
								path: content.arguments?.path,
							},
						} satisfies ToolCall;
					}
					return content;
				}),
			};
		}
		if (msg.role === "toolResult" && supersededIds.has(msg.toolCallId)) {
			return {
				...msg,
				content: [{ type: "text", text: "[Write output superseded - file was subsequently read]" }],
			};
		}
		return msg;
	});
}
