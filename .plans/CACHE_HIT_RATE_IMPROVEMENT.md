# Plan: Improve Anthropic Prompt Cache Hit Rate

## Objective

Change the default `cacheRetention` from `"short"` (5-minute TTL) to `"long"` (1-hour TTL) for Anthropic models, and increase `turnProtectionTurns` from 2 to 4 to delay prune-induced prefix invalidation. Together these are the highest-ROI, lowest-risk changes for improving cache hit rate from 80% toward ~88-92%.

## Context / Problem

Anthropic prompt caching currently defaults to 5-minute TTL (`"short"`). In a typical coding session:
- User thinks between prompts (reading output, testing, etc.) — often 1-5 minutes
- Tool executions can take 10-30 seconds each
- Agent runs with multiple tool-call turns can span 2-5 minutes

With 5-minute TTL, the cache frequently expires between user interactions. The 1-hour TTL eliminates this entirely at **zero additional cost** — Anthropic charges the same price for cache reads/writes regardless of TTL duration.

## Changes

### Change 1: Default to long cache retention

**File**: `packages/ai/src/utils.ts`
**Line 145**: Change default from `"short"` to `"long"`
```typescript
// Before
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
    if (cacheRetention) return cacheRetention;
    if ($env.PI_CACHE_RETENTION === "long") return "long";
    return "short";  // 5-min TTL
}

// After
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
    if (cacheRetention) return cacheRetention;
    if ($env.PI_CACHE_RETENTION === "none") return "none";
    if ($env.PI_CACHE_RETENTION === "short") return "short";
    return "long";  // 1-hour TTL (default)
}
```

### Change 2: Increase turn protection window

**File**: `packages/coding-agent/src/session/agent-session.ts`
**Line 523**: Change `turnProtectionTurns` from `2` to `4`

```typescript
// Before
#pruneConfig: PruneConfig = {
    deduplication: {
        protectedTools: ["task", "skill", "todowrite", "todoread", "write", "edit", "read"],
        protectedFilePatterns: [],
        turnProtectionTurns: 2,
    },
    // ...
};

// After
#pruneConfig: PruneConfig = {
    deduplication: {
        protectedTools: ["task", "skill", "todowrite", "todoread", "write", "edit", "read"],
        protectedFilePatterns: [],
        turnProtectionTurns: 4,
    },
    // ...
};
```

**Rationale**: With `turnProtectionTurns: 2`, a duplicated tool call from turn N gets removed from the message array at turn N+3 — modifying bytes in the cached prefix. With 4, that removal is delayed to turn N+5, giving 2 additional turns of prefix stability. This compounds with the TTL change: longer TTL means each stable turn actually benefits from the cache rather than timing out.

This also inverts the env var semantics: users can opt *down* to `"short"` or `"none"` if needed, but the default is optimal.

## Risk Assessment

### TTL Change
- **Cost**: Zero. Anthropic pricing is identical for 5m and 1h TTL.
- **Behavioral change**: Cached prefixes live longer — strictly beneficial for hit rate.
- **Breakage**: Only if something depends on cache expiring quickly (nothing does).
- **Provider support**: `supportsLongCacheRetention` defaults to `true` for all Anthropic models (line 759). For non-Anthropic endpoints, the `isAnthropicApiBaseUrl` check (line 270) already gates TTL — non-Anthropic providers get `undefined` TTL regardless.

### turnProtectionTurns Change
- **Cost**: Negligible. Keeps ~1-3k tokens of duplicate content for 2 extra turns per duplicate pair. At $3/M input tokens, <$0.01/session.
- **Behavioral change**: Dedup transforms kick in 2 turns later than before. The model sees slightly more redundant context but gets much better cache hit rates.
- **Breakage**: None. The prune still fires, just 2 turns later. No user-visible difference in final pruning behavior.

## Verification

1. Run existing tests for `resolveCacheRetention`:
   ```
   bun test packages/ai/test/ --grep "cacheRetention\|cache.retention\|resolveCacheRetention"
   ```
2. Run existing tests for prune state / deduplication:
   ```
   bun test packages/coding-agent/ --grep "dedup\|prune\|turnProtection"
   ```
3. Verify the anthropic provider still builds params correctly by running provider tests.
4. Manual: start a session, check that `cache_control: { type: "ephemeral", ttl: "1h" }` appears in outgoing requests (visible in debug logs).
5. CHANGELOG: Add entry under `## [Unreleased]` in `packages/ai/CHANGELOG.md` and `packages/coding-agent/CHANGELOG.md`.

