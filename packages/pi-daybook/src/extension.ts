// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /daybook — Daily/Weekly Session Notes
 *
 * Scans your Pi session history over a chosen period (today / yesterday / this
 * week / last week / last N days) and generates an Obsidian-style daily/weekly
 * note in Markdown summarizing the work done across all sessions in that window.
 *
 * Usage:
 *   /daybook               — pick a period interactively (or defaults to today)
 *   /daybook today
 *   /daybook yesterday
 *   /daybook week          — this ISO week
 *   /daybook last-week
 *   /daybook 3d            — last 3 days
 *
 * Output dir: ~/Obsidian/Daily Notes/ (override with --daybook-dir or
 * the OMP_DAYBOOK_DIR env var). Filenames: YYYY-MM-DD.md (daily),
 * YYYY-[W]ww.md (weekly).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_VAULT_DIR = join(homedir(), "Obsidian", "Daily Notes");
const BASE_TAG = "#daybook";

const MAX_SESSIONS = 60;
const MAX_PROMPTS_PER_SESSION = 12;
const MAX_PROMPT_CHARS = 400;
const MAX_TRANSCRIPT_CHARS = 60_000;

// ─── Types ────────────────────────────────────────────────────────────────────

type AnyEntry = Record<string, unknown>;
type AnyMessage = Record<string, unknown>;
type ContentBlock = {
	type: string;
	text?: string;
	name?: string;
	intent?: string;
	[k: string]: unknown;
};

type PeriodKind = "daily" | "weekly";

interface Period {
	kind: PeriodKind;
	label: string;
	startMs: number;
	endMs: number;
	/** Anchor date used for the note title / filename. */
	anchor: Date;
}

interface TokenStats {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface ModelUsage {
	sessions: Set<string>;
	messages: number;
	cost: number;
	tokens: TokenStats;
}

interface SessionSummary {
	id: string;
	title: string;
	repo: string;
	prompts: string[];
	toolCounts: Map<string, number>;
	intents: string[];
}

// ─── Period parsing ───────────────────────────────────────────────────────────

const PERIOD_CHOICES = ["today", "yesterday", "week", "last-week", "last 7 days"];

function startOfDay(d: Date): Date {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

/** Monday-00:00 of the ISO week containing `d`. */
function startOfIsoWeek(d: Date): Date {
	const x = startOfDay(d);
	const day = x.getDay(); // 0=Sun..6=Sat
	const diff = (day + 6) % 7; // days since Monday
	x.setDate(x.getDate() - diff);
	return x;
}

function isoWeekNumber(d: Date): { year: number; week: number } {
	// ISO 8601 week number.
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
	date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
	const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
	const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
	const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
	return { year: date.getUTCFullYear(), week };
}

function parsePeriod(raw: string): Period | null {
	const arg = raw.trim().toLowerCase();
	const now = new Date();

	// last N days: "3d", "7d", "last 3 days", "last-3-days"
	const dMatch = arg.match(/(\d+)\s*d(?:ays?)?/) ?? arg.match(/last[\s-]*(\d+)[\s-]*days?/);
	if (dMatch) {
		const n = Math.max(1, Number.parseInt(dMatch[1]!, 10));
		const start = startOfDay(now);
		start.setDate(start.getDate() - (n - 1));
		return {
			kind: "daily",
			label: `last ${n} day${n === 1 ? "" : "s"}`,
			startMs: start.getTime(),
			endMs: now.getTime(),
			anchor: now,
		};
	}

	if (arg === "" || arg === "today") {
		const start = startOfDay(now);
		return { kind: "daily", label: "today", startMs: start.getTime(), endMs: now.getTime(), anchor: now };
	}

	if (arg === "yesterday") {
		const start = startOfDay(now);
		start.setDate(start.getDate() - 1);
		const end = startOfDay(now);
		const anchor = new Date(start);
		return { kind: "daily", label: "yesterday", startMs: start.getTime(), endMs: end.getTime(), anchor };
	}

	if (arg === "week" || arg === "this-week" || arg === "this week") {
		const start = startOfIsoWeek(now);
		return { kind: "weekly", label: "this week", startMs: start.getTime(), endMs: now.getTime(), anchor: now };
	}

	if (arg === "last-week" || arg === "last week" || arg === "lastweek") {
		const thisWeek = startOfIsoWeek(now);
		const start = new Date(thisWeek);
		start.setDate(start.getDate() - 7);
		const anchor = new Date(start);
		return {
			kind: "weekly",
			label: "last week",
			startMs: start.getTime(),
			endMs: thisWeek.getTime(),
			anchor,
		};
	}

	return null;
}

// ─── Session parsing ──────────────────────────────────────────────────────────

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter(b => b.type === "text" && typeof b.text === "string")
		.map(b => b.text as string)
		.join(" ");
}

function isHumanMessage(msg: AnyMessage): boolean {
	const content = msg.content;
	if (typeof content === "string" && (content as string).trim()) return true;
	if (Array.isArray(content)) {
		return (content as ContentBlock[]).some(
			b => b.type === "text" && typeof b.text === "string" && (b.text as string).trim().length > 0,
		);
	}
	return false;
}

/** Detect sessions spawned by pipelines (insights/daybook) rather than real user work. */
function isMetaSession(entries: AnyEntry[]): boolean {
	let userMsgCount = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;
		if (msg.role === "user" && isHumanMessage(msg)) {
			const text = extractTextFromContent(msg.content);
			if (
				text.includes("RESPOND WITH ONLY A VALID JSON OBJECT") ||
				text.includes("extract structured facets") ||
				text.includes("Obsidian daily-note") ||
				text.includes("Obsidian-style")
			)
				return true;
			userMsgCount++;
			if (userMsgCount >= 3) break;
		}
	}
	return false;
}

