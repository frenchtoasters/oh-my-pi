import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompressionBlock, DCPState } from "./dcp-state";
import { computeMessageFingerprint } from "./message-ids";

export interface CreateBlockParams {
	mode: "range" | "message";
	topic: string;
	startId: string;
	endId: string;
	summary: string;
	messageIdMap: Map<number, string>;
	messages?: AgentMessage[];
}

function getEffectiveMessageIds(startId: string, endId: string, messageIdMap: Map<number, string>): string[] {
	const ids = Array.from(messageIdMap.values());
	const startIndex = ids.indexOf(startId);
	const endIndex = ids.indexOf(endId);

	if (startIndex === -1 || endIndex === -1) return [];
	return ids.slice(startIndex, endIndex + 1);
}

export function createBlock(state: DCPState, params: CreateBlockParams): CompressionBlock {
	const newBlockId = `b${state.stats.compressionBlockCount + 1}`;
	const effectiveMessageIds = getEffectiveMessageIds(params.startId, params.endId, params.messageIdMap);

	const newBlock: CompressionBlock = {
		blockId: newBlockId,
		active: true,
		mode: params.mode,
		topic: params.topic,
		startId: params.startId,
		endId: params.endId,
		anchorMessageId: params.startId,
		summary: params.summary,
		includedBlockIds: [],
		consumedBlockIds: [],
		parentBlockIds: [],
		effectiveMessageIds,
		effectiveFingerprints: [],
		effectiveToolIds: [],
		deactivatedByUser: false,
		createdAt: Date.now(),
	};

	// Compute stable fingerprints for the messages in the effective range
	const effectiveFingerprints: string[] = [];
	if (params.messages && params.messages.length > 0) {
		// Build reverse map: id -> index
		const idToIdx = new Map<string, number>();
		for (const [idx, id] of params.messageIdMap.entries()) {
			idToIdx.set(id, idx);
		}
		for (const msgId of effectiveMessageIds) {
			const idx = idToIdx.get(msgId);
			if (idx !== undefined && idx < params.messages.length) {
				effectiveFingerprints.push(computeMessageFingerprint(params.messages[idx]));
			}
		}
	}
	newBlock.effectiveFingerprints = effectiveFingerprints;

	// Find overlapping blocks to consume
	const effectiveSet = new Set(effectiveMessageIds);
	const effectiveFpSet = new Set(effectiveFingerprints);
	for (const [id, block] of state.compressionBlocks) {
		if (!block.active) continue;

		const overlaps =
			block.effectiveFingerprints?.length > 0
				? block.effectiveFingerprints.some(fp => effectiveFpSet.has(fp))
				: block.effectiveMessageIds.some(msgId => effectiveSet.has(msgId));
		if (overlaps) {
			newBlock.consumedBlockIds.push(id);
			newBlock.includedBlockIds.push(id);

			// Deactivate consumed block
			state.compressionBlocks.set(id, {
				...block,
				active: false,
				parentBlockIds: [...block.parentBlockIds, newBlockId],
			});
		}
	}

	state.compressionBlocks.set(newBlockId, newBlock);
	state.stats.compressionBlockCount += 1;

	return newBlock;
}

export function deactivateBlock(state: DCPState, blockId: string): void {
	const block = state.compressionBlocks.get(blockId);
	if (!block) throw new Error("Block not found");

	const hasActiveChildren = Array.from(state.compressionBlocks.values()).some(
		b => b.active && b.parentBlockIds.includes(blockId),
	);

	if (hasActiveChildren) throw new Error("Cannot deactivate block with active children");

	state.compressionBlocks.set(blockId, {
		...block,
		active: false,
		deactivatedByUser: true,
	});
}

export function reactivateBlock(state: DCPState, blockId: string): void {
	const block = state.compressionBlocks.get(blockId);
	if (!block) throw new Error("Block not found");

	// Check if any active block currently has this block as a consumed block?
	// No, that's not stored in the state, only the other way around.
	// Check if any block has this blockId in its parentBlockIds and is active.
	const isConsumedByActive = Array.from(state.compressionBlocks.values()).some(
		b => b.active && b.consumedBlockIds.includes(blockId),
	);

	if (isConsumedByActive) throw new Error("Cannot reactivate: consumed blocks are active");

	state.compressionBlocks.set(blockId, {
		...block,
		active: true,
		deactivatedByUser: false,
	});
}

export function getActiveBlocks(state: DCPState): CompressionBlock[] {
	return Array.from(state.compressionBlocks.values())
		.filter(b => b.active)
		.sort((a, b) => Number.parseInt(a.blockId.slice(1), 10) - Number.parseInt(b.blockId.slice(1), 10));
}

