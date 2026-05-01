import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { assignMessageIds, injectMessageIdTags, stripMessageIdTags } from "../../src/session/compaction/message-ids";

describe("message-ids", () => {
	it("assigns sequential IDs to standard messages", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [], timestamp: 2 },
			{ role: "toolResult", toolCallId: "1", toolName: "t", content: [], isError: false, timestamp: 3 },
		] as any;

		const idMap = assignMessageIds(messages);
		expect(idMap.get(0)).toBe("m0001");
		expect(idMap.get(1)).toBe("m0002");
		expect(idMap.get(2)).toBe("m0003");
	});

	it("skips custom message roles", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "bashExecution" as any, content: "cmd", timestamp: 2 },
			{ role: "assistant", content: [], timestamp: 3 },
		] as any;

		const idMap = assignMessageIds(messages);
		expect(idMap.get(0)).toBe("m0001");
		expect(idMap.has(1)).toBe(false);
		expect(idMap.get(2)).toBe("m0002");
	});

	it("skips messages with excludeFromContext", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: 1, excludeFromContext: true } as any,
			{ role: "assistant", content: [], timestamp: 2 },
		] as any;

		const idMap = assignMessageIds(messages);
		expect(idMap.has(0)).toBe(false);
		expect(idMap.get(1)).toBe("m0001");
	});

	it("injectMessageIdTags returns new array", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }] as any;
		const idMap = new Map([[0, "m0001"]]);

		const result = injectMessageIdTags(messages, idMap);
		expect(result).not.toBe(messages);
		expect(result[0]).not.toBe(messages[0]);
	});

	it("injectMessageIdTags adds tags to user string content", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }] as any;
		const idMap = new Map([[0, "m0001"]]);

		const result = injectMessageIdTags(messages, idMap);
		const content = (result[0] as any).content;
		expect(content).toBeInstanceOf(Array);
		expect(content[0].text).toBe("<dcp-message-id>m0001</dcp-message-id>\nhi");
	});

	it("injectMessageIdTags adds tags to assistant messages", () => {
		const messages: AgentMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		] as any;
		const idMap = new Map([[0, "m0001"]]);

		const result = injectMessageIdTags(messages, idMap);
		const content = (result[0] as any).content;
		expect(content[0].text).toBe("<dcp-message-id>m0001</dcp-message-id>\nhi");
	});

	it("injectMessageIdTags adds tags to toolResult messages", () => {
		const messages: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "t",
				content: [{ type: "text", text: "data" }],
				isError: false,
				timestamp: 3,
			},
		] as any;
		const idMap = new Map([[0, "m0001"]]);

		const result = injectMessageIdTags(messages, idMap);
		const content = (result[0] as any).content;
		expect(content[0].text).toBe("<dcp-message-id>m0001</dcp-message-id>\ndata");
	});

	it("stripMessageIdTags removes tags from text", () => {
		const text = "<dcp-message-id>m0001</dcp-message-id>\nhi there";
		expect(stripMessageIdTags(text)).toBe("hi there");
	});

	it("stripMessageIdTags handles text without tags", () => {
		const text = "hi there";
		expect(stripMessageIdTags(text)).toBe("hi there");
	});

	it("injectMessageIdTags does not mutate original content objects", () => {
		const textContent = { type: "text" as const, text: "original" };
		const messages: AgentMessage[] = [{ role: "assistant", content: [textContent], timestamp: 1 }] as any;
		const idMap = new Map([[0, "m0001"]]);

		const result = injectMessageIdTags(messages, idMap);
		// Original content object must be untouched
		expect(textContent.text).toBe("original");
		// New content should have tag
		expect((result[0] as any).content[0].text).toContain("m0001");
		// Content array should be a different reference
		expect((result[0] as any).content).not.toBe((messages[0] as any).content);
	});

	it("idempotency - same input produces same output", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }] as any;

		const map1 = assignMessageIds(messages);
		const map2 = assignMessageIds(messages);
		expect(map1).toEqual(map2);
	});
});