function repoName(cwd: string): string {
	if (!cwd) return "(unknown)";
	return basename(cwd) || cwd;
}

function buildSessionSummary(id: string, title: string, cwd: string, entries: AnyEntry[]): SessionSummary {
	const prompts: string[] = [];
	const toolCounts = new Map<string, number>();
	const intents: string[] = [];
	const seenToolIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		if (msg.role === "user" && isHumanMessage(msg)) {
			if (prompts.length < MAX_PROMPTS_PER_SESSION) {
				const text = extractTextFromContent(msg.content).replace(/\s+/g, " ").trim();
				if (text) prompts.push(text.slice(0, MAX_PROMPT_CHARS));
			}
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content as ContentBlock[]) {
				if (block.type !== "toolCall") continue;
				const toolName = (block.name as string) ?? "";
				const toolId = (block.id as string) ?? Math.random().toString(36);
				if (seenToolIds.has(toolId)) continue;
				seenToolIds.add(toolId);
				if (toolName) toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
				if (typeof block.intent === "string" && block.intent.trim() && intents.length < 20) {
					intents.push(block.intent.trim().slice(0, 160));
				}
			}
		}
	}

	return { id, title: title || "(untitled session)", repo: repoName(cwd), prompts, toolCounts, intents };
}

// ─── Usage aggregation ────────────────────────────────────────────────────────

