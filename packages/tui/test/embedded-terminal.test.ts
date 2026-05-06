import { afterEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(0);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function countMatches(lines: string[], pattern: RegExp): number {
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line)) count += 1;
	}
	return count;
}

/**
 * Tests for the embedded terminal (neovim :terminal) rendering mode.
 *
 * This mode uses absolute cursor positioning (CUP / \x1b[row;colH) instead
 * of relative movement (\x1b[NA/B) to eliminate cursor tracking drift that
 * causes line duplication in neovim's libvterm.
 */
describe("embedded terminal rendering (absolute positioning)", () => {
	let term: VirtualTerminal;
	let tui: TUI;

	afterEach(() => {
		tui?.stop();
	});

	function createTUI(cols: number, rows: number): { term: VirtualTerminal; tui: TUI } {
		term = new VirtualTerminal(cols, rows);
		tui = new TUI(term);
		tui.setEmbeddedTerminal(true);
		return { term, tui };
	}

	describe("differential update correctness", () => {
		it("keeps stable output across repeated no-op renders", async () => {
			const { term, tui } = createTUI(40, 10);
			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			tui.start();
			await settle(term);
			const before = visible(term);

			for (let i = 0; i < 8; i++) {
				tui.requestRender();
				await settle(term);
			}

			expect(visible(term)).toEqual(before);
		});

		it("updates only changed middle line without corrupting neighbors", async () => {
			const { term, tui } = createTUI(40, 10);
			const component = new MutableLinesComponent(["AAA", "BBB", "CCC", "DDD", "EEE"]);
			tui.addChild(component);

			tui.start();
			await settle(term);
			const before = visible(term);

			component.setLines(["AAA", "BBB", "XXX", "DDD", "EEE"]);
			tui.requestRender();
			await settle(term);

			const after = visible(term);
			expect(after[0]).toBe(before[0]);
			expect(after[1]).toBe(before[1]);
			expect(after[2]?.trim()).toBe("XXX");
			expect(after[3]).toBe(before[3]);
			expect(after[4]).toBe(before[4]);
		});

		it("updates first and last lines simultaneously", async () => {
			const { term, tui } = createTUI(40, 10);
			const component = new MutableLinesComponent(["first", "mid-1", "mid-2", "mid-3", "last"]);
			tui.addChild(component);

			tui.start();
			await settle(term);

			component.setLines(["FIRST", "mid-1", "mid-2", "mid-3", "LAST"]);
			tui.requestRender();
			await settle(term);

			const after = visible(term);
			expect(after[0]?.trim()).toBe("FIRST");
			expect(after[1]?.trim()).toBe("mid-1");
			expect(after[2]?.trim()).toBe("mid-2");
			expect(after[3]?.trim()).toBe("mid-3");
			expect(after[4]?.trim()).toBe("LAST");
		});

		it("handles multiple consecutive single-line changes without drift", async () => {
			const { term, tui } = createTUI(40, 8);
			const lines = ["line-0", "line-1", "line-2", "line-3", "line-4"];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			tui.start();
			await settle(term);

			// Simulate a spinner-like update on line 2
			for (let tick = 0; tick < 20; tick++) {
				const updated = [...lines];
				updated[2] = `spin-${tick}`;
				component.setLines(updated);
				tui.requestRender();
				await settle(term);
			}

			const viewport = visible(term);
			expect(viewport[0]?.trim()).toBe("line-0");
			expect(viewport[1]?.trim()).toBe("line-1");
			expect(viewport[2]?.trim()).toBe("spin-19");
			expect(viewport[3]?.trim()).toBe("line-3");
			expect(viewport[4]?.trim()).toBe("line-4");
		});
	});

	describe("content growth and shrink", () => {
		it("appends new lines correctly", async () => {
			const { term, tui } = createTUI(40, 10);
			const component = new MutableLinesComponent(["A", "B"]);
			tui.addChild(component);

			tui.start();
			await settle(term);

			component.setLines(["A", "B", "C", "D"]);
			tui.requestRender();
			await settle(term);

			const viewport = visible(term);
			expect(viewport[0]?.trim()).toBe("A");
			expect(viewport[1]?.trim()).toBe("B");
			expect(viewport[2]?.trim()).toBe("C");
			expect(viewport[3]?.trim()).toBe("D");
		});

		it("clears removed tail lines after shrink with clearOnShrink", async () => {
			const { term, tui } = createTUI(40, 10);
			const component = new MutableLinesComponent(["A", "B", "C", "D", "E"]);
			tui.setClearOnShrink(true);
			tui.addChild(component);

			tui.start();
			await settle(term);

			component.setLines(["A", "B"]);
			tui.requestRender();
			await settle(term);

			const viewport = visible(term);
			expect(viewport[0]?.trim()).toBe("A");
			expect(viewport[1]?.trim()).toBe("B");
			expect(viewport[2]?.trim()).toBe("");
			expect(viewport[3]?.trim()).toBe("");
		});

		it("handles grow-then-shrink-then-grow cycle", async () => {
			const { term, tui } = createTUI(30, 6);
			const component = new MutableLinesComponent(rows("r-", 3));
			tui.addChild(component);

			tui.start();
			await settle(term);

			// Grow
			component.setLines(rows("r-", 6));
			tui.requestRender();
			await settle(term);
			expect(visible(term).filter(l => l.trim()).length).toBe(6);

			// Shrink
			component.setLines(rows("r-", 2));
			tui.setClearOnShrink(true);
			tui.requestRender();
			await settle(term);
			expect(visible(term)[0]?.trim()).toBe("r-0");
			expect(visible(term)[1]?.trim()).toBe("r-1");

			// Grow again
			component.setLines(rows("r-", 5));
			tui.requestRender();
			await settle(term);
			const final = visible(term);
			for (let i = 0; i < 5; i++) {
				expect(final[i]?.trim()).toBe(`r-${i}`);
			}
		});
	});

	describe("viewport overflow", () => {
		it("overflow content appears once across buffer without duplicate row IDs", async () => {
			const { term, tui } = createTUI(32, 5);
			const component = new MutableLinesComponent(rows("line-", 10));
			tui.addChild(component);

			tui.start();
			await settle(term);

			const all = term.getScrollBuffer();
			for (let i = 0; i < 10; i++) {
				const pattern = new RegExp(`\\bline-${i}\\b`);
				expect(countMatches(all, pattern), `line-${i} should appear exactly once`).toBe(1);
			}
		});

		it("streaming append with in-place header update keeps viewport correct", async () => {
			const { term, tui } = createTUI(32, 6);
			const logLines = rows("line-", 6);
			let tick = 0;
			const component = new MutableLinesComponent([`status-${tick}`, ...logLines]);
			tui.addChild(component);

			tui.start();
			await settle(term);

			for (let i = 6; i < 40; i++) {
				tick += 1;
				logLines.push(`line-${i}`);
				component.setLines([`status-${tick}`, ...logLines]);
				tui.requestRender();
				await settle(term);
			}

			// Viewport should show the tail of the content
			const viewport = visible(term).map(line => line.trim());
			expect(viewport.at(-1)).toBe("line-39");
			// Header should not be visible (scrolled above viewport)
			expect(viewport.some(l => l.startsWith("status-"))).toBeFalsy();
		});

		it("append-only during overflow keeps viewport at tail", async () => {
			const { term, tui } = createTUI(32, 5);
			const lines = rows("line-", 7);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			tui.start();
			await settle(term);

			for (let tick = 0; tick < 20; tick++) {
				lines.push(`new-${tick}`);
				component.setLines(lines);
				tui.requestRender();
				await settle(term);
			}

			// Final viewport should show the last 5 lines
			const viewport = visible(term).map(line => line.trim());
			const expectedTail = lines.slice(-5);
			expect(viewport).toEqual(expectedTail);
		});
	});

	describe("forced full redraws", () => {
		it("forced full redraws do not duplicate persistent content", async () => {
			const { term, tui } = createTUI(40, 5);
			const component = new MutableLinesComponent(["alpha", "beta", "gamma"]);
			tui.addChild(component);

			tui.start();
			await settle(term);

			for (let i = 0; i < 5; i++) {
				tui.requestRender(true);
				await settle(term);
			}

			const allText = term.getScrollBuffer().join("\n");
			expect((allText.match(/alpha/g) ?? []).length).toBe(1);
			expect((allText.match(/beta/g) ?? []).length).toBe(1);
			expect((allText.match(/gamma/g) ?? []).length).toBe(1);
		});
	});

	describe("resize behavior", () => {
		it("height change does not trigger full redraw (skipped like multiplexer)", async () => {
			const { term, tui } = createTUI(40, 10);
			const component = new MutableLinesComponent(rows("row-", 8));
			tui.addChild(component);

			tui.start();
			await settle(term);
			const redrawsBefore = tui.fullRedraws;

			term.resize(40, 8);
			await settle(term);

			// Should NOT have triggered a full redraw for height change
			expect(tui.fullRedraws).toBe(redrawsBefore);
		});

		it("width change still triggers full redraw", async () => {
			const { term, tui } = createTUI(40, 10);
			const component = new MutableLinesComponent(rows("row-", 5));
			tui.addChild(component);

			tui.start();
			await settle(term);
			const redrawsBefore = tui.fullRedraws;

			term.resize(30, 10);
			await settle(term);

			// Width changes always need full redraw (wrapping changes)
			expect(tui.fullRedraws).toBeGreaterThan(redrawsBefore);
		});
	});

	describe("stress: rapid mutations", () => {
		it("rapid content mutations converge to final expected screen", async () => {
			const { term, tui } = createTUI(30, 8);
			const component = new MutableLinesComponent(["init"]);
			tui.addChild(component);

			tui.start();
			await settle(term);

			for (let i = 0; i < 80; i++) {
				const n = (i % 7) + 1;
				component.setLines(Array.from({ length: n }, (_v, j) => `iter-${i}-line-${j}`));
				tui.requestRender();
				await settle(term);
			}

			const expected = Array.from({ length: 3 }, (_v, j) => `iter-79-line-${j}`);
			const viewport = visible(term);
			expect(viewport[0]?.trim()).toBe(expected[0]);
			expect(viewport[1]?.trim()).toBe(expected[1]);
			expect(viewport[2]?.trim()).toBe(expected[2]);
			expect(viewport[3]?.trim()).toBe("");
		});

		it("alternating grow/shrink converges to correct final viewport", async () => {
			const { term, tui } = createTUI(40, 6);
			const component = new MutableLinesComponent(["start"]);
			tui.addChild(component);

			tui.start();
			await settle(term);

			for (let i = 0; i < 50; i++) {
				const lineCount = (i % 10) + 1;
				const lines = Array.from({ length: lineCount }, (_v, j) => `step-${i}-line-${j}`);
				component.setLines(lines);
				tui.requestRender();
				await settle(term);
			}

			// Final state: step-49 with 10 lines, viewport shows bottom 6
			const viewport = visible(term);
			const lastStep = viewport.filter(l => l.includes("step-49"));
			expect(lastStep.length).toBeGreaterThan(0);

			// No duplication of final step content in viewport
			for (let j = 0; j < 10; j++) {
				const pattern = new RegExp(`step-49-line-${j}`);
				expect(countMatches(viewport, pattern)).toBeLessThanOrEqual(1);
			}
		});
	});

	describe("parity with normal rendering", () => {
		it("produces identical viewport to non-embedded mode for static content", async () => {
			const lines = rows("parity-", 15);

			// Normal mode
			const normTerm = new VirtualTerminal(40, 8);
			const normTui = new TUI(normTerm);
			normTui.addChild(new MutableLinesComponent(lines));
			normTui.start();
			await settle(normTerm);
			const normalViewport = visible(normTerm);
			normTui.stop();

			// Embedded mode
			const { term: embTerm, tui: embTui } = createTUI(40, 8);
			embTui.addChild(new MutableLinesComponent(lines));
			embTui.start();
			await settle(embTerm);
			const embeddedViewport = visible(embTerm);
			embTui.stop();

			expect(embeddedViewport).toEqual(normalViewport);
		});

		it("produces identical viewport after differential update", async () => {
			const initial = ["AAA", "BBB", "CCC", "DDD", "EEE"];
			const updated = ["AAA", "XXX", "CCC", "YYY", "EEE"];

			// Normal mode
			const normTerm = new VirtualTerminal(40, 10);
			const normTui = new TUI(normTerm);
			const normComp = new MutableLinesComponent(initial);
			normTui.addChild(normComp);
			normTui.start();
			await settle(normTerm);
			normComp.setLines(updated);
			normTui.requestRender();
			await settle(normTerm);
			const normalViewport = visible(normTerm);
			normTui.stop();

			// Embedded mode
			const { term: embTerm, tui: embTui } = createTUI(40, 10);
			const embComp = new MutableLinesComponent(initial);
			embTui.addChild(embComp);
			embTui.start();
			await settle(embTerm);
			embComp.setLines(updated);
			embTui.requestRender();
			await settle(embTerm);
			const embeddedViewport = visible(embTerm);
			embTui.stop();

			expect(embeddedViewport).toEqual(normalViewport);
		});

		it("produces identical viewport after overflow with streaming append", async () => {
			// Normal mode
			const normTerm = new VirtualTerminal(32, 5);
			const normTui = new TUI(normTerm);
			const normLines: string[] = [];
			const normComp = new MutableLinesComponent(normLines);
			normTui.addChild(normComp);
			normTui.start();
			await settle(normTerm);

			for (let i = 0; i < 20; i++) {
				normLines.push(`stream-${i}`);
				normComp.setLines(normLines);
				normTui.requestRender();
				await settle(normTerm);
			}
			const normalViewport = visible(normTerm);
			normTui.stop();

			// Embedded mode
			const { term: embTerm, tui: embTui } = createTUI(32, 5);
			const embLines: string[] = [];
			const embComp = new MutableLinesComponent(embLines);
			embTui.addChild(embComp);
			embTui.start();
			await settle(embTerm);

			for (let i = 0; i < 20; i++) {
				embLines.push(`stream-${i}`);
				embComp.setLines(embLines);
				embTui.requestRender();
				await settle(embTerm);
			}
			const embeddedViewport = visible(embTerm);
			embTui.stop();

			expect(embeddedViewport).toEqual(normalViewport);
		});
	});
});
