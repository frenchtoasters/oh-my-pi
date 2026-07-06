# Ponytail ruleset for omp — config-driven adapter + global skills

## Request
User's omp fork made `pi`/opencode plugins incompatible; installing ponytail (`@dietrichgebert/ponytail`) broke sessions. User wants **only ponytail's ruleset/skills** under omp — NOT to run ponytail's own extension. Refinements:
- The ruleset must be **config-driven, toggleable on/off** via omp settings.
- The **5 extra commands** (`ponytail-review/audit/debt/gain/help`) shipped as **global omp skills**, available like other native skills.

## Root cause (why ponytail's own extension breaks omp) — verified
ponytail's `pi-extension/index.js` `before_agent_start` returns `{ systemPrompt: \`${event.systemPrompt}\n\n${rules}\` }` — a **string** built by concatenating an array. omp's contract: `BeforeAgentStartEvent.systemPrompt` is a **`string[]`** (`extensions/types.ts:495`); the runner assigns the handler's returned `systemPrompt` back verbatim (`extensions/runner.ts:824-826`) and `agent-session.ts:3271-3272` calls `agent.setSystemPrompt(result.systemPrompt)` expecting a `string[]`. String where array is required → corrupted prompt. Our adapter returns the correct `string[]`; ponytail's package stays disabled and unexecuted.

## Verified facts about omp
- **Builtin extensions** are vendored MIT workspace packages under `packages/` that default-export an `ExtensionFactory` and are registered in `BUILTIN_EXTENSIONS` (`extensions/loader.ts:41-44`, importing `@oh-my-pi/pi-insights` / `@oh-my-pi/pi-usage` at `loader.ts:9,11`). `packages/pi-usage/` is the template: `src/extension.ts` with SPDX header + `Vendored from …` attribution, imports from `@oh-my-pi/pi-coding-agent`.
- **Extension API** used all exist: `api.registerCommand` (`extensions/loader.ts:152`), `api.on("before_agent_start", …)` returning `{ systemPrompt: string[] }` (`extensions/runner.ts:824`), `api.appendEntry` (`loader.ts:210`), `api.on("session_start", …)`.
- **Settings are group-based.** `SETTINGS_SCHEMA` (`config/settings-schema.ts:234`) holds dotted keys with `{ type, default, ui }` (e.g. `"ttsr.enabled"` `:1327`, `"exa.enabled"` `:2433`). `GroupTypeMap` (`:2865`) maps group → typed interface. `settings.getGroup("ttsr")` (`config/settings.ts:386`) returns the typed object. `settings` singleton + `Settings` are exported from `@oh-my-pi/pi-coding-agent` (`src/index.ts:18`).
- **Global/native skills** come from the filesystem via the `native` provider (`discovery/builtin.ts:293`): it scans `~/.omp/skills/` (user) and `.omp/skills/` (project) using `scanSkillsFromDir`. This repo already ships committed skills at `.omp/skills/system-prompts/SKILL.md` and `.omp/skills/semantic-compression/SKILL.md`. There is **no compiled-in bundled-skill list** — native skills are just SKILL.md dirs. So "global skills like others" = add SKILL.md dirs under `.omp/skills/`.
- **ponytail ruleset content** = `skills/ponytail/SKILL.md` with frontmatter stripped, filtered by mode (drop non-matching intensity-table rows + worked-example bullets), prefixed `PONYTAIL MODE ACTIVE — level: <mode>`. ~30 lines of trivial logic; reproduce rather than depend on ponytail's CJS modules.

## Decisions (locked from user answers)
- **Config-driven toggle:** new settings group `ponytail` with `ponytail.enabled` (bool) and `ponytail.defaultMode` (enum off/lite/full/ultra). Extension no-ops entirely when `ponytail.enabled === false`.
- **5 extra commands → global skills:** ship `ponytail-review/audit/debt/gain/help` as committed native skills under `.omp/skills/`, exactly like the existing ones. No extension commands for these.
- **Ruleset extension** owns: mode state, `/ponytail [lite|full|ultra|off]` command (mode switch + report), session-persisted mode, and `before_agent_start` injection using correct `string[]`.
- ponytail npm package stays **disabled** in `.omp/plugin-overrides.json` (already is).
- **Vendoring:** copy ponytail's MIT SKILL bodies + ruleset text into the repo with SPDX + attribution (matches how `packages/pi-usage` is vendored). No runtime dep on the ponytail package.

## Files to change / create

