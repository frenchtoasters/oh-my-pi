import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	assignMessageIds,
	computeMessageFingerprint,
	injectMessageIdTags,
	stripMessageIdTags,
} from "../../src/session/compaction/message-ids";

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

	describe("computeMessageFingerprint", () => {
		it("assistant with toolCalls uses sorted tool call IDs", () => {
			const msg: AgentMessage = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc_beta", name: "write", arguments: {} },
					{ type: "toolCall", id: "tc_alpha", name: "read", arguments: {} },
				],
			} as any;
			// IDs are sorted, so tc_alpha comes first
			expect(computeMessageFingerprint(msg)).toBe("assistant:tc_alpha,tc_beta");
		});

		it("same assistant message produces same fingerprint across calls", () => {
			const msg: AgentMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
			} as any;
			const fp1 = computeMessageFingerprint(msg);
			const fp2 = computeMessageFingerprint(msg);
			expect(fp1).toBe(fp2);
		});

		it("different tool call IDs produce different fingerprints", () => {
			const msg1: AgentMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
			} as any;
			const msg2: AgentMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "read", arguments: {} }],
			} as any;
			expect(computeMessageFingerprint(msg1)).not.toBe(computeMessageFingerprint(msg2));
		});

		it("toolResult uses toolCallId directly", () => {
			const msg: AgentMessage = {
				role: "toolResult",
				toolCallId: "tc_unique_42",
				toolName: "read",
				content: [{ type: "text", text: "data" }],
				isError: false,
			} as any;
			expect(computeMessageFingerprint(msg)).toBe("toolResult:tc_unique_42");
		});

		it("text-only assistant uses hash of content and timestamp", () => {
			const msg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "thinking" }],
				timestamp: 1000,
			} as any;
			const fp = computeMessageFingerprint(msg);
			expect(fp).toStartWith("assistant:text:");
			// Deterministic
			expect(fp).toBe(computeMessageFingerprint(msg));
		});

		it("user messages with different content produce different fingerprints", () => {
			const msg1: AgentMessage = { role: "user", content: "hello", timestamp: 1 } as any;
			const msg2: AgentMessage = { role: "user", content: "world", timestamp: 1 } as any;
			expect(computeMessageFingerprint(msg1)).not.toBe(computeMessageFingerprint(msg2));
		});

		it("user messages with different timestamps produce different fingerprints", () => {
			const msg1: AgentMessage = { role: "user", content: "hello", timestamp: 1 } as any;
			const msg2: AgentMessage = { role: "user", content: "hello", timestamp: 2 } as any;
			expect(computeMessageFingerprint(msg1)).not.toBe(computeMessageFingerprint(msg2));
		});

		it("developer messages are distinct from user messages", () => {
			const user: AgentMessage = { role: "user", content: "note", timestamp: 1 } as any;
			const dev: AgentMessage = { role: "developer", content: "note", timestamp: 1 } as any;
			expect(computeMessageFingerprint(user)).not.toBe(computeMessageFingerprint(dev));
		});
	});
});
