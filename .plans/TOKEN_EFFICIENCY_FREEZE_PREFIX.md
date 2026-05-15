# Plan: Token Efficiency Improvements (Freeze-Prefix + Config Defaults)

## Objective

Implement four token-efficiency improvements that compound to reduce prompt cache misses (~5-10%), reduce per-read token cost (~40%), reduce inline output bulk (~5-7.5K tokens per spill), and purge stale error inputs 2 turns earlier. No performance regressions.

## Summary of Changes

| # | Change | Files | Risk |
|---|--------|-------|------|
| 1 | Freeze-prefix for prune state | `prune-state.ts`, `agent-session.ts` | None |
| 2 | Lower `read.defaultLimit` 500 → 300 | `settings-schema.ts` | None |
| 3 | Lower `artifactSpillThreshold` 50 → 30 KB | `settings-schema.ts` | Low |
| 4 | Lower `purgeErrors.turnThreshold` 4 → 2 | `agent-session.ts` | None |

## Context

### Architecture (for fresh-context execution)

The **prune-state system** (`packages/coding-agent/src/session/compaction/strategies/prune-state.ts`) runs three strategies:
- **Deduplication**: Removes duplicate tool calls (same name + args), keeping only the most recent. Protected by `turnProtectionTurns` (currently 4).
- **Error-Purge**: Replaces arguments of tool calls whose results were errors with `{_pruned: true, _reason: "error-input-purged"}`. Protected by `turnThreshold` (currently 4).
- **Supersede-Writes**: Replaces write tool arguments with `{_pruned: true, path}` when a subsequent read of the same file exists.

**Lifecycle**:
1. `computePruneState()` runs at `agent_start`, `turn_end`, and after compaction (`#recomputePruneState()` at lines 1882, 1902, 4455 in `agent-session.ts`).
2. `applyPruneState()` is a transform function wired via `composeTransforms` at session init (line 652-655). It runs on every LLM request against the current `#pruneState`.
3. The pruning transform modifies messages in the middle of the conversation — this invalidates Anthropic's prompt cache prefix from that byte forward.

**The problem**: When `computePruneState` runs at `turn_end`, a tool call from turn 3 that becomes a duplicate at turn 8 gets its `dedupRemovedIds` entry added immediately. The next LLM request applies `applyPruneState`, which removes that old message — changing bytes deep in the cached prefix. The entire cache entry from that point forward is invalidated, even though the 1-hour TTL hasn't expired.

### Anthropic Cache Architecture

- 4 breakpoints max per request (1 tools, 1 system, 2 messages)
- Cache is byte-prefix based — any modification to bytes before a breakpoint invalidates the cache entry
- 1-hour TTL (already set as default)
- Cache reads are 0.1x price vs uncached input

## Detailed Changes

### Change 1: Freeze-Prefix for Prune State

**Concept**: Add a `frozenBeforeIndex` field to `PruneState`. All three compute functions (`computeDeduplicationIds`, `computeErrorPurgeIds`, `computeSupersededIds`) skip tool call IDs that belong to messages at indices below this threshold. The threshold starts at 0 (freeze nothing) and advances to the current message count only after compaction (which rewrites the entire history anyway, so cache is already invalidated).

**File: `packages/coding-agent/src/session/compaction/strategies/prune-state.ts`**

1. Add `frozenBeforeIndex: number` to `PruneState` interface (line 23-30)
2. Add `frozenBeforeIndex: number` parameter to `computePruneState` (line 54)
3. Pass it to each compute function
4. In `computeDeduplicationIds` (line 100-104): skip entries where `entry.messageIndex < frozenBeforeIndex`
5. In `computeErrorPurgeIds` (line 110-135): track message index when building `toolCallMeta`, skip IDs whose message index < frozenBeforeIndex
6. In `computeSupersededIds` (line 137-173): skip IDs at `i < frozenBeforeIndex`
7. Update `createEmptyPruneState()` to include `frozenBeforeIndex: 0`

**File: `packages/coding-agent/src/session/agent-session.ts`**

