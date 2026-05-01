import { deactivateBlock, getActiveBlocks, reactivateBlock } from "./compression-blocks";
import type { DCPState } from "./dcp-state";
import { getStats } from "./dcp-state";

export interface DCPCommandResult {
	success: boolean;
	message: string;
}

export function handleDecompress(state: DCPState, blockId: string): DCPCommandResult {
	if (!state.compressionBlocks.has(blockId)) {
		return { success: false, message: `Block ${blockId} not found` };
	}

	try {
		deactivateBlock(state, blockId);
		return { success: true, message: `Block ${blockId} decompressed. Original messages restored.` };
	} catch (e: unknown) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}
}

export function handleRecompress(state: DCPState, blockId: string): DCPCommandResult {
	const block = state.compressionBlocks.get(blockId);
	if (!block) {
		return { success: false, message: `Block ${blockId} not found` };
	}
	if (block.active) {
		return { success: false, message: `Block ${blockId} is already active` };
	}

	try {
		reactivateBlock(state, blockId);
		return { success: true, message: `Block ${blockId} recompressed.` };
	} catch (e: unknown) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}
}

export function handleDCPStats(state: DCPState): DCPCommandResult {
	const stats = getStats(state);
	const activeBlocks = getActiveBlocks(state);

	const message = [
		"DCP Statistics",
		"--------------",
		`Total tokens saved: ${stats.totalPrunedTokens}`,
		`Tools pruned: ${stats.prunedToolCount}`,
		`Compression blocks: ${stats.compressionBlockCount}`,
		`Active blocks: ${activeBlocks.length}`,
	].join("\n");

	return { success: true, message };
}

export function handleDCPContext(state: DCPState, currentTokenCount: number): DCPCommandResult {
	const stats = getStats(state);
	const activeBlocks = getActiveBlocks(state);

	const blockList =
		activeBlocks.length > 0
			? activeBlocks.map(b => `  ${b.blockId}: ${b.topic} (${b.startId}-${b.endId})`).join("\n")
			: "  None";

	const message = [
		"DCP Context Overview",
		"--------------------",
		`Current context tokens: ${currentTokenCount}`,
		`Pruned tokens (saved): ${stats.totalPrunedTokens}`,
		`Active compression blocks: ${activeBlocks.length}`,
		`Blocks:`,
		blockList,
	].join("\n");

	return { success: true, message };
}
