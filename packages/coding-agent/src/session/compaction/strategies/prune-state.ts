import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { DeduplicationConfig } from "./deduplication.js";
import type { PurgeErrorsConfig } from "./purge-errors.js";
import type { SupersedeWritesConfig } from "./supersede-writes.js";
import { turnAtIndex } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupersedeReadsConfig {
	/** Tool names considered as "write" operations that invalidate prior reads. */
	writeTools: string[];
	/** Tool names considered as "read" operations. */
	readTools: string[];
	/** Minimum turns since the read before it can be superseded. */
	turnProtection: number;
}

export interface CollapseBashRetriesConfig {
	/** Minimum consecutive failures before collapsing older ones. */
	minConsecutiveFailures: number;
	/** Turns to protect from collapsing (most recent N turns are safe). */
	turnProtection: number;
}

export interface DirectoryListingExpiryConfig {
	/** Stub directory listings older than this many turns. */
	turnThreshold: number;
	/** Tool names that produce directory listings. */
	readTools: string[];
}

export interface PruneConfig {
	deduplication: DeduplicationConfig;
	purgeErrors: PurgeErrorsConfig;
	supersedeWrites: SupersedeWritesConfig;
	supersedeReads?: SupersedeReadsConfig;
	collapseBashRetries?: CollapseBashRetriesConfig;
	directoryListingExpiry?: DirectoryListingExpiryConfig;
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
	/** IDs of read tool calls whose results are stale due to later writes to the same file. */
	supersededReadIds: ReadonlySet<string>;
	/** IDs of bash tool calls that are older failures in a retry sequence. */
	collapsedBashRetryIds: ReadonlySet<string>;
	/** IDs of read tool calls that returned directory listings and have expired. */
	expiredDirectoryListingIds: ReadonlySet<string>;
	/** Message index threshold — tool calls at indices below this are frozen (not pruned). */
	frozenBeforeIndex: number;
}

