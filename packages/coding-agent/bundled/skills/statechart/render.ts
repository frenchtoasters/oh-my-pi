#!/usr/bin/env bun
// Statechart display: out/chart.json -> out/chart.html, a self-contained page.
// Usage: bun render.ts <out-dir>
// Exit 0 = written; 2 = bad input or missing layout engine.
//
// Structure is the statechart skill's: start on top, one layer per step fanning downward, back
// arrows dashed, break marks, rule verdicts, and shortest bug paths.
// Only the look comes from PR Lens: its dark palette, cards, glyph chips, label pills, arrow
// markers, badges, stat chips and travelling pulses, copied from @coldtea/pr-lens-renderer 0.4.0
// (MIT, Copyright (c) 2026 Coldtea AI). ELK, which omp already ships, does the layout.
import * as fs from "node:fs";
import * as path from "node:path";

type Mark = "breaks" | "mayBreak" | null;
interface View {
	title: string;
	states: { id: string; label: string; mark: Mark; rules: string[] }[];
	arrows: { from: string; to: string; label: string }[];
	starts: string[];
	ends: string[];
	rules?: { name: string; sentence: string; verdict: "breaks" | "holds" | "not checked" }[];
	bugPaths?: { rule: string; start: string; steps: { from: string; to: string; label: string }[] }[];
}
interface Pt {
	x: number;
	y: number;
}
interface ElkLabel {
	text: string;
	width: number;
	height: number;
	x?: number;
	y?: number;
}
interface ElkEdge {
	id: string;
	sources: string[];
	targets: string[];
	labels: ElkLabel[];
	sections?: { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }[];
}
interface ElkNode {
	id: string;
	width: number;
	height: number;
	x?: number;
	y?: number;
	layoutOptions?: Record<string, string>;
	children?: ElkNode[];
	edges?: ElkEdge[];
}
type Layout = (graph: ElkNode) => ElkNode;
interface Arrow {
	id: string;
	from: string;
	to: string;
	labels: string[];
}