export function filterCompressedRanges(
	messages: AgentMessage[],
	state: DCPState,
	messageIdMap: Map<number, string>,
): AgentMessage[] {
	const activeBlocks = getActiveBlocks(state);
	const removalIndices = new Set<number>();
	const summaryMessages: Map<number, AgentMessage[]> = new Map();

	// Map ID -> index for quick lookup
	const idToIndex = new Map<string, number>();
	if (messageIdMap) {
		for (const [idx, id] of messageIdMap.entries()) {
			idToIndex.set(id, idx);
		}
	}

	// Build fingerprint -> index map for stable matching across index shifts
	const fpToIndex = new Map<string, number>();
	for (const [idx, _id] of messageIdMap.entries()) {
		if (idx < messages.length) {
			const fp = computeMessageFingerprint(messages[idx]);
			fpToIndex.set(fp, idx);
		}
	}

	for (const block of activeBlocks) {
		const indicesInRange: number[] = [];

		if (block.effectiveFingerprints?.length > 0) {
			// Fingerprint-based matching (stable across index shifts)
			for (const fp of block.effectiveFingerprints) {
				const idx = fpToIndex.get(fp);
				if (idx !== undefined) {
					indicesInRange.push(idx);
					removalIndices.add(idx);
				}
			}
		} else {
			// Fallback: mNNNN ID matching (legacy blocks without fingerprints)
			for (const msgId of block.effectiveMessageIds) {
				const idx = idToIndex.get(msgId);
				if (idx !== undefined) {
					indicesInRange.push(idx);
					removalIndices.add(idx);
				}
			}
		}

		// Skip blocks whose messages are not in the current context
		if (indicesInRange.length === 0) {
			continue;
		}

		// Anchor is the first message in the range
		const anchorIdx = Math.min(...indicesInRange);

		const summaryMsg: AgentMessage = {
			role: "developer",
			content: `[Compressed conversation section]\nBlock ${block.blockId}: ${block.topic}\n\n${block.summary}`,
			timestamp: block.createdAt,
		};
		const existing = summaryMessages.get(anchorIdx) ?? [];
		existing.push(summaryMsg);
		summaryMessages.set(anchorIdx, existing);
	}

	// 1. Build bidirectional pair maps
	const toolCallIdToAssistantIdx = new Map<string, number>();
	const toolCallIdToResultIdx = new Map<string, number>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (typeof block === "object" && "type" in block && block.type === "toolCall") {
					toolCallIdToAssistantIdx.set(block.id, i);
				}
			}
		} else if (msg.role === "toolResult") {
			toolCallIdToResultIdx.set(msg.toolCallId, i);
		}
	}

	// 2 & 3. Pair Expansion
	const partialFilterAssistants = new Map<number, Set<string>>();

	// Convert to array to avoid concurrent modification issues (though we are using a Set)
	const initialRemovalIndices = Array.from(removalIndices);

	for (const idx of initialRemovalIndices) {
		const msg = messages[idx];
		if (!msg) continue;

		if (msg.role === "assistant") {
			// Forward expansion: Remove tool results
			for (const block of msg.content) {
				if (typeof block === "object" && "type" in block && block.type === "toolCall") {
					const resultIdx = toolCallIdToResultIdx.get(block.id);
					if (resultIdx !== undefined) {
						removalIndices.add(resultIdx);
					}
				}
			}
		} else if (msg.role === "toolResult") {
			// Reverse expansion: Check assistant
			const assistantIdx = toolCallIdToAssistantIdx.get(msg.toolCallId);
			if (assistantIdx !== undefined && !removalIndices.has(assistantIdx)) {
				const assistantMsg = messages[assistantIdx];
				if (assistantMsg.role !== "assistant") continue;

				// Check if all toolCalls are removed
				const allRemoved = assistantMsg.content.every(block => {
					if (typeof block === "object" && "type" in block && block.type === "toolCall") {
						const resultIdx = toolCallIdToResultIdx.get(block.id);
						return resultIdx !== undefined && removalIndices.has(resultIdx);
					}
					return true; // Non-toolCall blocks don't cause removal
				});

				if (allRemoved) {
					removalIndices.add(assistantIdx);
				} else {
					// Mark for partial filtering
					if (!partialFilterAssistants.has(assistantIdx)) {
						partialFilterAssistants.set(assistantIdx, new Set());
					}
					partialFilterAssistants.get(assistantIdx)!.add(msg.toolCallId);
				}
			}
		}
	}

	const result: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (summaryMessages.has(i)) {
			for (const msg of summaryMessages.get(i)!) {
				result.push(msg);
			}
		}

		if (!removalIndices.has(i)) {
			if (partialFilterAssistants.has(i)) {
				const orphanedToolCallIds = partialFilterAssistants.get(i)!;
				const msg = messages[i];
				// Narrowing for assistant
				if (msg.role === "assistant") {
					const newContent = msg.content.filter(block => {
						if (typeof block === "object" && "type" in block && block.type === "toolCall") {
							return !orphanedToolCallIds.has(block.id);
						}
						return true;
					});
					if (newContent.length === 0) continue;
					result.push({ ...msg, content: newContent });
				} else {
					result.push(msg);
				}
			} else {
				result.push(messages[i]);
			}
		}
	}

	return result;
}
