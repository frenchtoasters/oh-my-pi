import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SlackSessionObserver } from "@oh-my-pi/pi-coding-agent/slack/slack-session-observer";

/** Cast a partial event shape to the full event type */
function ev(partial: Record<string, unknown>): AgentSessionEvent {
	return partial as unknown as AgentSessionEvent;
}

function createMockWeb() {
	const postMessageCalls: unknown[] = [];

	const web = {
		chat: {
			postMessage: async (args: unknown) => {
				postMessageCalls.push(args);
				return { ok: true, ts: "1234567890.123456" };
			},
		},
	};

	return { web: web as any, postMessageCalls };
}

describe("SlackSessionObserver", () => {
	test("posts a single message on message_end", async () => {
		const { web, postMessageCalls } = createMockWeb();
		const observer = new SlackSessionObserver({
			web,
			channelId: "C123",
			threadTs: "1700000000.000000",
			onThreadCreated: () => {},
		});

		// message_start and message_update should NOT post anything
		observer.handleEvent(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
		observer.handleEvent(ev({ type: "message_update", message: { role: "assistant", content: "Hello" } }));
		observer.handleEvent(ev({ type: "message_update", message: { role: "assistant", content: "Hello world" } }));
		await Bun.sleep(10);

		expect(postMessageCalls.length).toBe(0);

		// Only message_end triggers a post
		observer.handleEvent(ev({ type: "message_end", message: { role: "assistant", content: "Hello world, done." } }));
		await Bun.sleep(10);

		expect(postMessageCalls.length).toBe(1);
		expect((postMessageCalls[0] as any).channel).toBe("C123");
		expect((postMessageCalls[0] as any).thread_ts).toBe("1700000000.000000");
	});

	test("posts full final text, not incremental", async () => {
		const { web, postMessageCalls } = createMockWeb();
		const observer = new SlackSessionObserver({
			web,
			channelId: "C123",
			threadTs: "1700000000.000000",
			onThreadCreated: () => {},
		});

		observer.handleEvent(ev({ type: "message_end", message: { role: "assistant", content: "Complete response" } }));
		await Bun.sleep(10);

		expect(postMessageCalls.length).toBe(1);
		// The text field is the first 200 chars (preview), blocks contain the full markdown
		expect((postMessageCalls[0] as any).text).toBe("Complete response");
		const blocks = (postMessageCalls[0] as any).blocks;
		expect(blocks[0].type).toBe("markdown");
		expect(blocks[0].text).toBe("Complete response");
	});

	test("does not post for message_update events", async () => {
		const { web, postMessageCalls } = createMockWeb();
		const observer = new SlackSessionObserver({
			web,
			channelId: "C123",
			threadTs: "1700000000.000000",
			onThreadCreated: () => {},
		});

		// Fire many updates — none should post
		for (let i = 0; i < 50; i++) {
			observer.handleEvent(ev({ type: "message_update", message: { role: "assistant", content: `token ${i}` } }));
		}
		await Bun.sleep(100);

		expect(postMessageCalls.length).toBe(0);
	});

	test("posts error notification on tool_execution_end with isError", async () => {
		const { web, postMessageCalls } = createMockWeb();
		const observer = new SlackSessionObserver({
			web,
			channelId: "C123",
			threadTs: "1700000000.000000",
			onThreadCreated: () => {},
		});

		observer.handleEvent(
			ev({ type: "tool_execution_end", toolCallId: "tc_1", toolName: "bash", result: "", isError: true }),
		);
		await Bun.sleep(10);

		expect(postMessageCalls.length).toBe(1);
		expect((postMessageCalls[0] as any).text).toContain("bash");
	});

	test("does not post for successful tool_execution_end", async () => {
		const { web, postMessageCalls } = createMockWeb();
		const observer = new SlackSessionObserver({
			web,
			channelId: "C123",
			threadTs: "1700000000.000000",
			onThreadCreated: () => {},
		});

		observer.handleEvent(
			ev({ type: "tool_execution_end", toolCallId: "tc_1", toolName: "read", result: "ok", isError: false }),
		);
		await Bun.sleep(10);

		expect(postMessageCalls.length).toBe(0);
	});

	test("posts completion on agent_end", async () => {
		const { web, postMessageCalls } = createMockWeb();
		const observer = new SlackSessionObserver({
			web,
			channelId: "C123",
			threadTs: "1700000000.000000",
			onThreadCreated: () => {},
		});

		observer.handleEvent(ev({ type: "agent_end", messages: [] }));
		await Bun.sleep(10);

		expect(postMessageCalls.length).toBe(1);
		expect((postMessageCalls[0] as any).text).toBe("Done");
	});

	test("sets threadTs from first post when none provided", async () => {
		const { web } = createMockWeb();
		let capturedTs: string | undefined;
		const observer = new SlackSessionObserver({
			web,
			channelId: "C123",
			threadTs: undefined,
			onThreadCreated: ts => {
				capturedTs = ts;
			},
		});

		observer.handleEvent(ev({ type: "message_end", message: { role: "assistant", content: "First" } }));
		await Bun.sleep(10);

		expect(capturedTs).toBe("1234567890.123456");
		expect(observer.threadTs).toBe("1234567890.123456");
	});
});
