import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import compressDescription from "../prompts/tools/compress.md" with { type: "text" };
import { createBlock } from "../session/compaction/compression-blocks";
import type { DCPState } from "../session/compaction/dcp-state";
import { countTokens } from "../session/compaction/tokenizer";
import { renderStatusLine } from "../tui/status-line";

const CompressSchema = Type.Object({
	startId: Type.String({
		description: "The mNNNN ID of the first message in the range to compress",
		pattern: "^m\\d{4}$",
	}),
	endId: Type.String({
		description: "The mNNNN ID of the last message in the range to compress",
		pattern: "^m\\d{4}$",
	}),
	summary: Type.String({
		description: "A detailed technical summary replacing the compressed content",
		minLength: 20,
	}),
	topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for the compressed section" })),
});

type CompressArgs = Static<typeof CompressSchema>;

export interface CompressToolDetails {
	blockId: string;
	topic: string;
	range: string;
	messagesCompressed: number;
	summaryTokens: number;
}

export function createCompressTool(
	getDCPState: () => DCPState | undefined,
): AgentTool<typeof CompressSchema, CompressToolDetails, Theme> {
	return {
		name: "compress",
		label: "Compress",
		description: compressDescription,
		parameters: CompressSchema,
		async execute(_toolCallId: string, args: CompressArgs): Promise<AgentToolResult<CompressToolDetails>> {
			const state = getDCPState();
			if (!state) {
				return { content: [{ type: "text", text: "Error: DCP state not available" }] };
			}

			const messageIdMap = state.lastAssignedIdMap;
			if (!messageIdMap || messageIdMap.size === 0) {
				return {
					content: [
						{ type: "text", text: "Error: No message ID map available. Context must be processed first." },
					],
				};
			}

			// Validate IDs exist in the current message ID map
			const knownIds = new Set(messageIdMap.values());
			const sortedIds = Array.from(knownIds).sort();
			const idRange = sortedIds.length > 0 ? `${sortedIds[0]}-${sortedIds[sortedIds.length - 1]}` : "none";

			if (!knownIds.has(args.startId)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Message ID ${args.startId} not found in current context. Valid range: ${idRange} (${sortedIds.length} messages)`,
						},
					],
				};
			}
			if (!knownIds.has(args.endId)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Message ID ${args.endId} not found in current context. Valid range: ${idRange} (${sortedIds.length} messages)`,
						},
					],
				};
			}

			// Validate startId comes before endId numerically
			const startNum = parseInt(args.startId.slice(1), 10);
			const endNum = parseInt(args.endId.slice(1), 10);

			if (startNum > endNum) {
				return { content: [{ type: "text", text: "Error: startId must come before endId" }] };
			}

			// Create compression block using the index->ID map directly
			const messages = state.lastTransformMessages ?? [];
			const block = createBlock(state, {
				mode: "range",
				topic: args.topic ?? "untitled",
				startId: args.startId,
				endId: args.endId,
				summary: args.summary,
				messageIdMap,
				messages,
			});

			const summaryTokens = countTokens(args.summary);

			return {
				content: [
					{
						type: "text",
						text: `Compressed messages ${args.startId}-${args.endId} into block ${block.blockId}. Topic: ${args.topic || "untitled"}. Summary: ${summaryTokens} tokens replacing ${block.effectiveMessageIds.length} messages.`,
					},
				],
				details: {
					blockId: block.blockId,
					topic: args.topic || "untitled",
					range: `${args.startId}-${args.endId}`,
					messagesCompressed: block.effectiveMessageIds.length,
					summaryTokens,
				},
			};
		},
	};
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K tokens`;
	return `${tokens} tokens`;
}

export const compressToolRenderer = {
	renderCall(args: CompressArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const range = args.startId && args.endId ? `${args.startId}-${args.endId}` : "...";
		const topic = args.topic ? args.topic : undefined;
		const text = renderStatusLine(
			{ icon: "pending", title: "Compress", description: range, meta: topic ? [topic] : undefined },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CompressToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const isError = result.isError === true;
		const icon = options.isPartial ? "pending" : isError ? "error" : "success";
		const details = result.details;

		if (isError || !details) {
			const errorText = result.content?.find(c => c.type === "text")?.text ?? "Compression failed";
			const text = renderStatusLine({ icon: "error", title: "Compress", description: errorText }, uiTheme);
			return new Text(text, 0, 0);
		}

		const meta = [
			details.blockId,
			`${details.messagesCompressed} messages`,
			formatTokenCount(details.summaryTokens),
			details.topic,
		];
		const text = renderStatusLine({ icon, title: "Compress", description: details.range, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	mergeCallAndResult: true,
};