// ---------- PR Lens assets (MIT, Coldtea AI) ----------
const C = {
	background: "#0d1117",
	dot: "rgba(110,118,129,.22)",
	card: "#1c2128",
	cardBorder: "#3d444d",
	foreground: "#e6edf3",
	muted: "#9198a1",
	edge: "#6e7681",
	chip: "rgba(110,118,129,.18)",
	pill: "#0d1117",
	pillBorder: "#21262d",
	added: "#3fb950",
	modified: "#d29922",
	removed: "#f85149",
	shadow: "rgba(0,0,0,.28)",
};
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const CARD_RADIUS = 10;
const CARD_HEIGHT = 52;
const CARD_HEIGHT_WITH_SUBTITLE = 62;
const CARD_PADDING_X = 14;
const ICON_CHIP_SIZE = 26;
const ICON_CHIP_GAP = 10;
const ICON_CHIP_RADIUS = 7;
const TITLE_SIZE = 13;
const TITLE_LINE = 16;
const SUBTITLE_SIZE = 9.5;
const BADGE_HEIGHT = 16;
const BADGE_PADDING_X = 9;
const BADGE_TEXT_SIZE = 8.5;
const BADGE_TRACKING = 0.06;
const BADGE_RISE = 8;
const PILL_HEIGHT = 15;
const PILL_PADDING_X = 8;
const PILL_TEXT_SIZE = 9.5;
const BEND_RADIUS_MAX = 34;
const PULSE_RADIUS = 2.6;
const TRAIN_RADIUS = 3;
const HERO_PULSE_DURATION = 2.1;
const HERO_PULSE_COUNT = 3;
// Advance widths per 1000 em for the regular sans face; bold runs 6% wider.
const SANS_ADVANCE: Record<string, number> = {
	" ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
	"(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
	"0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
	"8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
	"@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
	I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
	S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278,
	"\\": 278, "]": 278, "^": 469, _: 556, "`": 333, a: 556, b: 556, c: 500, d: 556,
	e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556,
	o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
	y: 500, z: 500, "{": 334, "|": 260, "}": 334, "~": 584,
};
const measure = (text: string, size: number, bold = false, mono = false) => {
	let t = 0;
	for (const ch of text) t += mono ? 600 : (SANS_ADVANCE[ch] ?? (Bun.stringWidth(ch) > 1 ? 1000 : 600)) * (bold ? 1.06 : 1);
	return (t / 1000) * size;
};
const FORBIDDEN_IN_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu;
const esc = (v: string) =>
	v.replace(FORBIDDEN_IN_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => String(Math.round(v * 100) / 100);
const SVG_CSS = `text{font-family:${SANS}}
.card{fill:${C.card};stroke:${C.cardBorder};stroke-width:1}
.card-breaks{stroke:${C.removed};stroke-opacity:.75;stroke-width:1.5}
.card-maybreak{stroke:${C.modified};stroke-opacity:.6;stroke-dasharray:4 3}
.card-end{stroke:${C.added};stroke-opacity:.55}
.ntitle{font-weight:600;fill:${C.foreground}}
.nsub{font-size:9.5px;fill:${C.muted};font-family:${MONO}}
.chip{fill:${C.chip}}
.glyph{fill:${C.muted}}
.glyph-stroke{stroke:${C.muted};stroke-width:1.4;fill:none}
.bdg text{font-size:8.5px;font-weight:700;letter-spacing:.06em}
.bdg rect{stroke-width:1}
.bdg-added rect{fill:rgba(46,160,67,.15);stroke:rgba(63,185,80,.4)}.bdg-added text{fill:${C.added}}
.bdg-modified rect{fill:rgba(187,128,9,.15);stroke:rgba(210,153,34,.4)}.bdg-modified text{fill:${C.modified}}
.bdg-removed rect{fill:rgba(248,81,73,.12);stroke:rgba(248,81,73,.4)}.bdg-removed text{fill:${C.removed}}
.bdg-neutral rect{fill:rgba(110,118,129,.18);stroke:${C.cardBorder}}.bdg-neutral text{fill:${C.muted}}
.edge{fill:none;stroke-width:1.5}
.edge-neutral{stroke:${C.edge}}
.edge-removed{stroke:${C.removed}}
.edge-back{stroke-dasharray:4 3;opacity:.8}
.hero{stroke-width:2.25}
.glow{fill:none;stroke-width:7;opacity:.14}
.lpill{fill:${C.pill};stroke:${C.pillBorder};stroke-width:1}
.ltext{font-size:9.5px;font-weight:600;fill:${C.muted}}
.ltext-removed{fill:${C.removed}}
.cardsh{filter:drop-shadow(0 1px 2px ${C.shadow})}`;
const marker = (id: string, colour: string) =>
	`<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${colour}"/></marker>`;
const DEFS = `<defs><pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="${C.dot}"/></pattern>${marker("mk-neutral", C.edge)}${marker("mk-removed", C.removed)}</defs>`;
// Glyphs: route (start), test (end state), service (any other state).
function glyph(kind: "route" | "test" | "service", cx: number, cy: number): string {
	if (kind === "route") return `<path class="glyph" d="M${n(cx - 7)},${n(cy - 6)} L${n(cx + 7)},${n(cy)} L${n(cx - 7)},${n(cy + 6)} Z"/>`;
	if (kind === "test") return `<path class="glyph-stroke" d="M${n(cx - 6)},${n(cy)} l4,4 l8,-8"/>`;
	return `<rect class="glyph-stroke" x="${n(cx - 6.5)}" y="${n(cy - 6.5)}" width="13" height="13" rx="3"/><circle class="glyph" cx="${n(cx)}" cy="${n(cy)}" r="2"/>`;
}
// The travelling pulse: a train of dots on a hero line, staggered by negative begin so none waits in the corner.
function pulses(d: string, colour: string): string {
	const out: string[] = [];
	for (let i = 0; i < HERO_PULSE_COUNT; i++) {
		const behind = ((HERO_PULSE_DURATION / HERO_PULSE_COUNT) * i) % HERO_PULSE_DURATION;
		const begin = behind === 0 ? "" : ` begin="${n(behind - HERO_PULSE_DURATION)}s"`;
		out.push(`<circle r="${TRAIN_RADIUS}" fill="${colour}"><animateMotion dur="${HERO_PULSE_DURATION}s"${begin} repeatCount="indefinite" path="${d}"/></circle>`);
	}
	return out.join("\n");
}
// ---------- end of PR Lens assets ----------

// Layout engine: ELK via omp's beautiful-mermaid, already installed with omp.
async function loadElk(): Promise<Layout> {
	const omp = Bun.which("omp");
	if (!omp) throw new Error("omp is not on PATH, so its layout engine cannot be loaded");
	const utils = path.dirname(Bun.resolveSync("@oh-my-pi/pi-utils", path.dirname(fs.realpathSync(omp))));
	const entry = Bun.resolveSync("beautiful-mermaid", utils);
	const mod = await import(path.join(path.dirname(entry), "elk-instance.ts"));
	if (typeof mod.elkLayoutSync !== "function") throw new Error(`elkLayoutSync missing next to ${entry}`);
	return mod.elkLayoutSync;
}
function wrapWidth(text: string, max: number, size: number, bold: boolean): string[] {
	const out: string[] = [];
	let cur = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const next = cur ? `${cur} ${word}` : word;
		if (cur && measure(next, size, bold) > max) {
			out.push(cur);
			cur = word;
		} else cur = next;
	}
	if (cur) out.push(cur);
	return out;
}
function mergeArrows(view: View): Arrow[] {
	const pairs = new Map<string, Arrow>();
	for (const a of view.arrows) {
		const k = `${a.from}\u0000${a.to}`;
		const p = pairs.get(k) ?? { id: `e${pairs.size}`, from: a.from, to: a.to, labels: [] };
		if (!p.labels.includes(a.label)) p.labels.push(a.label);
		pairs.set(k, p);
	}
	return [...pairs.values()];
}
// Depth-first from the starts; an arrow into a state still on the stack closes a loop.
function backArrowIds(view: View, arrows: Arrow[]): Set<string> {
	const out = new Map<string, Arrow[]>();
	for (const a of arrows) out.set(a.from, [...(out.get(a.from) ?? []), a]);
	const color = new Map<string, 1 | 2>();
	const back = new Set<string>();
	const visit = (root: string) => {
		const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
		color.set(root, 1);
		while (stack.length) {
			const top = stack[stack.length - 1];
			const next = (out.get(top.id) ?? [])[top.i++];
			if (!next) {
				color.set(top.id, 2);
				stack.pop();
				continue;
			}
			const c = color.get(next.to);
			if (c === 1) back.add(next.id);
			else if (!c) {
				color.set(next.to, 1);
				stack.push({ id: next.to, i: 0 });
			}
		}
	};
	for (const s of view.starts) if (!color.get(s)) visit(s);
	for (const s of view.states) if (!color.get(s.id)) visit(s.id);
	return back;
}

