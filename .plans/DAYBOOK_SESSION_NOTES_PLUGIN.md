# Daily/Weekly Session Notes Plugin

## Objective
Add a new omp extension package `@oh-my-pi/pi-daybook` that scans the user's
session history over a chosen period (today / yesterday / this week / last week /
last N days) and generates an Obsidian-style daily/weekly note in Markdown
summarizing the work done across all sessions in that window. The note follows an
Obsidian daily-note template layout and includes one-word Obsidian `#tags`
describing the kinds of work in the sessions.

## Size
Medium — new single-package extension, one main file, plus manifest/tsconfig.

## How It Works (design)
1. User runs the slash command `/daybook [period]` (e.g. `/daybook today`,
   `/daybook week`, `/daybook last-week`, `/daybook 3d`). If no arg and UI is
   available, show a `ctx.ui.select` picker for the period.
2. Enumerate sessions via `SessionManager.listAll()` (returns `SessionInfo`:
   `{ id, path, cwd, title?, created, modified, messageCount }`).
3. Filter sessions whose activity falls in the period. Use `created`/`modified`
   for a coarse filter; a session counts if it overlaps the window.
   Exclude the current session id (`ctx.sessionManager` current id) and
   meta/pipeline sessions (reuse the `isMetaSession` heuristic idea from
   pi-insights — optional, keep minimal).
4. For each matching session, `SessionManager.open(info.path)` +
   `getEntries()`; build a compact transcript: session title, cwd (repo name),
   user prompts (extract text from `message.role === "user"` human messages),
   and tool-usage signals (bash/edit/write/read tool names + intents). Cap total
   size per session and overall to stay within context.
5. Summarize with the active model via `completeSimple` from `@oh-my-pi/pi-ai`
   (same pattern as pi-insights `callModel`): send the aggregated transcript +
   a prompt instructing the model to return an Obsidian daily/weekly note in
   Markdown, plus a small set of one-word lowercase tags.
   - Prompt asks for a strict output: a `## Summary`, `## Highlights`,
     `## Sessions` (bulleted per-session recap grouped by repo), and a
     `#tag1 #tag2 ...` line of single-word topical tags.
   - Provide the template skeleton in the prompt so the model fills it in.
6. Assemble the final note: Obsidian frontmatter + template body. The plugin
   owns the deterministic scaffolding (title, date, frontmatter, tags line);
   the model fills the prose sections. This avoids depending on the model to
   get frontmatter/format exactly right.
7. Write the note to a file and report the path. Output dir is a FIXED vault
   path, default `~/Obsidian/Daily Notes/`, overridable via a registered flag
   `--daybook-dir` (and env/setting fallback). Expand `~`. Create dir if missing.
   Filename:
   - daily: `YYYY-MM-DD.md`
   - weekly: `YYYY-[W]ww.md` (ISO week)
   If UI available, `ctx.ui.confirm` before overwriting an existing file.
8. Usage breakdown: reuse the pi-usage aggregation approach — parse assistant
   messages' `usage` (input/output/cacheRead/cacheWrite/cost) with the same
   `${timestamp}:${totalTokens}` dedupe, aggregate per model and per provider
   for the window, and render a Markdown table (Sessions / Msgs / Cost / Tokens /
   Input / Output / Cache / CacheHit) plus a totals row. Include this as a
   `## Usage` section in the note.

## Obsidian Note Template (scaffold the plugin emits)
```markdown
---
date: 2026-06-11
type: daily-note
tags: [work, session-summary]
---
# 2026-06-11

## Summary
<model prose>

## Highlights
- <bullets>

## Sessions
### <repo name>
- **<session title>** — <one-line recap>

## Usage
| Model | Sessions | Msgs | Cost | Tokens | Cache Hit |
|---|---|---|---|---|---|
| … | … | … | … | … | … |
| **Total** | … | … | … | … | … |

## Tags
#coding #refactor #debugging
```
Weekly variant uses `type: weekly-note`, an ISO-week `# 2026-W24` heading, and a
date-range subtitle.

