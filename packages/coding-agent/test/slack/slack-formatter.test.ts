import { describe, expect, test } from "bun:test";
import {
	formatAssistantText,
	formatCompletion,
	formatToolError,
	stripSlackFormatting,
} from "@oh-my-pi/pi-coding-agent/slack/slack-formatter";

describe("formatAssistantText", () => {
	test("formats short text into single message with markdown block", () => {
		const messages = formatAssistantText("Hello world");
		expect(messages).toHaveLength(1);
		expect(messages[0].text).toBe("Hello world");
		expect(messages[0].blocks).toBeDefined();
		expect(messages[0].blocks![0].type).toBe("markdown");
		expect((messages[0].blocks![0] as { type: "markdown"; text: string }).text).toBe("Hello world");
	});

	test("preserves standard markdown in blocks without conversion", () => {
		const md = "## Header\n\n- item 1\n- item 2\n\n```ts\nconst x = 1;\n```";
		const messages = formatAssistantText(md);
		expect(messages).toHaveLength(1);
		expect((messages[0].blocks![0] as { type: "markdown"; text: string }).text).toBe(md);
	});

	test("splits very long text into multiple messages at 12k boundary", () => {
		const longText = "x".repeat(50_000);
		const messages = formatAssistantText(longText);
		expect(messages.length).toBeGreaterThan(1);
		for (const msg of messages) {
			expect(msg.blocks).toHaveLength(1);
			expect((msg.blocks![0] as { type: "markdown"; text: string }).text.length).toBeLessThanOrEqual(12_000);
		}
	});

	test("split chunks do not start with leading newlines", () => {
		// Build text with paragraph breaks at known positions
		const para = "a".repeat(8000);
		const text = `${para}\n\n${para}\n\n${para}`;
		const messages = formatAssistantText(text);
		for (const msg of messages) {
			const blockText = (msg.blocks![0] as { type: "markdown"; text: string }).text;
			expect(blockText).not.toMatch(/^\n/);
		}
	});
});

describe("formatToolError", () => {
	test("formats error with tool name", () => {
		const msg = formatToolError("write", "Permission denied");
		expect(msg.text).toContain("write");
		const block = msg.blocks![1] as { type: "section"; text: { type: "mrkdwn"; text: string } };
		expect(block.text.text).toContain("Permission denied");
	});

	test("truncates long error messages", () => {
		const longError = "e".repeat(1000);
		const msg = formatToolError("bash", longError);
		const block = msg.blocks![1] as { type: "section"; text: { type: "mrkdwn"; text: string } };
		expect(block.text.text.length).toBeLessThan(600);
		expect(block.text.text).toContain("...");
	});
});

describe("formatCompletion", () => {
	test("returns completion message", () => {
		const msg = formatCompletion();
		expect(msg.text).toBe("Done");
		expect(msg.blocks![0].type).toBe("context");
	});
});

describe("stripSlackFormatting", () => {
	test("removes user mentions", () => {
		expect(stripSlackFormatting("<@U12345> hello")).toBe("hello");
		expect(stripSlackFormatting("<@U12345|user> hello")).toBe("hello");
	});

	test("converts channel mentions", () => {
		expect(stripSlackFormatting("<#C12345|general>")).toBe("#general");
	});

	test("converts URL formatting", () => {
		expect(stripSlackFormatting("<https://example.com|Example>")).toBe("Example");
		expect(stripSlackFormatting("<https://example.com>")).toBe("https://example.com");
	});

	test("removes special commands", () => {
		expect(stripSlackFormatting("<!here> attention")).toBe("attention");
		expect(stripSlackFormatting("<!channel>")).toBe("");
		expect(stripSlackFormatting("<!everyone|everyone>")).toBe("");
	});

	test("handles mixed content", () => {
		const input = "<@U123> please check <https://example.com|this link> in <#C456|dev>";
		const result = stripSlackFormatting(input);
		expect(result).toBe("please check this link in #dev");
	});
});
