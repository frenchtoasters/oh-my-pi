import { describe, expect, it } from "bun:test";
import { getPonytailInstructions, type PonytailMode } from "../src/extension";

describe("getPonytailInstructions", () => {
	it("returns empty string when off", () => {
		expect(getPonytailInstructions("off")).toBe("");
	});

	const active: PonytailMode[] = ["lite", "full", "ultra"];
	for (const mode of active) {
		it(`includes header and ladder for ${mode}`, () => {
			const out = getPonytailInstructions(mode);
			expect(out).toContain(`PONYTAIL MODE ACTIVE -- level: ${mode}`);
			// The ladder must survive intact, not be collapsed away.
			expect(out).toContain("Does this need to exist at all?");
			expect(out).toContain("The shortest path to done is the right path.");
			// Per-level guidance line present.
			expect(out).toContain(`Level ${mode}:`);
		});
	}
});

describe("before_agent_start injection contract", () => {
	// Mirrors the handler body: it MUST return a string[] (base + 1), never a string.
	const inject = (systemPrompt: string[], mode: PonytailMode): { systemPrompt: string[] } | undefined => {
		if (mode === "off") return undefined;
		return { systemPrompt: [...systemPrompt, getPonytailInstructions(mode)] };
	};

	it("appends exactly one entry and keeps an array", () => {
		const base = ["a", "b"];
		const result = inject(base, "full");
		expect(result).toBeDefined();
		const sp = result!.systemPrompt;
		expect(Array.isArray(sp)).toBe(true);
		expect(sp.length).toBe(base.length + 1);
		expect(typeof sp[sp.length - 1]).toBe("string");
		expect(sp[sp.length - 1]).toContain("PONYTAIL MODE ACTIVE");
	});

	it("no-ops when off", () => {
		expect(inject(["a"], "off")).toBeUndefined();
	});
});
