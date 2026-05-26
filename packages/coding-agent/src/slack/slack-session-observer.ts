/**
 * AgentSessionEvent listener that posts completed assistant messages to Slack.
 *
 * Posts a single message per assistant turn on `message_end` — no incremental
 * streaming, no debounced updates. This avoids rate limiting and message spam.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { WebClient } from "@slack/web-api";
import type { AgentSessionEvent } from "../session/agent-session";
import { formatAssistantText, formatCompletion, formatToolError, type SlackMessage } from "./slack-formatter";

export interface SlackSessionObserverConfig {
	web: WebClient;
	channelId: string;
	threadTs: string | undefined;
	/** Called when the first message is posted — provides the thread_ts to use */
	onThreadCreated: (threadTs: string) => void;
}

export class SlackSessionObserver {
	#web: WebClient;
	#channelId: string;
	#threadTs: string | undefined;
	#onThreadCreated: (threadTs: string) => void;

	constructor(config: SlackSessionObserverConfig) {
		this.#web = config.web;
		this.#channelId = config.channelId;
		this.#threadTs = config.threadTs;
		this.#onThreadCreated = config.onThreadCreated;
	}

	get threadTs(): string | undefined {
		return this.#threadTs;
	}

	set threadTs(ts: string | undefined) {
		this.#threadTs = ts;
	}

	/**
	 * Handle an agent session event. Only posts to Slack on:
	 * - message_end (assistant) → full response as a single message
	 * - tool_execution_end (error) → error notification
	 * - agent_end → completion indicator
	 */
	handleEvent = (event: AgentSessionEvent): void => {
		switch (event.type) {
			case "message_end":
				if (event.message.role === "assistant") {
					void this.#postAssistantMessage(event.message);
				}
				break;

			case "tool_execution_end":
				if (event.isError) {
					void this.#postMessage(formatToolError(event.toolName, "Tool execution failed"));
				}
				break;

			case "agent_end":
				void this.#postMessage(formatCompletion());
				break;
		}
	};

	// ========================================================================
	// Private
	// ========================================================================

	async #postAssistantMessage(message: { content?: unknown }): Promise<void> {
		const text = this.#extractTextContent(message);
		if (!text) return;

		const messages = formatAssistantText(text);
		for (const msg of messages) {
			await this.#postMessage(msg);
		}
	}

	async #postMessage(msg: SlackMessage): Promise<void> {
		try {
			const result = await this.#web.chat.postMessage({
				channel: this.#channelId,
				thread_ts: this.#threadTs,
				reply_broadcast: false,
				unfurl_links: false,
				text: msg.text,
				blocks: msg.blocks,
			});

			if (result.ts && !this.#threadTs) {
				this.#threadTs = result.ts;
				this.#onThreadCreated(result.ts);
			}
		} catch (err) {
			logger.error("Slack: failed to post message", { error: String(err) });
		}
	}

	#extractTextContent(message: { content?: unknown }): string | undefined {
		const content = message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return undefined;

		const textParts: string[] = [];
		for (const part of content) {
			if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
				textParts.push(String(part.text));
			}
		}
		return textParts.length > 0 ? textParts.join("") : undefined;
	}
}