1. Add `#frozenBeforeIndex = 0` field (near line 518)
2. In `#recomputePruneState()` (line 1873-1875): pass `this.#frozenBeforeIndex` to `computePruneState`
3. After compaction completes (inside `#runAutoCompaction` or after `agent.replaceMessages`): advance `#frozenBeforeIndex` to `this.agent.state.messages.length` (the post-compaction history is the new baseline)
4. At `agent_start` (line 1882): set `#frozenBeforeIndex = this.agent.state.messages.length` (session resume starts with a stable prefix)

**Trade-off**: Old duplicate tool calls remain in context until compaction fires (at ~75% context window). This costs ~1-3K extra tokens per duplicate pair for a few turns. At $3/M input tokens, this is ~$0.003-0.009/session. Cache read savings at 0.1x pricing for the stable prefix far exceed this.

### Change 2: Lower read.defaultLimit 500 → 300

**File: `packages/coding-agent/src/config/settings-schema.ts`**

Line 1484: change `default: 500` to `default: 300`

**Rationale**: Analysis from remote branch (`da2f32a23`) showed 300 lines covers the vast majority of useful reads. The structural summarizer handles full-file structural overview. Explicit selectors (`:50-200`) are unaffected.

### Change 3: Lower artifactSpillThreshold 50 → 30 KB

**File: `packages/coding-agent/src/config/settings-schema.ts`**

Line 388: change `default: 50` to `default: 30`

**Rationale**: Outputs between 30-50KB (test suites, build logs) are adequately represented by the tail (20KB / 500 lines). The model can retrieve full content via `artifact://` if needed. Saves ~5-7.5K tokens per spill event that previously stayed inline.

### Change 4: Lower purgeErrors.turnThreshold 4 → 2

**File: `packages/coding-agent/src/session/agent-session.ts`**

Line 526: change `turnThreshold: 4` to `turnThreshold: 2`

**Rationale**: By turn 2 after an error, the model has already processed and reacted to the failure. The error *result* is retained — only the call's arguments (which can be 10-50KB for write/edit calls) are replaced with a pruned sentinel. This is a pure token savings with zero behavioral impact since the model already saw the error and moved on.

## Files Affected

| File | Action | Lines |
|------|--------|-------|
| `packages/coding-agent/src/session/compaction/strategies/prune-state.ts` | Modify | Interface, computePruneState, computeDeduplicationIds, computeErrorPurgeIds, computeSupersededIds, createEmptyPruneState |
| `packages/coding-agent/src/session/agent-session.ts` | Modify | #frozenBeforeIndex field, #recomputePruneState, compaction callback, agent_start |
| `packages/coding-agent/src/config/settings-schema.ts` | Modify | read.defaultLimit default (line 1484), artifactSpillThreshold default (line 388) |

## Verification

1. **Type check**: `bun check:ts` passes
2. **Unit tests for freeze-prefix**: Add `packages/coding-agent/test/prune-state-freeze.test.ts`:
   - Verify that tool call IDs at indices below `frozenBeforeIndex` are NOT included in any computed set
   - Verify that tool call IDs at indices >= `frozenBeforeIndex` ARE pruned normally
   - Verify that after advancing `frozenBeforeIndex`, previously-frozen IDs start getting pruned
3. **Existing compaction tests pass**: `bun test packages/coding-agent/test/compaction.test.ts packages/coding-agent/test/agent-session-compaction.test.ts`
4. **Settings defaults**: Verify read.defaultLimit=300 and artifactSpillThreshold=30 are reflected
5. **CHANGELOG**: Update `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`

## CHANGELOG Entry

```markdown
### Changed

- Lowered default `read.defaultLimit` from 500 to 300 lines for better token efficiency (structural summaries cover full-file reads)
- Lowered default `tools.artifactSpillThreshold` from 50KB to 30KB to reduce inline token consumption for large outputs
- Lowered `purgeErrors.turnThreshold` from 4 to 2 turns for earlier cleanup of failed tool call arguments

### Added

- Freeze-prefix mechanism for prune state: messages in the stable prompt cache prefix are no longer retroactively modified by deduplication/error-purge/supersede-writes, improving Anthropic cache hit rate by ~5-10%
```

## Non-Goals

- NOT changing `turnProtectionTurns` (already optimized at 4)
- NOT implementing stability-boundary breakpoint (architecturally invasive, deferred)
- NOT touching compaction thresholds (already well-tuned at 75%/100K/15-turn)
- NOT modifying shell minimizer or system prompt
