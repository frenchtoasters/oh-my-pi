# Enable Local Memory Backend + Set Memory Model Roles

## Objective
Turn on the **local** autonomous memory backend in `~/.omp/agent/config.yml` and set the model roles the memory pipeline uses: Phase 1 (`default` role) → `toaster/claude-opus-4:off`, Phase 2 (`smol` role) → `toaster/claude-sonnet-4:off`. Config-only — no source code changes.

## Size
Small (single user config file, one section added).

## Decision
- User chose: **Local backend** + **change the GLOBAL `default` and `smol` model roles**.
- Memory has NO model override of its own. `resolveMemoryModel` (`memories/index.ts:1066`) reads the global roles: Phase 1 (extraction) uses `default` (`index.ts:233`), Phase 2 (consolidation) uses `smol` (`index.ts:388`).
- New role values (confirmed by user):
  - `default` → `toaster/claude-opus-4:off`  (Phase 1 extraction AND all primary agent turns)
  - `smol`    → `toaster/claude-sonnet-4:off` (Phase 2 consolidation AND commit/title generation, model-cycling)
- BLAST RADIUS (acknowledged): these roles are global. Changing `default` changes the model for every agent turn; changing `smol` affects commit messages (`commit/model-selection.ts`), title generation (`utils/title-generator.ts`), and role cycling — not memory alone.
- `toaster` provider is NOT in `disabledProviders`, so it is usable.

## Key Findings
- Backend selected by `memory.backend` enum (`off|local|hindsight`), default `off` (`settings-schema.ts:1173`).
- Resolver: `memory-backend/resolve.ts:19` → `local` maps to `localBackend`.
- `loadMemoryConfig` enables when `memory.backend === "local"` OR legacy `memories.enabled === true` (`memories/index.ts:1080`).
- Local pipeline (`docs/memory.md`): Phase 1 extracts durable signal per past session; Phase 2 consolidates into `MEMORY.md`, `memory_summary.md` (injected at session start, cap `summaryInjectionTokenLimit: 5000`), and `skills/`. Per-project (per cwd) scope. Secret-redacted before write. SQLite job queue with leases. Runs in background at startup, not in the agent turn.
- Slash commands: `/memory view|clear|reset|enqueue|rebuild`.
- Current config has NO `memory:` section (so it defaults to off).

## Changes To Make
File: `~/.omp/agent/config.yml`

**1. Add memory backend** (top-level section, e.g. after the `secrets:` block before `providers:`):
```yaml
memory:
  backend: local
```
All other `memories.*` knobs keep documented defaults (maxRolloutsPerStartup 64, maxRolloutAgeDays 30, minRolloutIdleHours 12, summaryInjectionTokenLimit 5000).

**2. Update model roles** under the existing `modelRoles:` block (lines 69-78):
- `default: cli-proxy/claude-opus-4-8:high` → `default: toaster/claude-opus-4:off`
- `smol: nmc-prod/claude-haiku-4.5:off` → `smol: toaster/claude-sonnet-4:off`
Leave all other roles (large, reasoning, fast, task, designer, commit, reviewer) unchanged.

## Files To Modify
- `~/.omp/agent/config.yml` —
  - add `memory:` / `  backend: local`
  - set `modelRoles.default: toaster/claude-opus-4:off`
  - set `modelRoles.smol: toaster/claude-sonnet-4:off`

## Verification
1. Re-read `~/.omp/agent/config.yml`; confirm:
   - `memory.backend: local` present, valid YAML, 2-space indent.
   - `modelRoles.default` = `toaster/claude-opus-4:off`.
   - `modelRoles.smol` = `toaster/claude-sonnet-4:off`.
2. (Optional) In a new session, `/memory view` reports no payload yet (expected until the pipeline processes an idle session) — confirms backend active. Model indicator should reflect the new `default`.
3. No build/test needed — user config file, not repo source.

## Notes
- Personal config file outside the repo: no CHANGELOG entry, no MR (config-only / no GitLab artifact).
- `default` and `smol` are GLOBAL roles; memory has no dedicated model setting. Changing them affects all primary turns (`default`) and commit/title/cycling (`smol`), per user's confirmed choice.