function emptyTokens(): TokenStats {
	return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Parse a session file for assistant-message usage that falls within the window.
 * Uses the same `${timestamp}:${totalTokens}` dedupe as pi-usage to avoid
 * double-counting history copied across branched session files.
 */
async function accumulateUsage(
	filePath: string,
	sessionId: string,
	startMs: number,
	endMs: number,
	byModel: Map<string, ModelUsage>,
	seenHashes: Set<string>,
): Promise<boolean> {
	let contributed = false;
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		return false;
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: AnyEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg || msg.role !== "assistant") continue;
		const usage = msg.usage as Record<string, number & { total?: number }> | undefined;
		if (!usage || !msg.model) continue;

		const input = (usage.input as number) || 0;
		const output = (usage.output as number) || 0;
		const cacheRead = (usage.cacheRead as number) || 0;
		const cacheWrite = (usage.cacheWrite as number) || 0;
		const fallbackTs = entry.timestamp ? new Date(entry.timestamp as string).getTime() : 0;
		const ts = (msg.timestamp as number) || (Number.isNaN(fallbackTs) ? 0 : fallbackTs);

		const totalTokens = input + output + cacheRead + cacheWrite;
		const hash = `${ts}:${totalTokens}`;
		if (seenHashes.has(hash)) continue;
		seenHashes.add(hash);

		if (ts < startMs || ts >= endMs) continue;

		const cost = ((usage.cost as { total?: number } | undefined)?.total as number) || 0;
		const model = msg.model as string;
		let m = byModel.get(model);
		if (!m) {
			m = { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens() };
			byModel.set(model, m);
		}
		m.sessions.add(sessionId);
		m.messages++;
		m.cost += cost;
		m.tokens.total += input + output + cacheWrite;
		m.tokens.input += input;
		m.tokens.output += output;
		m.tokens.cacheRead += cacheRead;
		m.tokens.cacheWrite += cacheWrite;
		contributed = true;
	}
	return contributed;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatCost(cost: number): string {
	if (cost === 0) return "-";
	if (cost < 10) return `$${cost.toFixed(2)}`;
	if (cost < 100) return `$${cost.toFixed(1)}`;
	return `$${Math.round(cost)}`;
}

