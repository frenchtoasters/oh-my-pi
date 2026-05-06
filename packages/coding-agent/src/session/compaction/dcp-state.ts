import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

export interface ToolParameterEntry {
	tool: string;
	parameters: Record<string, unknown>;
	status: "success" | "error";
	error?: string;
	turn: number;
	tokenCount: number;
}

export interface CompressionBlock {
	blockId: string;
	active: boolean;
	mode: "range" | "message";
	topic: string;
	startId: string;
	endId: string;
	anchorMessageId: string;
	summary: string;
	includedBlockIds: string[];
	consumedBlockIds: string[];
	parentBlockIds: string[];
	effectiveMessageIds: string[];
	effectiveFingerprints: string[];
	effectiveToolIds: string[];
	deactivatedByUser: boolean;
	createdAt: number;
}

export interface DCPStats {
	totalPrunedTokens: number;
	prunedToolCount: number;
	compressionBlockCount: number;
}

export interface DCPState {
	toolParameters: Map<string, ToolParameterEntry>;
	pruneTools: Map<string, number>;
	compressionBlocks: Map<string, CompressionBlock>;
	messageIdMap: Map<string, string>;
	lastAssignedIdMap?: Map<number, string>;
	lastTransformMessages?: AgentMessage[];
	currentTurn: number;
	stats: DCPStats;
	nudgeCallCount: number;
}

export function createDCPState(): DCPState {
	return {
		toolParameters: new Map(),
		pruneTools: new Map(),
		compressionBlocks: new Map(),
		messageIdMap: new Map(),
		currentTurn: 0,
		stats: {
			totalPrunedTokens: 0,
			prunedToolCount: 0,
			compressionBlockCount: 0,
		},
		nudgeCallCount: 0,
	};
}

export function registerToolCall(state: DCPState, toolCallId: string, entry: ToolParameterEntry): void {
	state.toolParameters.set(toolCallId, entry);
}

function deepSortKeys(value: unknown): unknown {
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(deepSortKeys);
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const val = (value as Record<string, unknown>)[key];
		if (val !== null && val !== undefined) {
			sorted[key] = deepSortKeys(val);
		}
	}
	return sorted;
}

export function getToolSignature(tool: string, parameters: Record<string, unknown>): string {
	const sorted = deepSortKeys(parameters);
	return `${tool}::${JSON.stringify(sorted)}`;
}

export function markForPruning(state: DCPState, toolCallId: string, tokenCount: number): void {
	if (!state.pruneTools.has(toolCallId)) {
		state.stats.totalPrunedTokens += tokenCount;
		state.stats.prunedToolCount += 1;
	}
	state.pruneTools.set(toolCallId, tokenCount);
}

export function isMarkedForPruning(state: DCPState, toolCallId: string): boolean {
	return state.pruneTools.has(toolCallId);
}

export function getStats(state: DCPState): DCPStats {
	return { ...state.stats };
}