export function createEmptyPruneState(): PruneState {
	return {
		dedupRemovedIds: new Set(),
		errorPurgedIds: new Set(),
		supersededIds: new Set(),
		supersededReadIds: new Set(),
		collapsedBashRetryIds: new Set(),
		expiredDirectoryListingIds: new Set(),
		frozenBeforeIndex: 0,
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
export function computePruneState(
	messages: AgentMessage[],
	currentTurn: number,
	config: PruneConfig,
	frozenBeforeIndex = 0,
): PruneState {
	// --- Deduplication ---
	const dedupRemovedIds = computeDeduplicationIds(messages, currentTurn, config.deduplication, frozenBeforeIndex);

	// --- Purge errors ---
	const errorPurgedIds = computeErrorPurgeIds(messages, currentTurn, config.purgeErrors, frozenBeforeIndex);

	// --- Supersede writes ---
	const supersededIds = computeSupersededIds(messages, config.supersedeWrites, frozenBeforeIndex);

	// --- Supersede stale reads ---
	const supersededReadIds = config.supersedeReads
		? computeSupersededReadIds(messages, currentTurn, config.supersedeReads, frozenBeforeIndex)
		: new Set<string>();

	// --- Collapse bash retries ---
	const collapsedBashRetryIds = config.collapseBashRetries
		? computeCollapsedBashRetryIds(messages, currentTurn, config.collapseBashRetries, frozenBeforeIndex)
		: new Set<string>();

	// --- Directory listing expiry ---
	const expiredDirectoryListingIds = config.directoryListingExpiry
		? computeExpiredDirectoryListingIds(messages, currentTurn, config.directoryListingExpiry, frozenBeforeIndex)
		: new Set<string>();

	return {
		dedupRemovedIds,
		errorPurgedIds,
		supersededIds,
		supersededReadIds,
		collapsedBashRetryIds,
		expiredDirectoryListingIds,
		frozenBeforeIndex,
	};
}

function computeDeduplicationIds(
	messages: AgentMessage[],
	currentTurn: number,
	config: DeduplicationConfig,
	frozenBeforeIndex: number,
): Set<string> {
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	const signatureMap = new Map<string, { messageIndex: number; toolCallId: string; turn: number }[]>();

	messages.forEach((msg, msgIndex) => {
		if (msgIndex < frozenBeforeIndex) return;
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

function computeErrorPurgeIds(
	messages: AgentMessage[],
	currentTurn: number,
	config: PurgeErrorsConfig,
	frozenBeforeIndex: number,
): Set<string> {
	const toolCallMeta = new Map<string, { tool: string; turn: number }>();
	const toolCallMessageIndex = new Map<string, number>();

	messages.forEach((msg, msgIndex) => {
		if (msg.role === "assistant") {
			const turn = turnAtIndex(messages, msgIndex);
			msg.content.forEach(block => {
				if (block.type === "toolCall") {
					toolCallMeta.set(block.id, { tool: block.name, turn });
					toolCallMessageIndex.set(block.id, msgIndex);
				}
			});
		}
	});

	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError) {
			const meta = toolCallMeta.get(message.toolCallId);
			if (!meta) continue;
			const msgIdx = toolCallMessageIndex.get(message.toolCallId);
			if (msgIdx === undefined || msgIdx < frozenBeforeIndex) continue;
			if (config.protectedTools.includes(meta.tool)) continue;
			if (currentTurn - meta.turn < config.turnThreshold) continue;
			ids.add(message.toolCallId);
		}
	}
	return ids;
}

function computeSupersededIds(
	messages: AgentMessage[],
	config: SupersedeWritesConfig,
	frozenBeforeIndex: number,
): Set<string> {
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	const lastReadIndex: Map<string, number> = new Map();
	// Track the last write index per file for write→write superseding
	const lastWriteIndex: Map<string, number> = new Map();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall") {
					if (config.readTools.includes(content.name)) {
						const targetPath = content.arguments?.path;
						if (typeof targetPath === "string") {
							lastReadIndex.set(targetPath, i);
						}
					} else if (config.writeTools.includes(content.name)) {
						const targetPath = content.arguments?.path;
						if (typeof targetPath === "string") {
							lastWriteIndex.set(targetPath, i);
						}
					}
				}
			}
		}
	}

	const ids = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		if (i < frozenBeforeIndex) continue;
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.writeTools.includes(content.name)) {
					const targetPath = content.arguments?.path;
					if (typeof targetPath === "string" && !protectedGlobs.some(glob => glob.match(targetPath))) {
						const lastRead = lastReadIndex.get(targetPath);
						const lastWrite = lastWriteIndex.get(targetPath);
						// Superseded if: a later read exists, OR a later write exists (write→write overwrite)
						if ((lastRead !== undefined && lastRead > i) || (lastWrite !== undefined && lastWrite > i)) {
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
// Strategy: Supersede stale reads
// ---------------------------------------------------------------------------

/**
 * Extracts the base file path from a read tool's path argument, stripping any
 * selector suffix (e.g. ":50-100", ":raw").
 */
function extractBasePath(rawPath: string): string {
	// Internal URLs and http(s) URLs are not file paths — return as-is
	if (/^[a-z]+:\/\//.test(rawPath)) return rawPath;
	// Strip selector: last colon followed by a selector pattern (digits, ranges, "raw", etc.)
	const colonIdx = rawPath.lastIndexOf(":");
	if (colonIdx > 0) {
		const suffix = rawPath.slice(colonIdx + 1);
		// Valid selectors: digits, digit-digit, digit+digit, "raw", "L" prefixed
		if (/^(?:\d+(?:[-+]\d+)?|raw|L\d+(?:-L?\d+)?)$/.test(suffix)) {
			return rawPath.slice(0, colonIdx);
		}
	}
	return rawPath;
}

function computeSupersededReadIds(
	messages: AgentMessage[],
	currentTurn: number,
	config: SupersedeReadsConfig,
	frozenBeforeIndex: number,
): Set<string> {
	// Build a map of file path → latest write index
	const lastWriteIndex = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.writeTools.includes(content.name)) {
					const targetPath = content.arguments?.path;
					if (typeof targetPath === "string") {
						lastWriteIndex.set(targetPath, i);
					}
				}
			}
		}
	}

	const ids = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		if (i < frozenBeforeIndex) continue;
		const msg = messages[i];
		if (msg.role === "assistant") {
			const turn = turnAtIndex(messages, i);
			// Protect recent turns
			if (currentTurn - turn < config.turnProtection) continue;
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.readTools.includes(content.name)) {
					const rawPath = content.arguments?.path;
					if (typeof rawPath !== "string") continue;
					const basePath = extractBasePath(rawPath);
					// Check if a later write targets this same base path
					const lastWrite = lastWriteIndex.get(basePath);
					if (lastWrite !== undefined && lastWrite > i) {
						ids.add(content.id);
					}
				}
			}
		}
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Strategy: Collapse bash retries
// ---------------------------------------------------------------------------