function formatTokens(count: number): string {
	if (count === 0) return "-";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCacheHitRate(tokens: TokenStats): string {
	const denom = tokens.input + tokens.cacheRead;
	if (denom === 0) return "-";
	return `${Math.round((tokens.cacheRead / denom) * 100)}%`;
}

function formatNumber(n: number): string {
	if (n === 0) return "-";
	return n.toLocaleString();
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

function ymd(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ─── Tag sanitization ─────────────────────────────────────────────────────────

function sanitizeTags(rawTags: string[]): string[] {
	const out: string[] = [BASE_TAG];
	const seen = new Set([BASE_TAG.slice(1)]);
	for (const raw of rawTags) {
		const clean = raw
			.toLowerCase()
			.replace(/^#+/, "")
			.replace(/[^a-z0-9]/g, "");
		if (!clean || seen.has(clean)) continue;
		seen.add(clean);
		out.push(`#${clean}`);
		if (out.length >= 10) break;
	}
	return out;
}

// ─── Prompt + note assembly ───────────────────────────────────────────────────

function buildTranscript(summaries: SessionSummary[]): string {
	const byRepo = new Map<string, SessionSummary[]>();
	for (const s of summaries) {
		const list = byRepo.get(s.repo) ?? [];
		list.push(s);
		byRepo.set(s.repo, list);
	}

	const parts: string[] = [];
	let total = 0;
	for (const [repo, list] of byRepo) {
		let block = `## Repo: ${repo}\n`;
		for (const s of list) {
			block += `\n### Session: ${s.title}\n`;
			if (s.prompts.length) {
				block += `User prompts:\n${s.prompts.map(p => `- ${p}`).join("\n")}\n`;
			}
			const tools = [...s.toolCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([name, n]) => `${name}×${n}`)
				.join(", ");
			if (tools) block += `Tools: ${tools}\n`;
			if (s.intents.length) {
				block += `Tool intents:\n${s.intents
					.slice(0, 8)
					.map(i => `- ${i}`)
					.join("\n")}\n`;
			}
		}
		if (total + block.length > MAX_TRANSCRIPT_CHARS) {
			parts.push(block.slice(0, Math.max(0, MAX_TRANSCRIPT_CHARS - total)));
			break;
		}
		parts.push(block);
		total += block.length;
	}
	return parts.join("\n");
}

function buildPrompt(period: Period, transcript: string): string {
	return `You are summarizing a developer's AI coding-agent sessions into an Obsidian ${period.kind === "weekly" ? "weekly" : "daily"} note.

Period: ${period.label} (${ymd(new Date(period.startMs))} to ${ymd(new Date(period.endMs))}).

Below is a compact transcript of all sessions in this window, grouped by repository. Each session lists the user's prompts and the tools/intents the assistant used.

Write Markdown for EXACTLY these sections, and nothing else (no frontmatter, no top-level heading, no code fences):

## Summary
<2-4 sentence narrative of what was worked on across all repos during ${period.label}.>

## Highlights
- <3-6 bullet points of the most notable accomplishments or decisions>

## Sessions
### <repo name>
- **<session title>** — <one-line recap of what happened in that session>
(group sessions by repository using ### repo headings; one bullet per session)

## Tags
<a single line of 3 to 8 space-separated Obsidian tags describing the kinds of work, each a single lowercase word with a leading '#', no hyphens, e.g. "#refactor #testing #docs #bugfix">

TRANSCRIPT:
${transcript}`;
}

async function callModel(ctx: ExtensionCommandContext, prompt: string): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("No active model");
	const apiKey = (await ctx.modelRegistry.getApiKey(model as never)) ?? "";
	const response = await completeSimple(
		model as never,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey },
	);
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("");
}

/** Split the model output into a body (everything before ## Tags) and its tag list. */
function splitBodyAndTags(modelText: string): { body: string; tags: string[] } {
	const idx = modelText.search(/^##\s+Tags\s*$/im);
	if (idx === -1) return { body: modelText.trim(), tags: [] };
	const body = modelText.slice(0, idx).trim();
	const tagSection = modelText.slice(idx);
	const tags = (tagSection.match(/#[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []).map(t => t.slice(1));
	return { body, tags };
}

function renderUsageTable(byModel: Map<string, ModelUsage>): string {
	const rows: string[] = ["| Model | Sessions | Msgs | Cost | Tokens | Cache Hit |", "|---|---|---|---|---|---|"];
	const totals: ModelUsage = { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens() };
	const sorted = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
	for (const [model, u] of sorted) {
		rows.push(
			`| ${model} | ${formatNumber(u.sessions.size)} | ${formatNumber(u.messages)} | ${formatCost(u.cost)} | ${formatTokens(u.tokens.total)} | ${formatCacheHitRate(u.tokens)} |`,
		);
		for (const s of u.sessions) totals.sessions.add(s);
		totals.messages += u.messages;
		totals.cost += u.cost;
		totals.tokens.total += u.tokens.total;
		totals.tokens.input += u.tokens.input;
		totals.tokens.output += u.tokens.output;
		totals.tokens.cacheRead += u.tokens.cacheRead;
		totals.tokens.cacheWrite += u.tokens.cacheWrite;
	}
	rows.push(
		`| **Total** | ${formatNumber(totals.sessions.size)} | ${formatNumber(totals.messages)} | ${formatCost(totals.cost)} | ${formatTokens(totals.tokens.total)} | ${formatCacheHitRate(totals.tokens)} |`,
	);
	return rows.join("\n");
}

function assembleNote(
	period: Period,
	body: string,
	tags: string[],
	usageTable: string,
): { filename: string; content: string } {
	let title: string;
	let filename: string;
	let subtitle = "";
	if (period.kind === "weekly") {
		const { year, week } = isoWeekNumber(period.anchor);
		title = `${year}-W${pad2(week)}`;
		filename = `${title}.md`;
		subtitle = `\n_${ymd(new Date(period.startMs))} – ${ymd(new Date(period.endMs))}_\n`;
	} else {
		title = ymd(period.anchor);
		filename = `${title}.md`;
	}

	const noteType = period.kind === "weekly" ? "weekly-note" : "daily-note";
	const frontmatterTags = tags.map(t => t.slice(1));
	const tagsLine = tags.join(" ");

	// Ensure the model body always has the ## Tags section rendered by us.
	const content = `---
date: ${ymd(period.anchor)}
type: ${noteType}
tags: [${frontmatterTags.join(", ")}]
---
# ${title}
${subtitle}
${body.trim()}

## Usage
${usageTable}

## Tags
${tagsLine}
`;

	return { filename, content };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function resolveOutputDir(pi: ExtensionAPI): string {
	const flag = pi.getFlag("daybook-dir");
	if (typeof flag === "string" && flag.trim()) return expandHome(flag.trim());
	const env = process.env.OMP_DAYBOOK_DIR;
	if (env?.trim()) return expandHome(env.trim());
	const configured = settings.get("daybook.folder");
	if (typeof configured === "string" && configured.trim()) return expandHome(configured.trim());
	return DEFAULT_VAULT_DIR;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function runDaybook(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.model) {
		ctx.ui.notify("No active model — set a model first (/model)", "error");
		return;
	}

	// ── Resolve period ──
	let arg = rawArgs.trim();
	if (!arg && ctx.hasUI) {
		const choice = await ctx.ui.select("Daybook period", PERIOD_CHOICES);
		if (!choice) return;
		arg = choice === "last 7 days" ? "7d" : choice;
	}
	const period = parsePeriod(arg);
	if (!period) {
		ctx.ui.notify(`Unknown period "${arg}". Try: today, yesterday, week, last-week, 3d`, "error");
		return;
	}

	ctx.ui.setStatus("daybook", `📓 Scanning sessions for ${period.label}...`);

	const currentSessionId = ctx.sessionManager.getSessionId() ?? "";
	const allInfos = await SessionManager.listAll();

	// Coarse overlap filter: session activity window intersects the period.
	const candidates = allInfos.filter(info => {
		if (info.id === currentSessionId) return false;
		const created = info.created.getTime();
		const modified = info.modified.getTime();
		return modified >= period.startMs && created < period.endMs;
	});

	const summaries: SessionSummary[] = [];
	const byModel = new Map<string, ModelUsage>();
	const seenHashes = new Set<string>();

	for (const info of candidates.slice(0, MAX_SESSIONS)) {
		try {
			const sm = await SessionManager.open(info.path);
			const entries = sm.getEntries() as unknown as AnyEntry[];
			if (isMetaSession(entries)) continue;

			// Only keep sessions that actually have assistant activity in the window.
			const contributed = await accumulateUsage(
				info.path,
				info.id,
				period.startMs,
				period.endMs,
				byModel,
				seenHashes,
			);
			if (!contributed) continue;

			summaries.push(buildSessionSummary(info.id, info.title ?? "", info.cwd, entries));
		} catch {
			// Skip sessions that fail to load
		}
	}

	if (summaries.length === 0) {
		ctx.ui.setStatus("daybook", undefined);
		ctx.ui.notify(`No sessions found for ${period.label}.`, "warning");
		return;
	}

	ctx.ui.setStatus("daybook", `📓 Summarizing ${summaries.length} sessions...`);

	const transcript = buildTranscript(summaries);
	const modelText = await callModel(ctx, buildPrompt(period, transcript));
	const { body, tags } = splitBodyAndTags(modelText);
	const cleanTags = sanitizeTags(tags);
	const usageTable = renderUsageTable(byModel);
	const { filename, content } = assembleNote(period, body, cleanTags, usageTable);

	const outDir = resolveOutputDir(pi);
	await mkdir(outDir, { recursive: true });
	const outPath = join(outDir, filename);

	if (await fileExists(outPath)) {
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm("Overwrite note?", `${outPath} already exists. Overwrite it?`);
			if (!ok) {
				ctx.ui.setStatus("daybook", undefined);
				ctx.ui.notify("Daybook cancelled — existing note kept.", "info");
				return;
			}
		}
	}

	await writeFile(outPath, content, "utf8");
	ctx.ui.setStatus("daybook", undefined);
	ctx.ui.notify(`✅ Daybook note saved: ${outPath}`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("daybook-dir", {
		description: "Output directory for daybook notes (default ~/Obsidian/Daily Notes)",
		type: "string",
	});

	pi.registerCommand("daybook", {
		description: "Generate an Obsidian-style daily/weekly session note (today | yesterday | week | last-week | 3d)",
		getArgumentCompletions: () => PERIOD_CHOICES.map(label => ({ value: label, label })),
		handler: async (args, ctx) => {
			try {
				await runDaybook(pi, args ?? "", ctx);
			} catch (err) {
				ctx.ui.setStatus("daybook", undefined);
				ctx.ui.notify(`Daybook failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