### 1. Ruleset extension (config-toggled)
- **create** `packages/ponytail/` workspace package mirroring `packages/pi-usage/` (`package.json` name `@oh-my-pi/ponytail`, `tsconfig.json`, `LICENSE`, `src/extension.ts` with SPDX + `Vendored from https://github.com/DietrichGebert/ponytail` attribution). Contents of `src/extension.ts`:
  - Default-export `ExtensionFactory`.
  - On factory init: read `settings.getGroup("ponytail")`; if `!enabled`, register nothing and return (full off).
  - Vendored SKILL body as a string constant + `filterSkillBodyForMode(body, mode)` + `getPonytailInstructions(mode)` (~30 lines).
  - Mode state init from `defaultMode` (and optional `PONYTAIL_DEFAULT_MODE` env — one line, keep it).
  - `api.registerCommand("ponytail", …)` — set/report mode.
  - `api.on("session_start", …)` — restore mode from latest `appendEntry("ponytail-mode")`.
  - `api.on("before_agent_start", …)` — if mode !== "off": `return { systemPrompt: [...event.systemPrompt, getPonytailInstructions(mode)] }` (correct `string[]`).
- **edit** `packages/coding-agent/src/extensibility/extensions/loader.ts` — import factory next to lines 9/11; add `{ name: "ponytail", factory: ponytailExtension }` to `BUILTIN_EXTENSIONS` (`:41-44`). Loading is cheap and self-gates on `ponytail.enabled`, so no loader-level gate needed.

### 2. Config schema (the toggle)
- **edit** `packages/coding-agent/src/config/settings-schema.ts`:
  - Add to `SETTINGS_SCHEMA`: `"ponytail.enabled"` (`type:"boolean"`, `default:false` — off by default so the fork is unchanged until opted in; confirm default in Q1), and `"ponytail.defaultMode"` (`type:"enum"`, values `["off","lite","full","ultra"]`, `default:"full"`), each with a `ui: { tab, label, description }` like `ttsr.enabled`.
  - Add `export interface PonytailSettings { enabled: boolean; defaultMode: "off"|"lite"|"full"|"ultra"; }`.
  - Add `ponytail: PonytailSettings;` to `GroupTypeMap` (`:2865`).

### 3. Global skills (the 5 commands)
- **create** under `.omp/skills/` (committed, project-level native skills — same as existing `system-prompts/`, `semantic-compression/`):
  - `.omp/skills/ponytail-review/SKILL.md`
  - `.omp/skills/ponytail-audit/SKILL.md`
  - `.omp/skills/ponytail-debt/SKILL.md`
  - `.omp/skills/ponytail-gain/SKILL.md`
  - `.omp/skills/ponytail-help/SKILL.md`
  - Each copied from ponytail `skills/<name>/SKILL.md` (MIT), frontmatter `name`/`description` preserved so omp's `requireDescription` discovery accepts them; add a short MIT/attribution note. (Optionally also `.omp/skills/ponytail/SKILL.md` as the reference skill, though the ruleset ships via the extension.)

### 4. Housekeeping
- **edit** `CHANGELOG.md` (repo root) — `Added`: config-toggle `ponytail.enabled`/`ponytail.defaultMode`, `/ponytail` mode command, and global `ponytail-*` skills. Note ponytail npm plugin stays disabled (incompatible extension not executed).
- `.omp/plugin-overrides.json` — no change (ponytail stays disabled).
- **edit** workspace config if needed so `packages/ponytail` is picked up (root `package.json` workspaces / `tsconfig` refs — mirror how `packages/pi-usage` is wired; confirm during impl).

## Open questions
1. **Default of `ponytail.enabled`:** `false` (fork unchanged until user flips it — recommended, matches "toggle on/off") or `true`? Recommend `false`.
2. **Settings UI tab** for the two ponytail keys — reuse an existing tab (e.g. the one `ttsr`/`exa` use) or a dedicated label? Minor; will follow the nearest existing convention.

## Verification
1. `bun test` (extensions/config packages) green. New unit test: `filterSkillBodyForMode` keeps non-mode bullets, drops other modes' intensity rows; `before_agent_start` returns `string[]` (base+1 length), never a string.
2. With `ponytail.enabled=false` (default): no `/ponytail` command, no ruleset injected — identical to today. Confirms clean off state.
3. Set `ponytail.enabled=true`: system prompt cleanly includes "PONYTAIL MODE ACTIVE — level: full" + ladder (not a comma-joined blob). `/ponytail lite|ultra|off` switches; mode persists across turns and restores after reload; `/ponytail` with no arg reports current+default.
4. `ponytail-review/audit/debt/gain/help` appear in omp's skill list (like `system-prompts`, `semantic-compression`) and are invocable.
5. ponytail npm package NOT loaded (still disabled in `.omp/plugin-overrides.json`); no extension error mentions `@dietrichgebert/ponytail`.
6. Regression: `pi-insights`, `pi-usage`, and other `before_agent_start` handlers unaffected.
