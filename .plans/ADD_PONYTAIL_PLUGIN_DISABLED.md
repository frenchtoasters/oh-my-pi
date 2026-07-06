# Add ponytail plugin (installed but disabled by default)

## Objective
Make the `ponytail` skill/plugin (https://github.com/DietrichGebert/ponytail, npm `@dietrichgebert/ponytail`) available in this fork as an **external dependency**, **without enabling it by default**. No deep integration — rely on the existing `omp` plugin system.

## Key Findings (from exploration)
- This fork is the `omp` (oh-my-pi / "pi") coding agent. Binary name is `omp` (`packages/utils/src/dirs.ts:20` → `APP_NAME = "omp"`).
- Plugin system lives in `packages/coding-agent/src/extensibility/plugins/`.
- ponytail's `package.json` ships a `pi` manifest:
  `"pi": { "extensions": ["./pi-extension/index.js"], "skills": ["./skills"] }`.
  The loader recognizes `pkg.omp || pkg.pi` (`loader.ts:83`), so this fork CAN load it directly — no code changes required.
- Install path: `omp plugin install <pkg>` → npm/bun install into the **global** plugins dir `~/.omp/plugins/node_modules/`, writes runtime state to the global lockfile `~/.omp/plugins/omp-plugins.lock.json` with `enabled: true` (`manager.ts:141-231`, `installer.ts`). This is per-user/global — NOT committed to the repo.
- **Enable gating** (`loader.ts:53-118` `getEnabledPlugins`):
  - A plugin with a runtime-state entry where `enabled === false` is skipped (`loader.ts:95`).
  - A plugin listed in project overrides `disabled[]` is skipped (`loader.ts:100`).
  - IMPORTANT: a plugin with **no** runtime entry is treated as enabled-by-default. So "installed but off" requires an explicit disable lever.
- **Project override file** (committable to the fork): `.omp/plugin-overrides.json`
  - Path resolver: `getProjectPluginOverridesPath` → `.omp/plugin-overrides.json` (`dirs.ts:453-456`).
  - Shape: `ProjectPluginOverrides` (`types.ts:156-163`): `{ disabled?: string[]; features?: {...}; settings?: {...} }`.
  - This file currently does NOT exist (`.omp/` has only `commands/`, `rules/`, `skills/`).
- CLI also supports `omp plugin disable <name> [--scope user|project]` and `omp plugin enable <name>` (`plugin-cli.ts:829-891`). `--scope project` writes to the project override file; default/global uses the lockfile via `manager.setEnabled` (requires the plugin to already be in runtime config, i.e. installed first).

## Decision: Approach
Ship a **committed project-level override** so the plugin is disabled by default for everyone using this fork, plus document the opt-in install/enable steps. This is the minimal, no-code-change path that satisfies "add it but don't enable by default" and "just an external dependency."

Two complementary pieces:

1. **Disable-by-default (committed):** Create `.omp/plugin-overrides.json` listing ponytail in `disabled[]`. This guarantees that even if a user runs `omp plugin install @dietrichgebert/ponytail` (which defaults to enabled in the global lockfile), it stays OFF in this project until they remove it from the override or explicitly enable with project scope.

   ```json
   {
     "disabled": ["@dietrichgebert/ponytail"]
   }
   ```

2. **Document the opt-in (README):** Add a short note in `README.md` near the plugin/subcommand section (around `README.md:243-244` features list and `:1167-1182` subcommands) describing:
   - Install:  `omp plugin install @dietrichgebert/ponytail`
   - It is disabled by default in this repo via `.omp/plugin-overrides.json`.
   - Enable when wanted:  `omp plugin enable @dietrichgebert/ponytail` (or remove it from the override's `disabled[]`).
   - Disable again:  `omp plugin disable @dietrichgebert/ponytail`.
   - Note ponytail's runtime needs `node` on PATH for its lifecycle hooks (skills still work without it).

### Why not vendor / deep-integrate
User explicitly wants it as an external dependency, not deeply integrated. The `pi` manifest already makes it loadable; no loader/registry changes are needed. We avoid adding it to any package.json dependency since plugins install into the user's global `~/.omp/plugins`, not the workspace.

### Why a committed override rather than relying on global disable
`manager.setEnabled` (global lockfile) only works after install and is per-user, so it can't be committed. The project override file lives in the repo and deterministically keeps it off for all fork users regardless of their global state.

## Files to change
- `.omp/plugin-overrides.json` — **create**. Add `{ "disabled": ["@dietrichgebert/ponytail"] }`.
- `README.md` — **edit**. Add a brief "Optional plugins / ponytail" note documenting install + enable/disable and the disabled-by-default behavior. (Place near existing plugin mentions, ~`:243` features and/or the `plugin` subcommand area `:1167-1182`.)
- (Optional) `CHANGELOG.md` at repo root or `packages/coding-agent/CHANGELOG.md` — add an `Added` entry under `[Unreleased]` noting ponytail is available as an optional, disabled-by-default plugin. Confirm with user whether they want a changelog entry.

## Open questions for user (resolve during/ before implementation)
- Pin a version (e.g. `@dietrichgebert/ponytail@4.8.4`) or track latest? Plan assumes latest (unpinned) since it's optional/off.
- Add a CHANGELOG entry? (Skill recommends it; optional here since no behavior changes for users by default.)
- Want the README to also mention the marketplace flow (`omp plugin marketplace add DietrichGebert/ponytail`) or keep it to the simple npm install? Plan uses the simple npm install.

## Verification
1. `read .omp/plugin-overrides.json` → valid JSON with ponytail in `disabled[]`.
2. (If install is exercised) `omp plugin install @dietrichgebert/ponytail` succeeds; `omp plugin list` shows it present but **not enabled** in this project (because of the override).
3. Confirm a fresh `omp` session in this repo does NOT auto-load ponytail's skills/extension (no ponytail rules injected) while the override is in place.
4. `omp plugin enable @dietrichgebert/ponytail` (or removing it from `disabled[]`) makes it active — confirm toggle works.
5. README note renders and matches actual command names (`omp plugin install/enable/disable`).