function computeCollapsedBashRetryIds(
	messages: AgentMessage[],
	currentTurn: number,
	config: CollapseBashRetriesConfig,
	frozenBeforeIndex: number,
): Set<string> {
	// Collect bash tool calls with their result error status
	interface BashCall {
		id: string;
		cwd: string | undefined;
		msgIndex: number;
		turn: number;
		isError: boolean;
	}

	const bashCalls: BashCall[] = [];
	const callIdToError = new Map<string, boolean>();

	// First pass: find error status from tool results
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.toolName === "bash") {
			callIdToError.set(msg.toolCallId, msg.isError);
		}
	}

	// Second pass: collect bash tool calls in order
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && content.name === "bash") {
					const turn = turnAtIndex(messages, i);
					bashCalls.push({
						id: content.id,
						cwd: (content.arguments?.cwd as string | undefined) ?? undefined,
						msgIndex: i,
						turn,
						isError: callIdToError.get(content.id) ?? false,
					});
				}
			}
		}
	}

	// Find consecutive failure sequences (same cwd) and collapse all but the last
	const ids = new Set<string>();
	let streakStart = 0;

	for (let i = 0; i <= bashCalls.length; i++) {
		const cur = bashCalls[i];
		const prev = bashCalls[i - 1];

		// Break the streak when: end of array, success, or different cwd
		const streakBroken = !cur?.isError || (prev && cur.cwd !== prev.cwd);

		if (streakBroken && i > streakStart) {
			const streakLen = i - streakStart;
			if (streakLen >= config.minConsecutiveFailures) {
				// Collapse all but the last failure in the streak
				for (let j = streakStart; j < i - 1; j++) {
					const call = bashCalls[j];
					if (call.msgIndex < frozenBeforeIndex) continue;
					if (currentTurn - call.turn < config.turnProtection) continue;
					ids.add(call.id);
				}
			}
			streakStart = i;
		} else if (streakBroken) {
			streakStart = i;
		}
	}

	return ids;
}

// ---------------------------------------------------------------------------
// Strategy: Directory listing expiry
// ---------------------------------------------------------------------------