// Orthogonal polyline -> path with rounded bends, as PR Lens draws its edges.
function roundedPath(pts: Pt[]): string {
	const clean = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
	let d = `M${n(clean[0].x)},${n(clean[0].y)}`;
	for (let i = 1; i < clean.length - 1; i++) {
		const a = clean[i - 1];
		const b = clean[i];
		const c = clean[i + 1];
		const lin = Math.hypot(b.x - a.x, b.y - a.y);
		const lout = Math.hypot(c.x - b.x, c.y - b.y);
		const r = Math.min(BEND_RADIUS_MAX, lin / 2, lout / 2);
		const p1 = { x: b.x - ((b.x - a.x) / lin) * r, y: b.y - ((b.y - a.y) / lin) * r };
		const p2 = { x: b.x + ((c.x - b.x) / lout) * r, y: b.y + ((c.y - b.y) / lout) * r };
		d += ` L${n(p1.x)},${n(p1.y)} Q${n(b.x)},${n(b.y)} ${n(p2.x)},${n(p2.y)}`;
	}
	const z = clean[clean.length - 1];
	return `${d} L${n(z.x)},${n(z.y)}`;
}

interface Card {
	title: string[];
	sub: string | null;
	badge: { text: string; tone: "removed" | "modified" | "added" | "neutral" } | null;
	glyph: "route" | "test" | "service";
	cls: string;
	w: number;
	h: number;
}