## Tags
- Model is instructed to emit 3-8 single-word, lowercase, hyphen-free Obsidian
  tags reflecting session topics (e.g. `#refactor`, `#testing`, `#docs`,
  `#bugfix`, `#config`). Plugin sanitizes: lowercase, strip non-alnum, dedupe,
  ensure leading `#`, drop empties. Always include a base `#session-summary`
  minus the hyphen constraint (allow one hyphen for this base tag) — or use
  `#daybook`. Final decision: base tag `#daybook`, plus model tags.

## Files to Create
- `packages/pi-daybook/package.json` — manifest mirroring pi-insights:
  deps `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-utils`;
  `omp.extensions`
  `["./src/extension.ts"]`; name `@oh-my-pi/pi-daybook`.
- `packages/pi-daybook/tsconfig.json` — `extends ../tsconfig.workspace.json`,
  `include: ["src"]`.
- `packages/pi-daybook/src/extension.ts` — the extension:
  - `export default function (pi: ExtensionAPI)` registering command `daybook`.
  - Period parsing, session enumeration + filtering, transcript building,
    `completeSimple` call, note assembly, file write, and UI status/notify.
- `packages/pi-daybook/README.md` — short usage doc.
- (optional) `packages/pi-daybook/LICENSE`.

## Files to Reference / Reuse Patterns
- `packages/pi-insights/src/extension.ts:1302` — `callModel`/`completeSimple`
  pattern (model + `ctx.modelRegistry.getApiKey` + `completeSimple`).
- `packages/pi-insights/src/extension.ts:583` — `extractTextFromContent`,
  `isHumanMessage`, `isMetaSession` heuristics to copy in minimal form.
- `packages/pi-insights/src/extension.ts:2618` — `SessionManager.listAll()` /
  `SessionManager.open()` / `getEntries()` usage.
- `packages/pi-usage/src/extension.ts:280` — assistant message/tool shape
  (`entry.message.content[].type === "toolCall"`, `.name`, `.intent`).
- `packages/pi-usage/src/extension.ts:256-462` — usage aggregation:
  `parseSessionFile` dedupe (`${timestamp}:${totalTokens}`), `accumulateStats`,
  per-model/provider stats, and `formatCost`/`formatTokens`/`formatCacheHitRate`
  helpers to adapt into Markdown table rows.
- `packages/pi-usage/src/extension.ts:209` — `getOmpSessionsDir()` from
  `@oh-my-pi/pi-utils` (matches where omp writes sessions).
- `packages/coding-agent/src/session/session-manager.ts:258` — `SessionInfo`.
- `packages/coding-agent/src/extensibility/extensions/types.ts:1026` —
  `registerCommand`; `:252` `ExtensionCommandContext` (has `ui`, `hasUI`,
  `cwd`, `sessionManager`, `model`, `modelRegistry`).

## Registration in Monorepo
- Add `packages/pi-daybook` to the workspace (bun workspaces auto-globs
  `packages/*` per root `package.json`; confirm during impl and run
  `bun install` to link, then the plugin is loadable). Verify how other
  packages get enabled (`.omp/plugin-overrides.json`) and enable if needed.

## Verification
- `bun run --cwd packages/pi-daybook check` (biome + tsgo types) passes.
- Manual: launch omp, run `/daybook today` in a repo with recent sessions;
  confirm a Markdown note is written to `Daily Notes/YYYY-MM-DD.md` with
  frontmatter, Summary/Highlights/Sessions sections, and a `#tag` line.
- Run `/daybook week` and `/daybook 3d`; confirm period filtering and weekly
  filename/heading.
- Edge cases: no sessions in window → notify "no sessions", write nothing;
  no active model → notify error; existing file → confirm overwrite.

## Resolved Decisions
- Output dir: FIXED vault path, default `~/Obsidian/Daily Notes/`, overridable
  via `--daybook-dir` flag. (Not per-repo.)
- Content: narrative summary + FULL token/cost usage breakdown table (per model,
  with totals) similar to the pi-usage plugin.
- Scope: GLOBAL — all repos/projects with sessions active in the window; group
  the Sessions section by repo.