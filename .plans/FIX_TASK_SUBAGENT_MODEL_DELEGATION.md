# Plan: Fix Task Subagent Model Delegation

## Problem

The `task` agent (the primary delegation workhorse for multi-file edits and investigations) always runs on the same model as the parent session (opus 4.6), even though it's intended to be configurable independently.

### Root Cause

In `packages/coding-agent/src/priority.json`, there is **no `task` entry**. The resolution chain for `pi/task`:

1. `resolveAgentModelPatterns()` in `model-resolver.ts:560` is called with `agentModel: "pi/task"`
2. `resolveConfiguredModelPatterns("pi/task", settings)` attempts to resolve it:
   - `getModelRoleAlias("pi/task")` → returns `"task"` role
   - `settings.getModelRole("task")` → `undefined` (no user config)  
   - `MODEL_PRIO["task"]` → **`undefined`** (no entry in `priority.json`)
   - Returns `undefined` → flatMapped to `[]`
3. `configuredAgentPatterns` = `[]` (empty)
4. The condition at line 570 (`configuredAgentPatterns.length > 0`) is **false** → skips the block
5. Falls through to line 575-577: uses `activeModelPattern` (the parent's current model) as fallback
6. Result: **`task` agent always inherits the parent session model (opus 4.6)**

The `quick_task` agent (uses `pi/smol`) resolves correctly because `smol` HAS an entry in `priority.json`.

### Current Agent Model Configuration

| Agent | Model Pattern | Resolves To |
|-------|--------------|-------------|
| `explore` | `pi/smol` | cerebras/zai-glm, haiku, flash, mini (CORRECT) |
| `plan` | `pi/plan, pi/slow` | `plan` has no entry → falls to `pi/slow` → expensive models |
| `designer` | `pi/designer` | gemini-3.1-pro (CORRECT) |
| `reviewer` | `pi/slow` | gpt-5.4, opus-4.6 (intentionally expensive) |
| `librarian` | `pi/smol` | cerebras/zai-glm, haiku, flash, mini (CORRECT) |
| **`task`** | **`pi/task`** | **Falls back to parent model (opus 4.6) — BUG** |
| `quick_task` | `pi/smol` | cerebras/zai-glm, haiku, flash, mini (CORRECT) |

## Solution

Add a `task` entry to `priority.json` with a tier of models appropriate for general coding tasks — capable enough for multi-file edits but cheaper than opus 4.6.

### File to Modify

- `packages/coding-agent/src/priority.json`

### Proposed Priority Entries

All patterns below resolve against the nmc-litellm provider's model catalog. Using bare patterns (no `litellm/` prefix) so the same chain works when switching to groundcontrol or cliproxy.

Pattern-to-model resolution:
- `"sonnet-4.6"` → canonical match → `litellm/claude-sonnet-4-6` (dot↔dash normalization)
- `"sonnet-4.5"` → canonical match → `litellm/claude-sonnet-4-5`
- `"sonnet-4"` → canonical match → `litellm/claude-sonnet-4`
- `"gpt-5.1"` → exact match → `litellm/gpt-5.1`
- `"gemini-3-flash"` → exact/includes match → `litellm/gemini-3-flash`
- `"flash"` → includes match → any available flash model

**`task`** — mid-range coding models (sonnet tier):
```json
"task": [
  "sonnet-4.6",
  "sonnet-4.5",
  "sonnet-4",
  "gpt-5.1",
  "gemini-3-flash",
  "flash"
]
```

**`plan`** — same tier as task:
```json
"plan": [
  "sonnet-4.6",
  "sonnet-4.5",
  "sonnet-4",
  "gpt-5.1",
  "gemini-3-flash",
  "flash"
]
```

This places both roles between `smol` (haiku/flash/mini — fast but limited) and `slow` (opus/gpt-5.4 — expensive reasoning). The sonnet tier is the natural fit: capable coding models at ~1/5th the cost of opus.

### Also auditing existing roles

The existing `smol` role has `"cerebras/zai-glm-4.7"` etc. with explicit `cerebras/` prefix — those won't resolve through litellm since the provider is wrong. However, the fallback entries (`"haiku"`, `"flash"`, `"mini"`) DO resolve against litellm models. No change needed — the cerebras entries just silently fail and resolution falls through to litellm-compatible entries.

The existing `slow` role uses `"opus-4.6"` etc. — these resolve via canonical matching (dot↔dash normalization + anthropic family expansion) to `litellm/claude-opus-4-6`. Working correctly.

The `designer` role uses `"google-gemini-cli/gemini-3.1-pro"` with explicit provider prefix — this only works if google-gemini-cli is available. Fallbacks include `"gemini-3-pro"` which resolves against litellm. Working correctly as fallback.

## Implementation

**Single file change**: `packages/coding-agent/src/priority.json`

Add `task` and `plan` entries to the JSON object. No other code changes needed — the resolution logic already supports these roles, they just had no default model chain.

## Verification

1. After the change, run the model-resolver test suite to confirm no regressions
2. Verify that `resolveConfiguredRolePattern("pi/task", settings)` now returns the task priority chain instead of `undefined`
3. Start a session and use the task tool to confirm subagents spawn on sonnet-class models instead of opus
4. Verify `plan` agent also resolves to the new chain instead of falling through to parent model

## Key Files

- `packages/coding-agent/src/priority.json` — the fix (add `task` and `plan` entries)
- `packages/coding-agent/src/config/model-resolver.ts:511-530` — `resolveConfiguredRolePattern` reads from MODEL_PRIO
- `packages/coding-agent/src/task/executor.ts:565` — where agent model is consumed
- `packages/coding-agent/src/task/index.ts:586-592` — where `resolveAgentModelPatterns` is called
- `packages/coding-agent/src/task/agents.ts:55-56` — task agent frontmatter (`model: "pi/task"`)

## Decisions

1. **Task role tier**: Sonnet-class models (sonnet-4.6 through flash) — capable for multi-file coding, ~1/5th cost of opus
2. **Plan role**: Same tier as task — architecture decisions can be handled by sonnet-class models; plan is rare so cost savings are minimal but consistency is nice
3. **No code changes needed beyond priority.json** — the resolution logic already supports the `task` and `plan` roles, they just had no default model chain
4. **Behavior change**: After this fix, `pi/task` will NO LONGER inherit the parent session model by default. If a user explicitly wants task agents on opus, they can set `modelRoles.task` in their config to override
5. **Provider flexibility**: Using bare patterns (no provider prefix) so models resolve against whichever provider (litellm, groundcontrol, cliproxy) is active/preferred. Provider selection is controlled by `modelProviderOrder` setting and usage history.