function cardFor(view: View, s: View["states"][number]): Card {
	const isEnd = view.ends.includes(s.id);
	const isStart = view.starts.includes(s.id);
	const textX = CARD_PADDING_X + ICON_CHIP_SIZE + ICON_CHIP_GAP;
	const title = wrapWidth(s.label, 240, TITLE_SIZE, true);
	const sub = s.mark ? s.rules.join(", ") : isEnd ? "end state" : isStart ? "start" : null;
	const badge = s.mark === "breaks"
		? { text: "BREAKS", tone: "removed" as const }
		: s.mark === "mayBreak"
			? { text: "MAY BREAK", tone: "modified" as const }
			: isEnd
				? { text: "END", tone: "added" as const }
				: null;
	const textW = Math.max(...title.map(t => measure(t, TITLE_SIZE, true)), sub ? measure(sub, SUBTITLE_SIZE, false, true) : 0);
	const badgeW = badge ? measure(badge.text, BADGE_TEXT_SIZE, true) * (1 + BADGE_TRACKING) + 2 * BADGE_PADDING_X : 0;
	const w = Math.ceil(Math.max(textX + textW + CARD_PADDING_X, badgeW + 2 * CARD_PADDING_X, 140));
	const h = (sub ? CARD_HEIGHT_WITH_SUBTITLE : CARD_HEIGHT) + (title.length - 1) * TITLE_LINE;
	const cls = s.mark === "breaks" ? "card card-breaks" : s.mark === "mayBreak" ? "card card-maybreak" : isEnd ? "card card-end" : "card";
	return { title, sub, badge, glyph: isStart ? "route" : isEnd ? "test" : "service", cls, w, h };
}

function drawCard(c: Card, x: number, y: number): string {
	const chipY = y + (c.h - ICON_CHIP_SIZE) / 2;
	const chipX = x + CARD_PADDING_X;
	const textX = chipX + ICON_CHIP_SIZE + ICON_CHIP_GAP;
	const block = c.title.length * TITLE_LINE + (c.sub ? 18 : 0);
	let ty = y + (c.h - block) / 2 + 12;
	const parts = [
		`<rect class="${c.cls}" x="${n(x)}" y="${n(y)}" width="${n(c.w)}" height="${n(c.h)}" rx="${CARD_RADIUS}"/>`,
		`<rect class="chip" x="${n(chipX)}" y="${n(chipY)}" width="${ICON_CHIP_SIZE}" height="${ICON_CHIP_SIZE}" rx="${ICON_CHIP_RADIUS}"/>`,
		`<g>${glyph(c.glyph, chipX + ICON_CHIP_SIZE / 2, chipY + ICON_CHIP_SIZE / 2)}</g>`,
	];
	for (const line of c.title) {
		parts.push(`<text class="ntitle" x="${n(textX)}" y="${n(ty)}" font-size="${TITLE_SIZE}">${esc(line)}</text>`);
		ty += TITLE_LINE;
	}
	if (c.sub) parts.push(`<text class="nsub" x="${n(textX)}" y="${n(ty + 2)}">${esc(c.sub)}</text>`);
	if (c.badge) {
		const bw = measure(c.badge.text, BADGE_TEXT_SIZE, true) * (1 + BADGE_TRACKING) + 2 * BADGE_PADDING_X;
		const bx = x + c.w - CARD_PADDING_X - bw;
		const by = y - BADGE_RISE;
		parts.push(
			`<g class="bdg bdg-${c.badge.tone}"><rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${BADGE_HEIGHT}" rx="8"/>` +
				`<text x="${n(bx + bw / 2)}" y="${n(by + 11.5)}" text-anchor="middle">${esc(c.badge.text)}</text></g>`,
		);
	}
	return `<g class="cardsh">${parts.join("\n")}</g>`;
}