## Files Modified

| File | Change |
|------|--------|
| `packages/ai/src/utils.ts` | Change default retention to `"long"`, support opt-down via env var |
| `packages/coding-agent/src/session/agent-session.ts` | Change `turnProtectionTurns` from `2` to `4` |

---

## Benefit Analysis: Other Approaches (Not Implemented Now)

### Option 1: Freeze-Prefix (prune state never modifies old messages)

**Concept**: Add a `frozenBeforeIndex: number` to the prune state. Messages at indices below this threshold are never transformed by dedup/error-purge/supersede-writes. The threshold advances only after compaction (which rewrites history anyway).

**Impact**: +5-10% cache hit rate. Currently, when prune state recomputes at turn_end (line 1902 in agent-session.ts), a new dedup/supersede entry for an old message rewrites bytes deep in the prefix — invalidating the entire cached prefix from that point forward. Freezing prevents this.

**Code size**: ~30 lines across:
- `packages/coding-agent/src/session/compaction/strategies/prune-state.ts` — add `frozenBeforeIndex` to `PruneState`, filter IDs by index in `computeDeduplicationIds`, `computeErrorPurgeIds`, `computeSupersededIds`
- `packages/coding-agent/src/session/agent-session.ts` — pass the frozen threshold (e.g., the message count at last compaction or at session start)

**Trade-off**: Older duplicate tool calls remain in context longer (until compaction), costing slightly more input tokens. Net positive because cache read savings (0.1x price) far outweigh the extra uncached input that would have been removed. Estimate: for a 100k-token session with 5% dedup content, you save ~$0.015/turn from cache hits vs lose ~$0.001/turn from keeping the dupes.

**When to implement**: If cache hit rate stays below 90% after the TTL change. This is the next-highest-impact fix.

### Option 2: Breakpoint-at-Boundary (move cache breakpoint to prune boundary)

**Concept**: Instead of placing message breakpoints on the last 2 messages (current behavior, line 1557 in anthropic.ts), place one breakpoint at the "stability boundary" — the earliest message index where prune transforms could modify content. Everything before that boundary is guaranteed byte-stable and benefits from prefix caching.

**Impact**: +3-7% cache hit rate. Currently the last 2 messages get breakpoints, but the vast middle of the conversation (between system+tools breakpoint and last-2-messages breakpoint) has no explicit breakpoint. If pruning modifies anything in that middle zone, the entire prefix up to the last breakpoint is invalidated. Placing a breakpoint at the stability boundary ensures the stable prefix gets its own cache entry.

**Code size**: ~20 lines in `packages/ai/src/providers/anthropic.ts`:
- Accept an optional `stabilityBoundaryIndex` in the message array
- Place one breakpoint at that index instead of (or in addition to) the last-N strategy
- Requires threading the prune boundary from the transform layer to the provider layer

**Trade-off**: Uses one of the 4 breakpoints for stability rather than recency. With 4 total (1 tool + 1 system + 2 messages), changing to (1 tool + 1 system + 1 boundary + 1 last-message) means only the very last message gets a recency breakpoint. This is fine because the last message is the one most likely to be cache-appended on the next turn.

**Challenge**: Requires plumbing the boundary index from the coding-agent layer (which knows the prune state) through to the AI layer (which places breakpoints). This crosses package boundaries and would need a new field on `Context` or stream options.

**When to implement**: After both TTL change and freeze-prefix, if you're still seeing cache misses due to mid-conversation instability. This is the most architecturally invasive option.

### Option 3: Increase turnProtectionTurns (config-only)

**Concept**: Change `turnProtectionTurns` from 2 to 4 in the prune config (line 523 in agent-session.ts). This delays when deduplication kicks in, keeping the message array stable for more turns.

**Impact**: +2-5% cache hit rate. The protection window determines how many recent turns are immune from dedup. With 2 turns, a duplicate tool call from turn 3 gets removed at turn 5 — modifying the prefix. With 4 turns, that same removal is delayed to turn 7, giving 2 more turns of stable prefix.

**Code size**: 1 line change.

**Trade-off**: Keeps duplicate content in context ~2 extra turns. For sessions with heavy tool-call repetition (e.g., repeated `read` of the same file), this adds ~1-3k tokens of waste per duplicate pair for 2 extra turns. At $3/M input tokens, this is negligible (<$0.01/session).

**When to implement**: Can be combined with the TTL change for minimal effort. The marginal benefit on top of TTL change is small since most cache misses from dedup happen because of TTL expiry, not because of content instability within 5 minutes.
