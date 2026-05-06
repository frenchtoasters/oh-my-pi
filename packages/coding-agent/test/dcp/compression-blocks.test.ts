import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	createBlock,
	deactivateBlock,
	filterCompressedRanges,
	getActiveBlocks,
	reactivateBlock,
} from "../../src/session/compaction/compression-blocks";
import { createDCPState } from "../../src/session/compaction/dcp-state";
import { assignMessageIds } from "../../src/session/compaction/message-ids";

describe("Compression Blocks", () => {
	it("createBlock generates sequential block IDs", () => {
		const state = createDCPState();
		const map = new Map([
			[0, "m0001"],
			[1, "m0002"],
		]);

		const b1 = createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0001",
			endId: "m0001",
			summary: "s1",
			messageIdMap: map,
		});
		const b2 = createBlock(state, {
			mode: "range",
			topic: "t2",
			startId: "m0002",
			endId: "m0002",
			summary: "s2",
			messageIdMap: map,
		});

		expect(b1.blockId).toBe("b1");
		expect(b2.blockId).toBe("b2");
	});

	it("createBlock computes effectiveMessageIds from range", () => {
		const state = createDCPState();
		const map = new Map([
			[0, "m0001"],
			[1, "m0002"],
			[2, "m0003"],
			[3, "m0004"],
			[4, "m0005"],
		]);

		const b1 = createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0002",
			endId: "m0005",
			summary: "s1",
			messageIdMap: map,
		});

		expect(b1.effectiveMessageIds).toEqual(["m0002", "m0003", "m0004", "m0005"]);
	});

	it("createBlock consumes overlapping active blocks", () => {
		const state = createDCPState();
		const map = new Map([
			[0, "m0001"],
			[1, "m0002"],
			[2, "m0003"],
		]);

		createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0001",
			endId: "m0001",
			summary: "s1",
			messageIdMap: map,
		});
		const b2 = createBlock(state, {
			mode: "range",
			topic: "t2",
			startId: "m0001",
			endId: "m0002",
			summary: "s2",
			messageIdMap: map,
		});

		expect(state.compressionBlocks.get("b1")?.active).toBe(false);
		expect(b2.consumedBlockIds).toContain("b1");
	});

	it("deactivateBlock sets active=false and deactivatedByUser=true", () => {
		const state = createDCPState();
		const map = new Map([[0, "m0001"]]);
		createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0001",
			endId: "m0001",
			summary: "s1",
			messageIdMap: map,
		});

		deactivateBlock(state, "b1");
		const b = state.compressionBlocks.get("b1");
		expect(b?.active).toBe(false);
		expect(b?.deactivatedByUser).toBe(true);
	});

	it("deactivateBlock throws when block has active children", () => {
		const state = createDCPState();
		const map = new Map([
			[0, "m0001"],
			[1, "m0002"],
		]);
		const parent = createBlock(state, {
			mode: "range",
			topic: "p",
			startId: "m0001",
			endId: "m0002",
			summary: "s",
			messageIdMap: map,
		});

		// Mock child relationship
		state.compressionBlocks.set("b1", { ...parent, parentBlockIds: [] });
		state.compressionBlocks.set("b2", { ...parent, blockId: "b2", parentBlockIds: ["b1"] });

		expect(() => deactivateBlock(state, "b1")).toThrow("Cannot deactivate block with active children");
	});

	it("deactivateBlock throws for unknown blockId", () => {
		const state = createDCPState();
		expect(() => deactivateBlock(state, "b99")).toThrow("Block not found");
	});

	it("reactivateBlock restores block to active", () => {
		const state = createDCPState();
		const map = new Map([[0, "m0001"]]);
		createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0001",
			endId: "m0001",
			summary: "s1",
			messageIdMap: map,
		});
		deactivateBlock(state, "b1");

		reactivateBlock(state, "b1");
		expect(state.compressionBlocks.get("b1")?.active).toBe(true);
		expect(state.compressionBlocks.get("b1")?.deactivatedByUser).toBe(false);
	});

	it("reactivateBlock throws when consumed blocks are active", () => {
		const state = createDCPState();
		const map = new Map([
			[0, "m0001"],
			[1, "m0002"],
		]);
		createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0001",
			endId: "m0001",
			summary: "s1",
			messageIdMap: map,
		});
		createBlock(state, {
			mode: "range",
			topic: "t2",
			startId: "m0001",
			endId: "m0002",
			summary: "s2",
			messageIdMap: map,
		});

		// b1 is consumed by b2. b1 is inactive. This is fine.
		// We try to reactivate b1. Should be fine, but wait, the check is if consumed blocks are active.
		// Consumed blocks are the children being consumed.

		// Test passes if it throws when b1 attempts to reactivate while b2 (the consumer) is active,
		// wait the rule is: "Cannot reactivate: consumed blocks are active".
		// If I try to reactivate b1, and b2 is active, b1 shouldn't be active?
		// Actually, the implementation logic is: reactivateBlock checks if its *own* consumedBlockIds are active.
		// That seems backwards in the spec prompt? "Cannot reactivate: consumed blocks are active".
		// Ah, maybe the spec meant "parents"? I will follow the prompt exactly: "Cannot reactivate: consumed blocks are active".

		// Let's create a scenario where this triggers.
		// If I create block b3, and it consumes b2.
		createBlock(state, {
			mode: "range",
			topic: "t3",
			startId: "m0001",
			endId: "m0002",
			summary: "s3",
			messageIdMap: map,
		});

		// Now b2 is inactive.
		expect(() => reactivateBlock(state, "b2")).toThrow("Cannot reactivate: consumed blocks are active");
	});

	it("getActiveBlocks returns only active blocks sorted by ID", () => {
		const state = createDCPState();
		const map = new Map([
			[0, "m0001"],
			[1, "m0002"],
		]);
		createBlock(state, {
			mode: "range",
			topic: "t2",
			startId: "m0002",
			endId: "m0002",
			summary: "s2",
			messageIdMap: map,
		});
		createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0001",
			endId: "m0001",
			summary: "s1",
			messageIdMap: map,
		});

		const active = getActiveBlocks(state);
		expect(active.length).toBe(2);
		expect(active[0].blockId).toBe("b1");
		expect(active[1].blockId).toBe("b2");
	});

	it("filterCompressedRanges replaces message range with summary", () => {
		const state = createDCPState();
		const map = new Map([
			[0, "m0001"],
			[1, "m0002"],
			[2, "m0003"],
		]);
		createBlock(state, {
			mode: "range",
			topic: "topic",
			startId: "m0001",
			endId: "m0002",
			summary: "summary",
			messageIdMap: map,
		});

		const msg1: AgentMessage = { role: "user", content: "m1", timestamp: 1 };
		const msg2: AgentMessage = { role: "user", content: "m2", timestamp: 2 };
		const msg3: AgentMessage = { role: "user", content: "m3", timestamp: 3 };
		const msgs = [msg1, msg2, msg3];

		const filtered = filterCompressedRanges(msgs, state, map);

		expect(filtered.length).toBe(2); // 1 summary + 1 kept message
		expect(filtered[0].role).toBe("developer");
		expect(filtered[1]).toBe(msg3);
	});

	it("filterCompressedRanges does not mutate input", () => {
		const state = createDCPState();
		const map = new Map([[0, "m0001"]]);
		createBlock(state, {
			mode: "range",
			topic: "t1",
			startId: "m0001",
			endId: "m0001",
			summary: "s1",
			messageIdMap: map,
		});

		const msgs = [Object.freeze({ role: "user", content: "m1", timestamp: 1 }) as AgentMessage];

		expect(() => filterCompressedRanges(msgs, state, map)).not.toThrow();
	});

	describe("filterCompressedRanges tool-pair integrity", () => {
		it("removes orphaned toolResults when assistant is in compression range", () => {
			const state = createDCPState();
			const map = new Map([
				[0, "m0001"],
				[1, "m0002"],
				[2, "m0003"],
				[3, "m0004"],
			]);
			const messages: AgentMessage[] = [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
						{ type: "toolCall", id: "tc2", name: "write", arguments: {} },
					],
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "result1" }],
					isError: false,
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc2",
					toolName: "write",
					content: [{ type: "text", text: "result2" }],
					isError: false,
				} as any,
				{ role: "user", content: "after", timestamp: 4 } as any,
			];

			createBlock(state, {
				mode: "range",
				topic: "t",
				startId: "m0001",
				endId: "m0001",
				summary: "s",
				messageIdMap: map,
			});

			const result = filterCompressedRanges(messages, state, map);
			expect(result.length).toBe(2);
			expect(result[0].role).toBe("developer");
			expect(result[1].role).toBe("user");
		});

		it("removes orphaned assistant when all its toolResults are in compression range", () => {
			const state = createDCPState();
			const map = new Map([
				[0, "m0001"],
				[1, "m0002"],
				[2, "m0003"],
				[3, "m0004"],
			]);
			const messages: AgentMessage[] = [
				{ role: "user", content: "before", timestamp: 1 } as any,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "thinking..." },
						{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
					],
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
				} as any,
				{ role: "user", content: "after", timestamp: 4 } as any,
			];

			createBlock(state, {
				mode: "range",
				topic: "t",
				startId: "m0003",
				endId: "m0003",
				summary: "s",
				messageIdMap: map,
			});

			const result = filterCompressedRanges(messages, state, map);
			expect(result.length).toBe(3);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("developer");
			expect(result[2].role).toBe("user");
		});

		it("forward expansion removes ALL toolResults when assistant with multiple toolCalls is compressed", () => {
			const state = createDCPState();
			const map = new Map([
				[0, "m0001"],
				[1, "m0002"],
				[2, "m0003"],
				[3, "m0004"],
				[4, "m0005"],
			]);
			const messages: AgentMessage[] = [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "analysis" },
						{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
						{ type: "toolCall", id: "tc2", name: "write", arguments: {} },
						{ type: "toolCall", id: "tc3", name: "grep", arguments: {} },
					],
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "r1" }],
					isError: false,
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc2",
					toolName: "write",
					content: [{ type: "text", text: "r2" }],
					isError: false,
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc3",
					toolName: "grep",
					content: [{ type: "text", text: "r3" }],
					isError: false,
				} as any,
				{ role: "user", content: "after", timestamp: 5 } as any,
			];

			createBlock(state, {
				mode: "range",
				topic: "t",
				startId: "m0001",
				endId: "m0003",
				summary: "s",
				messageIdMap: map,
			});

			const result = filterCompressedRanges(messages, state, map);
			expect(result.length).toBe(2);
			expect(result[0].role).toBe("developer");
			expect(result[1].role).toBe("user");
		});

		it("no-op when complete tool group already in range", () => {
			const state = createDCPState();
			const map = new Map([
				[0, "m0001"],
				[1, "m0002"],
				[2, "m0003"],
				[3, "m0004"],
			]);
			const messages: AgentMessage[] = [
				{ role: "user", content: "before", timestamp: 1 } as any,
				{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] } as any,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
				} as any,
				{ role: "user", content: "after", timestamp: 4 } as any,
			];

			createBlock(state, {
				mode: "range",
				topic: "t",
				startId: "m0002",
				endId: "m0003",
				summary: "s",
				messageIdMap: map,
			});

			const result = filterCompressedRanges(messages, state, map);
			expect(result.length).toBe(3);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("developer");
			expect(result[2].role).toBe("user");
		});

		it("summary anchor not shifted by forward expansion", () => {
			const state = createDCPState();
			const map = new Map([
				[0, "m0001"],
				[1, "m0002"],
				[2, "m0003"],
				[3, "m0004"],
			]);
			const messages: AgentMessage[] = [
				{ role: "user", content: "before", timestamp: 1 } as any,
				{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] } as any,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
				} as any,
				{ role: "user", content: "after", timestamp: 4 } as any,
			];

			createBlock(state, {
				mode: "range",
				topic: "t",
				startId: "m0002",
				endId: "m0002",
				summary: "s",
				messageIdMap: map,
			});

			const result = filterCompressedRanges(messages, state, map);
			expect(result.length).toBe(3);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("developer");
			expect(result[2].role).toBe("user");
		});

		it("mixed compression range with tool-paired and plain messages", () => {
			const state = createDCPState();
			const map = new Map([
				[0, "m0001"],
				[1, "m0002"],
				[2, "m0003"],
				[3, "m0004"],
				[4, "m0005"],
			]);
			const messages: AgentMessage[] = [
				{ role: "user", content: "before", timestamp: 1 } as any,
				{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] } as any,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
				} as any,
				{ role: "developer", content: "system note", timestamp: 4 } as any,
				{ role: "user", content: "after", timestamp: 5 } as any,
			];

			createBlock(state, {
				mode: "range",
				topic: "t",
				startId: "m0002",
				endId: "m0004",
				summary: "s",
				messageIdMap: map,
			});

			const result = filterCompressedRanges(messages, state, map);
			expect(result.length).toBe(3);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("developer");
			expect(result[2].role).toBe("user");
		});
	});

	describe("fingerprint-based matching", () => {
		it("correctly targets messages after dedup shifts indices", () => {
			const state = createDCPState();

			// Original 7-message array
			const originalMessages: AgentMessage[] = [
				{ role: "user", content: "start", timestamp: 1 } as any,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "dup1", name: "read", arguments: { file: "a.ts" } }],
				} as any,
				{
					role: "toolResult",
					toolCallId: "dup1",
					toolName: "read",
					content: [{ type: "text", text: "file content" }],
					isError: false,
				} as any,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc_target", name: "search", arguments: {} }],
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc_target",
					toolName: "search",
					content: [{ type: "text", text: "search results" }],
					isError: false,
				} as any,
				{ role: "user", content: "continue", timestamp: 6 } as any,
				{ role: "assistant", content: [{ type: "text", text: "sure" }], timestamp: 7 } as any,
			];

			// Step 1: Assign IDs on the original array
			const originalIdMap = assignMessageIds(originalMessages);
			// originalIdMap: 0->m0001, 1->m0002, 2->m0003, 3->m0004, 4->m0005, 5->m0006, 6->m0007

			// Step 2: Create a compression block targeting m0004-m0005 (the search tool call + result)
			createBlock(state, {
				mode: "range",
				topic: "search phase",
				startId: "m0004",
				endId: "m0005",
				summary: "Searched the codebase",
				messageIdMap: originalIdMap,
				messages: originalMessages,
			});

			// Verify the block has fingerprints
			const block = state.compressionBlocks.get("b1")!;
			expect(block.effectiveFingerprints.length).toBe(2);
			expect(block.effectiveFingerprints[0]).toBe("assistant:tc_target");
			expect(block.effectiveFingerprints[1]).toBe("toolResult:tc_target");

			// Step 3: Simulate dedup removing messages at indices 1 and 2 (the dup1 tool call + result)
			const postDedupMessages = [
				originalMessages[0], // user: start
				originalMessages[3], // assistant: tc_target (was index 3, now index 1)
				originalMessages[4], // toolResult: tc_target (was index 4, now index 2)
				originalMessages[5], // user: continue
				originalMessages[6], // assistant: text "sure"
			];

			// Step 4: Re-assign IDs on the shifted array
			const postDedupIdMap = assignMessageIds(postDedupMessages);
			// postDedupIdMap: 0->m0001, 1->m0002, 2->m0003, 3->m0004, 4->m0005
			// OLD m0004 is now m0002, OLD m0005 is now m0003
			// Without fingerprints, the block's stored m0004/m0005 would match the WRONG messages:
			//   m0004 -> index 3 (user: continue) and m0005 -> index 4 (assistant: "sure")

			// Step 5: Filter compressed ranges
			const result = filterCompressedRanges(postDedupMessages, state, postDedupIdMap);

			// Step 6: With fingerprints, the correct messages (tc_target assistant + result) are replaced.
			// Result should be: [user: start, developer: summary, user: continue, assistant: "sure"]
			expect(result.length).toBe(4);
			expect(result[0].role).toBe("user"); // "start"
			expect(result[1].role).toBe("developer"); // summary
			expect((result[1] as any).content).toContain("Searched the codebase");
			expect(result[2].role).toBe("user"); // "continue"
			expect(result[3].role).toBe("assistant"); // text "sure"
		});

		it("createBlock stores fingerprints that survive index shifts", () => {
			const state = createDCPState();
			const messages: AgentMessage[] = [
				{ role: "user", content: "hello", timestamp: 1 } as any,
				{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] } as any,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: "data" }],
					isError: false,
				} as any,
			];
			const map = assignMessageIds(messages);

			const block = createBlock(state, {
				mode: "range",
				topic: "test",
				startId: "m0002",
				endId: "m0003",
				summary: "s",
				messageIdMap: map,
				messages,
			});

			// Fingerprints are tool-call-ID based, not index-based
			expect(block.effectiveFingerprints).toEqual(["assistant:tc1", "toolResult:tc1"]);
			// These survive any reindexing because they're content-derived
		});

		it("falls back to mNNNN matching for blocks without fingerprints", () => {
			const state = createDCPState();
			const messages: AgentMessage[] = [
				{ role: "user", content: "m1", timestamp: 1 } as any,
				{ role: "user", content: "m2", timestamp: 2 } as any,
				{ role: "user", content: "m3", timestamp: 3 } as any,
			];
			const map = assignMessageIds(messages);

			// Create block WITHOUT passing messages (simulating legacy block)
			createBlock(state, {
				mode: "range",
				topic: "legacy",
				startId: "m0001",
				endId: "m0002",
				summary: "old summary",
				messageIdMap: map,
			});

			// Block has empty fingerprints
			const block = state.compressionBlocks.get("b1")!;
			expect(block.effectiveFingerprints).toEqual([]);

			// filterCompressedRanges should still work via mNNNN fallback
			const result = filterCompressedRanges(messages, state, map);
			expect(result.length).toBe(2); // summary + m3
			expect(result[0].role).toBe("developer");
			expect(result[1].role).toBe("user");
		});
	});
});