function renderSvg(view: View, layout: Layout): { svg: string; drawn: number; back: number } {
	const arrows = mergeArrows(view);
	const back = backArrowIds(view, arrows);
	const onBugPath = new Set<string>();
	for (const p of view.bugPaths ?? []) for (const s of p.steps) onBugPath.add(`${s.from}\u0000${s.to}`);
	const cards = new Map(view.states.map(s => [s.id, cardFor(view, s)]));
	const START = "__start";
	const START_R = 7;
	const labelLines = new Map<string, string[]>();
	const edges: ElkEdge[] = view.starts.map((s, i) => ({ id: `start${i}`, sources: [START], targets: [s], labels: [] }));
	for (const a of arrows) {
		const lines = wrapWidth(a.labels.join(" / "), 180, PILL_TEXT_SIZE, true);
		labelLines.set(a.id, lines);
		const w = Math.max(...lines.map(l => measure(l, PILL_TEXT_SIZE, true))) + 2 * PILL_PADDING_X;
		// A back arrow goes to ELK reversed, so every layer flows downward; it is drawn the right way round below.
		const [src, dst] = back.has(a.id) ? [a.to, a.from] : [a.from, a.to];
		edges.push({ id: a.id, sources: [src], targets: [dst], labels: [{ text: a.id, width: w, height: PILL_HEIGHT * lines.length }] });
	}
	const r = layout({
		id: "root",
		width: 0,
		height: 0,
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "DOWN",
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
			"elk.separateConnectedComponents": "false",
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
			"elk.edgeLabels.placement": "CENTER",
			"elk.spacing.nodeNode": "48",
			"elk.layered.spacing.nodeNodeBetweenLayers": "52",
			"elk.spacing.edgeNode": "20",
			"elk.spacing.edgeEdge": "14",
			"elk.layered.spacing.edgeEdgeBetweenLayers": "14",
			"elk.layered.spacing.edgeNodeBetweenLayers": "18",
			"elk.spacing.edgeLabel": "6",
			"elk.spacing.labelLabel": "6",
			"elk.padding": "[top=28,left=32,bottom=32,right=32]",
		},
		children: [
			{ id: START, width: START_R * 2, height: START_R * 2 },
			...view.states.map(s => ({ id: s.id, width: cards.get(s.id)!.w, height: cards.get(s.id)!.h })),
		],
		edges,
	});
	const W = Math.ceil(r.width);
	const H = Math.ceil(r.height);
	const pos = new Map((r.children ?? []).map(c => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
	const lines: string[] = [];
	const pills: string[] = [];
	const motion: string[] = [];
	for (const e of r.edges ?? []) {
		const sec = e.sections?.[0];
		if (!sec) continue;
		let pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
		const isBack = back.has(e.id);
		if (isBack) pts = [...pts].reverse();
		const d = roundedPath(pts);
		if (e.id.startsWith("start")) {
			lines.push(`<path class="edge edge-neutral" d="${d}" marker-end="url(#mk-neutral)"/>`);
			continue;
		}
		const a = arrows.find(x => x.id === e.id)!;
		const hot = onBugPath.has(`${a.from}\u0000${a.to}`);
		const cls = `edge ${hot ? "edge-removed hero" : "edge-neutral"}${isBack ? " edge-back" : ""}`;
		if (hot) lines.push(`<path class="glow" stroke="${C.removed}" d="${d}"/>`);
		lines.push(`<path class="${cls}" d="${d}" marker-end="url(#${hot ? "mk-removed" : "mk-neutral"})"/>`);
		if (hot) motion.push(pulses(d, C.removed));
		const l = e.labels?.[0];
		if (l) {
			const text = labelLines.get(e.id)!;
			pills.push(
				`<g><rect class="lpill" x="${n(l.x ?? 0)}" y="${n(l.y ?? 0)}" width="${n(l.width)}" height="${n(l.height)}" rx="7.5"/>` +
					text
						.map(
							(t, i) =>
								`<text class="ltext${hot ? " ltext-removed" : ""}" x="${n((l.x ?? 0) + l.width / 2)}" y="${n((l.y ?? 0) + 11 + i * PILL_HEIGHT)}" text-anchor="middle">${esc(t)}</text>`,
						)
						.join("") +
					"</g>",
			);
		}
	}
	const nodes: string[] = [];
	const sp = pos.get(START)!;
	nodes.push(`<circle cx="${n(sp.x + START_R)}" cy="${n(sp.y + START_R)}" r="${START_R}" fill="${C.muted}"/>`);
	for (const s of view.states) {
		const p = pos.get(s.id)!;
		nodes.push(drawCard(cards.get(s.id)!, p.x, p.y));
	}
	const title = esc(view.title || "Statechart");
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}">`,
		`<title>${title}</title>`,
		`<style>${SVG_CSS}</style>`,
		DEFS,
		`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${C.background}"/>`,
		`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="url(#dots)"/>`,
		`<g>${lines.join("\n")}</g>`,
		`<g>${nodes.join("\n")}</g>`,
		`<g>${pills.join("\n")}</g>`,
		`<g>${motion.join("\n")}</g>`,
		"</svg>",
	].join("\n");
	return { svg, drawn: arrows.length - back.size, back: back.size };
}

