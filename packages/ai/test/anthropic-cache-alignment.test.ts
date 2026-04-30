import { describe, expect, it } from "bun:test";
import {
	type AnthropicCacheControl,
	applyPromptCaching,
	buildAnthropicSystemBlocks,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { flattenSystemPrompt, type StructuredSystemPrompt } from "@oh-my-pi/pi-ai/types";

type CacheControlBlock = { cache_control?: AnthropicCacheControl };
type TaggedBlock = { type: "text"; text: string; _cacheHint?: string };

const CACHE_CONTROL: AnthropicCacheControl = { type: "ephemeral" };

const STABLE_PREFIX = "You are a helpful coding assistant.\n\nRules:\n- Be concise\n- Follow best practices";
const DYNAMIC_SUFFIX_A = "\n\nActing as: reviewer-opus\nModel: claude-opus-4-5";
const DYNAMIC_SUFFIX_B = "\n\nActing as: reviewer-sonnet\nModel: claude-sonnet-4-5";

function makeStructured(stable: string, dynamic: string): StructuredSystemPrompt {
	return {
		blocks: [
			{ text: stable, cacheHint: "stable" as const },
			{ text: dynamic, cacheHint: "dynamic" as const },
		],
	};
}

describe("Subagent cache alignment", () => {
	describe("buildAnthropicSystemBlocks with structured prompt", () => {
		it("emits separate system blocks per structured prompt block", () => {
			const structured = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_A);
			const fullPrompt = STABLE_PREFIX + DYNAMIC_SUFFIX_A;
			const blocks = buildAnthropicSystemBlocks(fullPrompt, {}, structured);

			expect(blocks).toBeDefined();
			// Should contain exactly 2 blocks (no billing header, no claude code instruction)
			expect(blocks!.length).toBe(2);
			expect(blocks![0].text).toBe(STABLE_PREFIX);
			expect(blocks![1].text).toBe(DYNAMIC_SUFFIX_A);
		});

		it("tags emitted blocks with _cacheHint from source", () => {
			const structured = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_A);
			const fullPrompt = STABLE_PREFIX + DYNAMIC_SUFFIX_A;
			const blocks = buildAnthropicSystemBlocks(fullPrompt, {}, structured) as TaggedBlock[];

			expect(blocks).toBeDefined();
			expect(blocks![0]._cacheHint).toBe("stable");
			expect(blocks![1]._cacheHint).toBe("dynamic");
		});

		it("preserves billing header and claude code instruction prefix blocks", () => {
			const structured = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_A);
			const fullPrompt = STABLE_PREFIX + DYNAMIC_SUFFIX_A;
			const blocks = buildAnthropicSystemBlocks(
				fullPrompt,
				{
					includeClaudeCodeInstruction: true,
				},
				structured,
			);

			expect(blocks).toBeDefined();
			// billing header + claude code instruction + 2 structured blocks = 4
			expect(blocks!.length).toBe(4);
			// First block is billing header
			expect(blocks![0].text).toMatch(/x-anthropic-billing-header:/);
			// Last two are the structured prompt blocks
			expect(blocks![2].text).toBe(STABLE_PREFIX);
			expect(blocks![3].text).toBe(DYNAMIC_SUFFIX_A);
		});

		it("skips empty structured blocks without breaking cache placement", () => {
			const structured: StructuredSystemPrompt = {
				blocks: [
					{ text: STABLE_PREFIX, cacheHint: "stable" },
					{ text: "", cacheHint: "dynamic" },
				],
			};
			const blocks = buildAnthropicSystemBlocks(STABLE_PREFIX, {}, structured) as TaggedBlock[];

			expect(blocks).toBeDefined();
			// Empty dynamic block should be skipped
			expect(blocks!.length).toBe(1);
			expect(blocks![0].text).toBe(STABLE_PREFIX);
			expect(blocks![0]._cacheHint).toBe("stable");
		});
	});

	describe("cache-aligned prefix identity across subagents", () => {
		it("produces identical stable prefix blocks for different subagent types", () => {
			const structuredA = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_A);
			const structuredB = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_B);
			const fullPromptA = STABLE_PREFIX + DYNAMIC_SUFFIX_A;
			const fullPromptB = STABLE_PREFIX + DYNAMIC_SUFFIX_B;

			const blocksA = buildAnthropicSystemBlocks(fullPromptA, {}, structuredA);
			const blocksB = buildAnthropicSystemBlocks(fullPromptB, {}, structuredB);

			expect(blocksA).toBeDefined();
			expect(blocksB).toBeDefined();

			// Stable prefix block (index 0) is byte-identical
			expect(blocksA![0].text).toBe(blocksB![0].text);
			// Dynamic suffix block (index 1) differs
			expect(blocksA![1].text).not.toBe(blocksB![1].text);
		});

		it("produces identical stable prefix when claude code instructions are included", () => {
			const structuredA = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_A);
			const structuredB = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_B);
			const fullPromptA = STABLE_PREFIX + DYNAMIC_SUFFIX_A;
			const fullPromptB = STABLE_PREFIX + DYNAMIC_SUFFIX_B;

			const opts = { includeClaudeCodeInstruction: true };
			const blocksA = buildAnthropicSystemBlocks(fullPromptA, opts, structuredA);
			const blocksB = buildAnthropicSystemBlocks(fullPromptB, opts, structuredB);

			expect(blocksA).toBeDefined();
			expect(blocksB).toBeDefined();

			// All prefix blocks (billing + claude code + stable) are identical.
			// The billing header hash differs because it includes the full system
			// prompt, so we compare from index 1 (claude code instruction) to the
			// stable block. Index 1 = claude code instruction, index 2 = stable.
			expect(blocksA![1].text).toBe(blocksB![1].text);
			expect(blocksA![2].text).toBe(blocksB![2].text);
			// Dynamic block (index 3) differs
			expect(blocksA![3].text).not.toBe(blocksB![3].text);
		});
	});

	describe("applyPromptCaching with _cacheHint tags", () => {
		function makeParams(systemBlocks: TaggedBlock[], toolCount = 1) {
			const tools = Array.from({ length: toolCount }, (_, i) => ({
				name: `tool_${i}`,
				description: `Tool ${i}`,
				input_schema: { type: "object" as const, properties: {} },
			}));
			return {
				model: "claude-sonnet-4-5" as const,
				max_tokens: 8192,
				stream: true as const,
				messages: [{ role: "user" as const, content: "Hello" }],
				system: systemBlocks,
				tools,
			};
		}

		it("places cache breakpoint on stable-tagged block, not last block", () => {
			const params = makeParams([
				{ type: "text", text: STABLE_PREFIX, _cacheHint: "stable" },
				{ type: "text", text: DYNAMIC_SUFFIX_A, _cacheHint: "dynamic" },
			]);

			applyPromptCaching(params, CACHE_CONTROL);

			const system = params.system as Array<TaggedBlock & CacheControlBlock>;
			// Stable block (index 0) should have cache_control
			expect(system[0].cache_control).toEqual(CACHE_CONTROL);
			// Dynamic block (index 1) should NOT have cache_control
			expect(system[1].cache_control).toBeUndefined();
		});

		it("places cache breakpoint on stable block when prefix blocks are present", () => {
			// Simulate: billing header + claude code instruction + stable + dynamic
			const params = makeParams([
				{ type: "text", text: "x-anthropic-billing-header: ..." },
				{ type: "text", text: "You are Claude Code..." },
				{ type: "text", text: STABLE_PREFIX, _cacheHint: "stable" },
				{ type: "text", text: DYNAMIC_SUFFIX_A, _cacheHint: "dynamic" },
			]);

			applyPromptCaching(params, CACHE_CONTROL);

			const system = params.system as Array<TaggedBlock & CacheControlBlock>;
			// Billing header (0) and claude code (1) should NOT have cache_control
			expect(system[0].cache_control).toBeUndefined();
			expect(system[1].cache_control).toBeUndefined();
			// Stable block (index 2) should have cache_control
			expect(system[2].cache_control).toEqual(CACHE_CONTROL);
			// Dynamic block (index 3) should NOT have cache_control
			expect(system[3].cache_control).toBeUndefined();
		});

		it("falls back to last block when no _cacheHint tags exist", () => {
			const params = makeParams([
				{ type: "text", text: "block A" },
				{ type: "text", text: "block B" },
			]);

			applyPromptCaching(params, CACHE_CONTROL);

			const system = params.system as Array<TaggedBlock & CacheControlBlock>;
			// Falls back to last block
			expect(system[0].cache_control).toBeUndefined();
			expect(system[1].cache_control).toEqual(CACHE_CONTROL);
		});

		it("handles empty-block filtering correctly (bug fix regression)", () => {
			// Build via buildAnthropicSystemBlocks with an empty dynamic block
			const structured: StructuredSystemPrompt = {
				blocks: [
					{ text: STABLE_PREFIX, cacheHint: "stable" },
					{ text: "", cacheHint: "dynamic" },
				],
			};
			const blocks = buildAnthropicSystemBlocks(STABLE_PREFIX, {}, structured);
			expect(blocks).toBeDefined();
			// Only 1 block emitted (empty one filtered)
			expect(blocks!.length).toBe(1);

			// Now apply caching — should find stable tag on the only block
			const params = makeParams(blocks as TaggedBlock[]);
			applyPromptCaching(params, CACHE_CONTROL);

			const system = params.system as Array<TaggedBlock & CacheControlBlock>;
			expect(system[0].cache_control).toEqual(CACHE_CONTROL);
		});
	});

	describe("plain string backward compatibility", () => {
		it("buildAnthropicSystemBlocks produces single block for plain string", () => {
			const blocks = buildAnthropicSystemBlocks("Stay concise.", {});
			expect(blocks).toBeDefined();
			expect(blocks!.length).toBe(1);
			expect(blocks![0].text).toBe("Stay concise.");
		});

		it("applyPromptCaching places breakpoint on last system block without tags", () => {
			const params = {
				model: "claude-sonnet-4-5" as const,
				max_tokens: 8192,
				stream: true as const,
				messages: [{ role: "user" as const, content: "Hello" }],
				system: [{ type: "text" as const, text: "Stay concise." }],
				tools: [{ name: "t", description: "d", input_schema: { type: "object" as const, properties: {} } }],
			};

			applyPromptCaching(params, CACHE_CONTROL);

			const system = params.system as Array<{ type: "text"; text: string } & CacheControlBlock>;
			expect(system[0].cache_control).toEqual(CACHE_CONTROL);
		});
	});

	describe("flattenSystemPrompt", () => {
		it("concatenates all block texts", () => {
			const structured = makeStructured(STABLE_PREFIX, DYNAMIC_SUFFIX_A);
			expect(flattenSystemPrompt(structured)).toBe(STABLE_PREFIX + DYNAMIC_SUFFIX_A);
		});

		it("handles single block", () => {
			const structured: StructuredSystemPrompt = {
				blocks: [{ text: "only block" }],
			};
			expect(flattenSystemPrompt(structured)).toBe("only block");
		});

		it("handles empty blocks array", () => {
			const structured: StructuredSystemPrompt = { blocks: [] };
			expect(flattenSystemPrompt(structured)).toBe("");
		});
	});

	describe("breakpoint budget compliance", () => {
		it("does not exceed 4 total breakpoints", () => {
			const params = {
				model: "claude-sonnet-4-5" as const,
				max_tokens: 8192,
				stream: true as const,
				messages: [
					{ role: "user" as const, content: "msg 1" },
					{ role: "assistant" as const, content: "reply 1" },
					{ role: "user" as const, content: "msg 2" },
					{ role: "assistant" as const, content: "reply 2" },
					{ role: "user" as const, content: "msg 3" },
				],
				system: [
					{ type: "text" as const, text: STABLE_PREFIX, _cacheHint: "stable" },
					{ type: "text" as const, text: DYNAMIC_SUFFIX_A, _cacheHint: "dynamic" },
				],
				tools: [{ name: "tool_1", description: "d", input_schema: { type: "object" as const, properties: {} } }],
			};

			applyPromptCaching(params, CACHE_CONTROL);

			// Count all cache_control breakpoints across tools, system, and messages
			let breakpoints = 0;

			for (const tool of params.tools as Array<CacheControlBlock>) {
				if (tool.cache_control) breakpoints++;
			}
			for (const block of params.system as Array<CacheControlBlock>) {
				if (block.cache_control) breakpoints++;
			}
			for (const msg of params.messages) {
				if (typeof msg.content === "string") continue;
				if (Array.isArray(msg.content)) {
					for (const part of msg.content as Array<CacheControlBlock>) {
						if (part.cache_control) breakpoints++;
					}
				}
			}
			// Messages with string content may have cache_control at top level
			for (const msg of params.messages as Array<CacheControlBlock & { role: string }>) {
				if ((msg as CacheControlBlock).cache_control) breakpoints++;
			}

			expect(breakpoints).toBeLessThanOrEqual(4);
		});
	});
});
