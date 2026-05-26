import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { SlackBridge } from "@oh-my-pi/pi-coding-agent/slack/slack-bridge";
import type { SlackBridgeConfig } from "@oh-my-pi/pi-coding-agent/slack/slack-config";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

const CHANNEL_ID = "C_TEST_CHANNEL";
const BOT_USER_ID = "UBOT12345";
const SESSION_THREAD_TS = "1700000001.000001";

/** Captured event handlers from SocketModeClient.on() calls */
type EventHandler = (payload: { event: Record<string, unknown>; body: unknown; ack: () => Promise<void> }) => void;

function createMockSession() {
	const prompts: string[] = [];
	let aborted = false;
	const listeners: Array<(event: unknown) => void> = [];

	return {
		session: {
			sessionName: "test-session",
			sessionManager: {
				getCwd: () => "/tmp/test-cwd",
			},
			subscribe: (listener: (event: unknown) => void) => {
				listeners.push(listener);
				return () => {
					const idx = listeners.indexOf(listener);
					if (idx >= 0) listeners.splice(idx, 1);
				};
			},
			prompt: async (text: string) => {
				prompts.push(text);
			},
			abort: () => {
				aborted = true;
			},
		} as any,
		get prompts() {
			return prompts;
		},
		get aborted() {
			return aborted;
		},
	};
}

const config: SlackBridgeConfig = {
	appToken: "xapp-test-token",
	botToken: "xoxb-test-token",
	channelId: CHANNEL_ID,
};

describe("SlackBridge session-scoped routing", () => {
	let capturedHandlers: Map<string, EventHandler>;

	beforeEach(() => {
		capturedHandlers = new Map();

		// Capture event handlers registered via .on()
		vi.spyOn(SocketModeClient.prototype, "on").mockImplementation(function (
			this: SocketModeClient,
			event: string,
			handler: EventHandler,
		) {
			capturedHandlers.set(event, handler);
			return this;
		} as any);

		// Prevent real socket connections
		vi.spyOn(SocketModeClient.prototype, "start").mockResolvedValue({} as any);
		vi.spyOn(SocketModeClient.prototype, "disconnect").mockResolvedValue(undefined as any);

		// Mock all WebClient API calls
		vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method: string) => {
			if (method === "auth.test") {
				return { ok: true, user_id: BOT_USER_ID } as any;
			}
			if (method === "chat.postMessage") {
				return { ok: true, ts: SESSION_THREAD_TS } as any;
			}
			if (method === "assistant.threads.setStatus") {
				return { ok: true } as any;
			}
			return { ok: true } as any;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("start() creates a dedicated session thread via announcement message", async () => {
		const { session } = createMockSession();
		const bridge = new SlackBridge(session, config);

		await bridge.start();

		expect(bridge.status).toBe("connected");
		expect(bridge.threadTs).toBe(SESSION_THREAD_TS);
	});

	test("messages in the session thread are forwarded to the session", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const messageHandler = capturedHandlers.get("message")!;
		expect(messageHandler).toBeDefined();

		// Message in our thread — should be forwarded
		await messageHandler({
			event: {
				channel: CHANNEL_ID,
				user: "U_HUMAN",
				text: "do something",
				thread_ts: SESSION_THREAD_TS,
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.prompts).toContain("do something");
	});

	test("messages in a different thread are ignored", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const messageHandler = capturedHandlers.get("message")!;

		// Message in another thread — should be ignored
		await messageHandler({
			event: {
				channel: CHANNEL_ID,
				user: "U_HUMAN",
				text: "wrong thread message",
				thread_ts: "1700000099.999999",
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.prompts).toHaveLength(0);
	});

	test("top-level channel messages (no thread_ts) are ignored", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const messageHandler = capturedHandlers.get("message")!;

		// Top-level message (no thread_ts) — should be ignored
		await messageHandler({
			event: {
				channel: CHANNEL_ID,
				user: "U_HUMAN",
				text: "top level message",
				ts: "1700000050.000050",
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.prompts).toHaveLength(0);
	});

	test("top-level @mentions are ignored (session already has thread)", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const mentionHandler = capturedHandlers.get("app_mention")!;
		expect(mentionHandler).toBeDefined();

		// Top-level mention (no thread_ts) — should be ignored
		await mentionHandler({
			event: {
				channel: CHANNEL_ID,
				user: "U_HUMAN",
				text: "<@UBOT12345> do work",
				ts: "1700000060.000060",
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.prompts).toHaveLength(0);
	});

	test("@mentions within the session thread are forwarded", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const mentionHandler = capturedHandlers.get("app_mention")!;

		// Mention inside our thread — should be forwarded
		await mentionHandler({
			event: {
				channel: CHANNEL_ID,
				user: "U_HUMAN",
				text: "<@UBOT12345> run tests",
				thread_ts: SESSION_THREAD_TS,
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.prompts).toContain("run tests");
	});

	test("bot's own messages are ignored even in session thread", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const messageHandler = capturedHandlers.get("message")!;

		// Bot's own message — should be ignored
		await messageHandler({
			event: {
				channel: CHANNEL_ID,
				user: BOT_USER_ID,
				text: "bot response",
				thread_ts: SESSION_THREAD_TS,
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.prompts).toHaveLength(0);
	});

	test("messages in different channel are ignored", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const messageHandler = capturedHandlers.get("message")!;

		// Message in a different channel — should be ignored
		await messageHandler({
			event: {
				channel: "C_OTHER_CHANNEL",
				user: "U_HUMAN",
				text: "different channel message",
				thread_ts: SESSION_THREAD_TS,
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.prompts).toHaveLength(0);
	});

	test("/stop command in session thread aborts the session", async () => {
		const mock = createMockSession();
		const bridge = new SlackBridge(mock.session, config);
		await bridge.start();

		const messageHandler = capturedHandlers.get("message")!;

		await messageHandler({
			event: {
				channel: CHANNEL_ID,
				user: "U_HUMAN",
				text: "/stop",
				thread_ts: SESSION_THREAD_TS,
			},
			body: {},
			ack: async () => {},
		});

		await Bun.sleep(10);
		expect(mock.aborted).toBe(true);
		expect(mock.prompts).toHaveLength(0);
	});
});
