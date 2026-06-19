/**
 * Core Slack bridge class: manages Socket Mode connection, message routing.
 *
 * Each bridge instance is scoped to a single session. On start, it posts a
 * session announcement to create a dedicated thread. All subsequent interaction
 * is isolated to that thread — messages in other threads or top-level channel
 * messages are ignored. This prevents multiple oh-my-pi instances sharing the
 * same Slack app from interfering with each other.
 */

import { emitSecurityEvent, logger, SecurityEventType } from "@oh-my-pi/pi-utils";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { AgentSession } from "../session/agent-session";
import type { SlackBridgeConfig } from "./slack-config";
import { stripSlackFormatting } from "./slack-formatter";
import { SlackSessionObserver } from "./slack-session-observer";

export type SlackBridgeStatus = "disconnected" | "connecting" | "connected" | "error";

export class SlackBridge {
	#config: SlackBridgeConfig;
	#session: AgentSession;
	#socket: SocketModeClient;
	#web: WebClient;
	#observer: SlackSessionObserver;
	#unsubscribe: (() => void) | undefined;
	#status: SlackBridgeStatus = "disconnected";
	#botUserId: string | undefined;
	#statusListeners = new Set<(status: SlackBridgeStatus) => void>();

	constructor(session: AgentSession, config: SlackBridgeConfig) {
		this.#config = config;
		this.#session = session;

		this.#web = new WebClient(config.botToken);
		this.#socket = new SocketModeClient({
			appToken: config.appToken,
			autoReconnectEnabled: true,
		});

		this.#observer = new SlackSessionObserver({
			web: this.#web,
			channelId: config.channelId,
			threadTs: config.threadTs,
			onThreadCreated: ts => {
				logger.debug("Slack: thread created", { threadTs: ts });
			},
		});
	}

	get status(): SlackBridgeStatus {
		return this.#status;
	}

	get threadTs(): string | undefined {
		return this.#observer.threadTs;
	}

	/**
	 * Subscribe to bridge status changes.
	 */
	onStatusChange(listener: (status: SlackBridgeStatus) => void): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	/**
	 * Start the Slack bridge: validate tokens, connect Socket Mode, subscribe to session events.
	 */
	async start(): Promise<void> {
		this.#setStatus("connecting");

		// Validate bot token via auth.test
		try {
			const authResult = await this.#web.auth.test();
			if (!authResult.ok || !authResult.user_id) {
				this.#setStatus("error");
				throw new Error(`Slack auth.test failed: ${authResult.error ?? "unknown error"}`);
			}
			this.#botUserId = authResult.user_id;
			logger.debug("Slack: authenticated", { botUserId: this.#botUserId });
		} catch (err) {
			this.#setStatus("error");
			emitSecurityEvent(SecurityEventType.AUTH_FAILURE, "slack-bridge", "failure", {
				error: String(err),
			});
			throw err;
		}

		// Register Socket Mode event handlers
		this.#socket.on("message", async ({ event, body, ack }) => {
			await ack();
			this.#handleMessageEvent(event, body);
		});

		this.#socket.on("app_mention", async ({ event, body, ack }) => {
			await ack();
			this.#handleMentionEvent(event, body);
		});

		// Connect Socket Mode
		try {
			await this.#socket.start();
		} catch (err) {
			this.#setStatus("error");
			throw err;
		}

		// Create a dedicated thread for this session — unless reusing an existing thread
		// from a previous bridge in the same session (reconnect after /slack stop).
		if (!this.#observer.threadTs) {
			await this.#createSessionThread();
		}

		this.#setStatus("connected");

		// Subscribe to session events
		this.#unsubscribe = this.#session.subscribe(this.#observer.handleEvent);

		emitSecurityEvent(SecurityEventType.SESSION_START, "slack-bridge", "success", {
			channelId: this.#config.channelId,
			botUserId: this.#botUserId,
			threadTs: this.#observer.threadTs,
		});

		logger.debug("Slack bridge started", {
			channelId: this.#config.channelId,
			threadTs: this.#observer.threadTs,
		});
	}

	/**
	 * Stop the Slack bridge: disconnect Socket Mode, unsubscribe from session events.
	 */
	async stop(): Promise<void> {
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}

		try {
			await this.#socket.disconnect();
		} catch {
			// Ignore disconnect errors
		}

		this.#setStatus("disconnected");

		emitSecurityEvent(SecurityEventType.SESSION_END, "slack-bridge", "success", {
			channelId: this.#config.channelId,
		});

		logger.debug("Slack bridge stopped");
	}

	#setStatus(status: SlackBridgeStatus): void {
		this.#status = status;
		for (const listener of this.#statusListeners) {
			listener(status);
		}
	}

	/**
	 * Post a session announcement to create a dedicated thread for this bridge.
	 * All subsequent messages are isolated to this thread.
	 */
	async #createSessionThread(): Promise<void> {
		const sessionName = this.#session.sessionName;
		const cwd = this.#session.sessionManager.getCwd();
		const label = sessionName ? `*${sessionName}* (\`${cwd}\`)` : `\`${cwd}\``;
		const text = `Session connected: ${label}`;

		try {
			const result = await this.#web.chat.postMessage({
				channel: this.#config.channelId,
				text,
				blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
				unfurl_links: false,
			});

			if (result.ts) {
				this.#observer.threadTs = result.ts;
				logger.debug("Slack: session thread created", { threadTs: result.ts });
			}
		} catch (err) {
			logger.error("Slack: failed to create session thread", { error: String(err) });
			throw new Error(`Failed to create Slack session thread: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Handle a message event from Socket Mode.
	 * Session-scoped: only process messages within this bridge's dedicated thread.
	 */
	#handleMessageEvent(event: Record<string, unknown>, _body: unknown): void {
		// Ignore bot messages
		if (event.bot_id || event.subtype === "bot_message") return;
		if (event.user === this.#botUserId) return;

		// Only process messages in our channel
		if (event.channel !== this.#config.channelId) return;

		// Session-scoped: only respond to messages in our dedicated thread
		const threadTs = event.thread_ts as string | undefined;
		const ownThread = this.#observer.threadTs;
		if (!ownThread || !threadTs || threadTs !== ownThread) return;

		const text = this.#extractMessageText(event);
		if (text) {
			this.#forwardToSession(text, event);
		}
	}

	/**
	 * Handle an app_mention event.
	 * Session-scoped: only respond to mentions within this bridge's dedicated thread.
	 * Top-level @mentions are ignored — users must reply in the session thread.
	 */
	#handleMentionEvent(event: Record<string, unknown>, _body: unknown): void {
		if (event.channel !== this.#config.channelId) return;
		if (event.user === this.#botUserId) return;

		// Only respond to mentions within our dedicated thread
		const threadTs = event.thread_ts as string | undefined;
		const ownThread = this.#observer.threadTs;
		if (!ownThread || !threadTs || threadTs !== ownThread) return;

		const text = this.#extractMessageText(event);
		if (!text) return;

		this.#forwardToSession(text, event);
	}

	#extractMessageText(event: Record<string, unknown>): string | undefined {
		const rawText = event.text as string | undefined;
		if (!rawText) return undefined;

		const cleaned = stripSlackFormatting(rawText);
		return cleaned || undefined;
	}

	#forwardToSession(text: string, event: Record<string, unknown>): void {
		// Handle special commands
		if (text === "/stop") {
			logger.debug("Slack: /stop command received");
			this.#session.abort();
			return;
		}

		emitSecurityEvent(SecurityEventType.TOOL_EXECUTION, "slack-bridge:message-received", "success", {
			channelId: this.#config.channelId,
			userId: event.user as string | undefined,
		});

		// Show "thinking" status (best-effort, requires assistant:write scope)
		if (this.#observer.threadTs) {
			void this.#setThinkingStatus();
		}

		// Forward as a prompt — use followUp to queue if agent is already streaming
		void this.#session.prompt(text, { expandPromptTemplates: true, streamingBehavior: "followUp" });
	}

	async #setThinkingStatus(): Promise<void> {
		if (!this.#observer.threadTs) return;
		try {
			await this.#web.assistant.threads.setStatus({
				channel_id: this.#config.channelId,
				thread_ts: this.#observer.threadTs,
				status: "Thinking...",
			});
		} catch {
			// assistant:write scope may not be available — silently ignore
		}
	}
}

// Module-level active bridge singleton for slash command lifecycle management.
let activeBridge: SlackBridge | undefined;
let lastThreadTs: string | undefined;

export function getActiveSlackBridge(): SlackBridge | undefined {
	return activeBridge;
}

export function setActiveSlackBridge(bridge: SlackBridge | undefined): void {
	// Capture threadTs before clearing so reconnections reuse the same thread.
	if (activeBridge && !bridge) {
		lastThreadTs = activeBridge.threadTs ?? lastThreadTs;
	}
	activeBridge = bridge;
}

export function getLastSlackThreadTs(): string | undefined {
	return activeBridge?.threadTs ?? lastThreadTs;
}