function computeExpiredDirectoryListingIds(
	messages: AgentMessage[],
	currentTurn: number,
	config: DirectoryListingExpiryConfig,
	frozenBeforeIndex: number,
): Set<string> {
	// Build set of tool call IDs that returned directory listings
	const directoryResultIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "toolResult" && config.readTools.includes(msg.toolName)) {
			const details = (msg as any).details;
			if (details?.isDirectory) {
				directoryResultIds.add(msg.toolCallId);
			}
		}
	}

	const ids = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		if (i < frozenBeforeIndex) continue;
		const msg = messages[i];
		if (msg.role === "assistant") {
			const turn = turnAtIndex(messages, i);
			if (currentTurn - turn < config.turnThreshold) continue;
			for (const content of msg.content) {
				if (content.type === "toolCall" && directoryResultIds.has(content.id)) {
					ids.add(content.id);
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
 * The transforms are applied in order: deduplication → error-purge →
 * supersede-writes → supersede-reads → collapse-bash-retries → directory-expiry.
 */
export function applyPruneState(messages: AgentMessage[], state: PruneState): AgentMessage[] {
	let result = applyDeduplication(messages, state.dedupRemovedIds);
	result = applyErrorPurge(result, state.errorPurgedIds);
	result = applySupersededWrites(result, state.supersededIds);
	result = applySupersededReads(result, state.supersededReadIds);
	result = applyCollapsedBashRetries(result, state.collapsedBashRetryIds);
	result = applyExpiredDirectoryListings(result, state.expiredDirectoryListingIds);
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
								_reason: "superseded",
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
				content: [{ type: "text", text: "[Write output superseded - file was subsequently modified or read]" }],
			};
		}
		return msg;
	});
}

function applySupersededReads(messages: AgentMessage[], supersededReadIds: ReadonlySet<string>): AgentMessage[] {
	if (supersededReadIds.size === 0) return messages;

	return messages.map(msg => {
		if (msg.role === "assistant") {
			const hasPruned = msg.content.some(c => c.type === "toolCall" && supersededReadIds.has(c.id));
			if (!hasPruned) return msg;
			return {
				...msg,
				content: msg.content.map(content => {
					if (content.type === "toolCall" && supersededReadIds.has(content.id)) {
						return {
							...content,
							arguments: {
								_pruned: true,
								_reason: "superseded-read",
								path: content.arguments?.path,
							},
						} satisfies ToolCall;
					}
					return content;
				}),
			};
		}
		if (msg.role === "toolResult" && supersededReadIds.has(msg.toolCallId)) {
			return {
				...msg,
				content: [{ type: "text", text: "[Read output superseded - file was subsequently modified]" }],
			};
		}
		return msg;
	});
}

function applyCollapsedBashRetries(messages: AgentMessage[], collapsedIds: ReadonlySet<string>): AgentMessage[] {
	if (collapsedIds.size === 0) return messages;

	return messages.map(msg => {
		if (msg.role === "assistant") {
			const hasPruned = msg.content.some(c => c.type === "toolCall" && collapsedIds.has(c.id));
			if (!hasPruned) return msg;
			return {
				...msg,
				content: msg.content.map(content => {
					if (content.type === "toolCall" && collapsedIds.has(content.id)) {
						return {
							...content,
							arguments: {
								_pruned: true,
								_reason: "collapsed-bash-retry",
								command: content.arguments?.command,
							},
						} satisfies ToolCall;
					}
					return content;
				}),
			};
		}
		if (msg.role === "toolResult" && collapsedIds.has(msg.toolCallId)) {
			return {
				...msg,
				content: [{ type: "text", text: "[Bash failure collapsed - superseded by later retry]" }],
			};
		}
		return msg;
	});
}

function applyExpiredDirectoryListings(messages: AgentMessage[], expiredIds: ReadonlySet<string>): AgentMessage[] {
	if (expiredIds.size === 0) return messages;

	return messages.map(msg => {
		if (msg.role === "assistant") {
			const hasPruned = msg.content.some(c => c.type === "toolCall" && expiredIds.has(c.id));
			if (!hasPruned) return msg;
			return {
				...msg,
				content: msg.content.map(content => {
					if (content.type === "toolCall" && expiredIds.has(content.id)) {
						return {
							...content,
							arguments: {
								_pruned: true,
								_reason: "expired-directory-listing",
								path: content.arguments?.path,
							},
						} satisfies ToolCall;
					}
					return content;
				}),
			};
		}
		if (msg.role === "toolResult" && expiredIds.has(msg.toolCallId)) {
			return {
				...msg,
				content: [{ type: "text", text: "[Directory listing expired - re-read if needed]" }],
			};
		}
		return msg;
	});
}
