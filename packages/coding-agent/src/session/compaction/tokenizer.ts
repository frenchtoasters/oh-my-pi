import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

let anthropicTokenizerModule: { countTokens: (text: string) => number } | undefined;
let loadAttempted = false;

function getTokenizer(): typeof anthropicTokenizerModule {
	if (!loadAttempted) {
		loadAttempted = true;
		try {
			// Use require() for synchronous loading with graceful fallback.
			// The @anthropic-ai/tokenizer module may fail in some environments
			// (WASM/native binding issues).
			anthropicTokenizerModule = require("@anthropic-ai/tokenizer");
		} catch (err) {
			logger.warn("Failed to load @anthropic-ai/tokenizer, falling back to heuristic", { error: String(err) });
		}
	}
	return anthropicTokenizerModule;
}

function heuristicCount(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

function isAnthropicProvider(provider?: string): boolean {
	if (!provider) return false;
	const p = provider.toLowerCase();
	return p.startsWith("anthropic") || p.startsWith("claude");
}

/**
 * Count tokens in a text string.
 * Uses @anthropic-ai/tokenizer for Anthropic providers, chars/4 heuristic otherwise.
 */
export function countTokens(text: string, provider?: string): number {
	if (text.length === 0) return 0;

	if (isAnthropicProvider(provider) && getTokenizer()) {
		try {
			return getTokenizer()!.countTokens(text);
		} catch (err) {
			logger.warn("Anthropic tokenizer failed, falling back to heuristic", { error: String(err) });
		}
	}

	return heuristicCount(text);
}

function extractTextFromMessage(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b)
					.map(b => b.text)
					.join("");
			}
			return "";
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			const parts: string[] = [];
			for (const block of assistant.content) {
				if (block.type === "text") parts.push(block.text);
				else if (block.type === "thinking") parts.push(block.thinking);
				else if (block.type === "toolCall") {
					parts.push(block.name);
					parts.push(JSON.stringify(block.arguments));
				}
			}
			return parts.join("");
		}
		case "toolResult": {
			const result = message as ToolResultMessage;
			if (typeof result.content === "string") return result.content;
			return result.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b)
				.map(b => b.text)
				.join("");
		}
		default:
			return "";
	}
}

/**
 * Count tokens across an array of messages.
 * Uses heuristic (chars/4) for counting — provider-specific tokenization
 * only used when explicitly requested via countTokens().
 */
export function countTokensForMessages(messages: AgentMessage[], provider?: string): number {
	let total = 0;
	for (const message of messages) {
		const text = extractTextFromMessage(message);
		total += countTokens(text, provider);
	}
	return total;
}