function page(view: View, svg: string, drawn: number, back: number): string {
	const label = new Map(view.states.map(s => [s.id, s.label]));
	const rules = view.rules ?? [];
	const broken = rules.filter(r => r.verdict === "breaks").length;
	const unchecked = rules.filter(r => r.verdict === "not checked").length;
	const chip = (value: string | number, text: string, tone = "neutral") =>
		`<span class="sc-chip sc-tone-${tone}"><b>${esc(String(value))}</b> ${esc(text)}</span>`;
	const chips = [
		chip(view.states.length, "states"),
		chip(view.arrows.length, "steps"),
		chip(broken, broken === 1 ? "rule breaks" : "rules break", broken ? "removed" : "added"),
		chip(rules.length - broken - unchecked, "rules hold", "added"),
		...(unchecked ? [chip(unchecked, "not checked", "modified")] : []),
	].join("");
	const tone = { breaks: "removed", holds: "added", "not checked": "modified" } as const;
	const ruleRows = rules
		.map(
			r =>
				`<li class="sc-rule"><span class="sc-badge sc-badge-${tone[r.verdict]}">${esc(r.verdict.toUpperCase())}</span>` +
				`<code>${esc(r.name)}</code><span class="sc-sentence">${esc(r.sentence)}</span></li>`,
		)
		.join("");
	const paths = (view.bugPaths ?? [])
		.map(p => {
			const steps = p.steps
				.map(s => `<li><span class="sc-pill">${esc(s.label)}</span><span class="sc-arrow">→</span><b>${esc(label.get(s.to) ?? s.to)}</b></li>`)
				.join("");
			return (
				`<section class="sc-path"><h3><span class="sc-badge sc-badge-removed">BREAKS</span><code>${esc(p.rule)}</code></h3>` +
				`<ol><li class="sc-first">Start in <b>${esc(label.get(p.start) ?? p.start)}</b></li>${steps}</ol></section>`
			);
		})
		.join("");
	return `<!doctype html>
<meta charset="utf-8">
<title>${esc(view.title || "Statechart")}</title>
<style>
:root { color-scheme: dark; --bg:#0b0e14; --fg:#c9d1d9; --dim:#8b949e; --line:#21262d; --card:#11151c;
        --add:${C.added}; --mod:${C.modified}; --rem:${C.removed}; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 ${SANS}; }
/* Page classes are sc-*: inline SVG <style> is not scoped, and the SVG styles bare text, .card and .chip. */
.sc-wrap { max-width:1400px; margin:0 auto; padding:2.5rem 1.5rem 6rem; }
.sc-wrap > h1 { font-size:1.9rem; margin:0 0 .4rem; line-height:1.25; }
.sc-prov { color:var(--dim); font:13px ${MONO}; }
.sc-chips { display:flex; gap:.6rem; flex-wrap:wrap; margin:1.2rem 0 2rem; }
.sc-chip { background:var(--card); border:1px solid var(--line); border-radius:999px; padding:.35rem .9rem; font-size:13px; color:var(--dim); }
.sc-chip b { color:var(--fg); font-size:15px; }
.sc-tone-added b { color:var(--add); } .sc-tone-removed b { color:var(--rem); } .sc-tone-modified b { color:var(--mod); }
.sc-diagram { margin:0; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1rem; overflow-x:auto; }
.sc-diagram svg { display:block; margin:0 auto; max-width:100%; height:auto; }
.sc-diagram figcaption { color:var(--dim); font:12px ${MONO}; margin-top:.6rem; }
.sc-badge { display:inline-block; font:700 10px/1 ${SANS}; letter-spacing:.06em; padding:.3rem .55rem; border-radius:8px; border:1px solid; margin-right:.6rem; vertical-align:middle; }
.sc-badge-removed { color:var(--rem); background:rgba(248,81,73,.12); border-color:rgba(248,81,73,.4); }
.sc-badge-added { color:var(--add); background:rgba(46,160,67,.15); border-color:rgba(63,185,80,.4); }
.sc-badge-modified { color:var(--mod); background:rgba(187,128,9,.15); border-color:rgba(210,153,34,.4); }
ul.sc-rules { list-style:none; padding:0; }
.sc-rule { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:.8rem 1.1rem; margin:.6rem 0; }
.sc-rule code, .sc-path code { font:13px ${MONO}; color:var(--fg); margin-right:.8rem; }
.sc-sentence { color:var(--dim); }
.sc-path { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1rem 1.2rem; margin:.8rem 0; }
.sc-path h3 { margin:0 0 .6rem; font-size:1rem; }
.sc-path ol { margin:0; padding-left:1.4rem; }
.sc-path li { margin:.3rem 0; }
.sc-pill { display:inline-block; font:600 12px ${SANS}; color:var(--rem); background:#0d1117; border:1px solid #21262d; border-radius:999px; padding:.05rem .6rem; }
.sc-arrow { color:var(--dim); margin:0 .5rem; }
h2 { margin-top:2.5rem; }
</style>
<div class="sc-wrap">
<h1>${esc(view.title || "Statechart")}</h1>
<p class="sc-prov">statechart · ${drawn} arrows drawn top to bottom · ${back} dashed arrows go back to an earlier state</p>
<div class="sc-chips">${chips}</div>
<figure class="sc-diagram">${svg}<figcaption>red line and moving dots: shortest path to a broken rule · red card: breaks a rule · amber dashed card: may break · green card: end state · dashed line: back to an earlier state</figcaption></figure>
${rules.length ? `<h2>Rules</h2><ul class="sc-rules">${ruleRows}</ul>` : ""}
${paths ? `<h2>Shortest paths to each break</h2>${paths}` : ""}
</div>
`;
}

async function main() {
	const outDir = process.argv[2];
	if (!outDir) {
		console.error("usage: bun render.ts <out-dir>");
		process.exit(2);
	}
	const file = path.resolve(outDir, "chart.html");
	// Never leave an older page behind that no longer matches chart.json.
	fs.rmSync(file, { force: true });
	let view: View;
	try {
		view = await Bun.file(path.join(outDir, "chart.json")).json();
	} catch (err) {
		console.error(`cannot read ${outDir}/chart.json: ${err}. Run model.py --out ${outDir} first.`);
		process.exit(2);
	}
	let layout: Layout;
	try {
		layout = await loadElk();
	} catch (err) {
		console.error(`cannot load the layout engine: ${err}`);
		process.exit(2);
	}
	if (!view.rules) console.error("chart.json has no rules or bug paths; re-run model.py with the current template to get them.");
	const { svg, drawn, back } = renderSvg(view, layout);
	await Bun.write(file, page(view, svg, drawn, back));
	console.log(`${file} — ${view.states.length} states, ${drawn} arrows drawn, ${back} back arrows dashed`);
	console.log(Bun.pathToFileURL(file).href);
}

await main();