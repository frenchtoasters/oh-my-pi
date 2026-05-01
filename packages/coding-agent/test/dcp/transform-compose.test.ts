import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { composeTransforms, type TransformContextFn } from "../../src/session/compaction/transform-compose";

function makeMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("composeTransforms", () => {
	test("composes two transforms in sequence", async () => {
		const fn1: TransformContextFn = msgs => [...msgs, makeMessage("from-fn1")];
		const fn2: TransformContextFn = msgs => [...msgs, makeMessage("from-fn2")];
		const composed = composeTransforms([fn1, fn2]);
		const result = await composed([makeMessage("initial")]);
		expect(result).toHaveLength(3);
	});

	test("passes output of fn1 as input to fn2", async () => {
		const fn1: TransformContextFn = msgs => msgs.filter(m => m.role === "user");
		const fn2: TransformContextFn = msgs => {
			// fn2 should see the filtered result from fn1
			return msgs;
		};
		const messages: AgentMessage[] = [
			makeMessage("keep"),
			{ role: "developer", content: "remove", timestamp: Date.now() },
		];
		const composed = composeTransforms([fn1, fn2]);
		const result = await composed(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});

	test("fn2 receives reduced set when fn1 filters messages", async () => {
		const fn1: TransformContextFn = msgs => msgs.slice(0, 1);
		const fn2: TransformContextFn = msgs => {
			expect(msgs).toHaveLength(1);
			return msgs;
		};
		const composed = composeTransforms([fn1, fn2]);
		await composed([makeMessage("a"), makeMessage("b"), makeMessage("c")]);
	});

	test("skips undefined and null transforms", async () => {
		const fn1: TransformContextFn = msgs => [...msgs, makeMessage("added")];
		const composed = composeTransforms([undefined, fn1, null, undefined]);
		const result = await composed([makeMessage("initial")]);
		expect(result).toHaveLength(2);
	});

	test("empty array returns identity function", async () => {
		const composed = composeTransforms([]);
		const messages = [makeMessage("a"), makeMessage("b")];
		const result = await composed(messages);
		expect(result).toHaveLength(2);
		expect(result).toEqual(messages);
	});

	test("passes AbortSignal to all transforms", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const fn1: TransformContextFn = (msgs, signal) => {
			signals.push(signal);
			return msgs;
		};
		const fn2: TransformContextFn = (msgs, signal) => {
			signals.push(signal);
			return msgs;
		};
		const controller = new AbortController();
		const composed = composeTransforms([fn1, fn2]);
		await composed([makeMessage("a")], controller.signal);
		expect(signals).toHaveLength(2);
		expect(signals[0]).toBe(controller.signal);
		expect(signals[1]).toBe(controller.signal);
	});

	test("error in transform propagates to caller", async () => {
		const fn1: TransformContextFn = () => {
			throw new Error("transform failed");
		};
		const composed = composeTransforms([fn1]);
		expect(composed([makeMessage("a")])).rejects.toThrow("transform failed");
	});

	test("handles async transforms", async () => {
		const fn1: TransformContextFn = async msgs => {
			await Bun.sleep(1);
			return [...msgs, makeMessage("async")];
		};
		const composed = composeTransforms([fn1]);
		const result = await composed([makeMessage("initial")]);
		expect(result).toHaveLength(2);
	});

	test("handles mix of sync and async transforms", async () => {
		const syncFn: TransformContextFn = msgs => [...msgs, makeMessage("sync")];
		const asyncFn: TransformContextFn = async msgs => {
			await Bun.sleep(1);
			return [...msgs, makeMessage("async")];
		};
		const composed = composeTransforms([syncFn, asyncFn]);
		const result = await composed([makeMessage("initial")]);
		expect(result).toHaveLength(3);
	});
});
