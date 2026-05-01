import { describe, expect, spyOn, test } from "bun:test";
import * as blocks from "../../src/session/compaction/compression-blocks";
import { createDCPState } from "../../src/session/compaction/dcp-state";
import { createCompressTool } from "../../src/tools/compress";

function setupState() {
	const state = createDCPState();
	state.messageIdMap.set("m0001", "0");
	state.messageIdMap.set("m0002", "1");
	state.messageIdMap.set("m0003", "2");
	state.lastAssignedIdMap = new Map([
		[0, "m0001"],
		[1, "m0002"],
		[2, "m0003"],
	]);
	return state;
}

describe("compress tool", () => {
	test("valid compress call creates block", async () => {
		const state = setupState();
		const createBlockSpy = spyOn(blocks, "createBlock");
		const tool = createCompressTool(() => state);

		const result = await tool.execute("test-id", {
			startId: "m0001",
			endId: "m0002",
			summary: "This is a sufficiently long summary of the events.",
		});

		const first = result.content[0];
		expect(first.type === "text" && first.text).toContain("Compressed messages m0001-m0002 into block");
		expect(createBlockSpy).toHaveBeenCalled();
		createBlockSpy.mockRestore();
	});

	test("startId not in messageIdMap throws error", async () => {
		const state = setupState();
		const tool = createCompressTool(() => state);

		const result = await tool.execute("test-id", {
			startId: "m9999",
			endId: "m0002",
			summary: "This is a sufficiently long summary of the events.",
		});

		const first = result.content[0];
		expect(first.type === "text" && first.text).toContain("Error: Message ID m9999 not found in current context");
	});

	test("startId > endId throws error", async () => {
		const state = setupState();
		const tool = createCompressTool(() => state);

		const result = await tool.execute("test-id", {
			startId: "m0003",
			endId: "m0001",
			summary: "This is a sufficiently long summary of the events.",
		});

		const first = result.content[0];
		expect(first.type === "text" && first.text).toContain("Error: startId must come before endId");
	});
});
