# Context Pruning Trigger Alignment Plan

## Problem Statement

Our context pruning/compaction works correctly but triggers too infrequently. We need to align our auto-triggering behavior with the reference implementations (DCP plugin and anomalyco/opencode) to ensure compaction fires more aggressively before sessions grow unwieldy.

## Current State (Oh My Pi)

### Trigger Points

Our compaction triggers in **4 ways**:

1. **Manual**: `/compact [instructions]` - user-initiated
2. **Overflow recovery**: After a context-overflow error from the LLM provider
3. **Threshold maintenance**: After a **successful** assistant turn when `contextTokens > resolveThresholdTokens()`
4. **Idle maintenance**: Timer-based, after agent finishes and user is idle

### Current Default Configuration

| Setting | Default | Effect |
|---------|---------|--------|
| `compaction.enabled` | `true` | Master switch |
| `compaction.thresholdPercent` | `-1` (disabled) | No percentage-based threshold |
| `compaction.thresholdTokens` | `-1` (disabled) | No fixed-token threshold |
| `compaction.reserveTokens` | `16384` | Reserve for output |
| `compaction.idleEnabled` | **`false`** | Idle compaction OFF by default |
| `compaction.idleThresholdTokens` | `200000` | Idle fires above 200K tokens |
| `compaction.idleTimeoutSeconds` | `300` | 5 minutes idle before firing |

### Effective Threshold (default)

When both `thresholdPercent` and `thresholdTokens` are `-1` (default), the formula is:
```
threshold = contextWindow - max(15% of contextWindow, reserveTokens)
```
For a 200K context model: `200000 - max(30000, 16384) = 170000` (85% of context)
For a 128K context model: `128000 - max(19200, 16384) = 108800` (85% of context)

**This means compaction only fires when we're already at ~85% of context window.**

### Call Flow

```
agent_end event
  -> event-controller.ts: #scheduleIdleCompaction() (arms timer)
  -> agent-session.ts: #checkCompaction(assistantMessage) 
     -> checks overflow first
     -> then #pruneToolOutputs()
     -> then shouldCompact(contextTokens, contextWindow, settings)
     -> if threshold exceeded: tries promotion, then #runAutoCompaction("threshold")
```

### Issues Found

1. **Idle compaction is disabled by default** - the timer never arms
2. **Threshold is too high** (~85% of context) - by the time it fires, we're already in the danger zone
3. **No mid-agentic-loop nudging** - unlike DCP, we don't encourage the model to compress during multi-step tool-use loops
4. **No iteration-count trigger** - we only check token counts, not turn counts since last compaction

---

## Reference: DCP Plugin (Opencode-DCP/opencode-dynamic-context-pruning)

DCP uses a fundamentally different approach: it exposes a **compress tool** to the model and uses **nudging** to encourage the model to use it proactively.

### Trigger Mechanisms

| Mechanism | Details |
|-----------|---------|
| `minContextLimit` | **50K tokens** - below this, no nudges fire |
| `maxContextLimit` | **100K tokens** - above this, strong compression nudges fire every `nudgeFrequency` turns |
| `nudgeFrequency` | Every **5th** fetch above maxContextLimit |
| `iterationNudgeThreshold` | After **15 messages** since last user message, iteration nudges fire |
| `deduplication` | Auto-runs on every compress - removes duplicate tool calls |
| `purgeErrors` | Auto-prunes errored tool inputs after **4 turns** |

### Key Insight

DCP's approach is **proactive** - it starts nudging the model to compress at **50% of context** (50K out of typical 100-200K windows), and nudges become aggressive at 100K. It also auto-prunes duplicate tool calls and stale error inputs continuously, not just at compaction time.

---

## Reference: anomalyco/opencode (native compaction)

Opencode's built-in compaction is closer to our architecture.

### Trigger Mechanisms

| Mechanism | Details |
|-----------|---------|
| Overflow detection | `totalTokens >= usable(model)` where `usable = inputLimit - reserved` (reserved defaults to 20K or maxOutputTokens, whichever is smaller) |
| Auto-compact flag | `compaction.auto` config (defaults to true) |
| `preserve_recent_tokens` | 2K-8K tokens (25% of usable, clamped) |
| Compaction buffer | `COMPACTION_BUFFER = 20_000` |

### Key Trigger Logic (in processor.ts)

```typescript
// After finish-step event:
if (!ctx.assistantMessage.summary && isOverflow({ cfg, tokens: usage.tokens, model })) {
  ctx.needsCompaction = true
}
```

The stream is then **immediately stopped** via `Stream.takeUntil(() => ctx.needsCompaction)` and the processor returns `"compact"`.

### Key Insight

Opencode triggers compaction **every single time** the token usage exceeds `usable` capacity. Their threshold is effectively:
```
inputLimit - min(20000, maxOutputTokens)
```
For a 200K context / 200K input model with 16K output: triggers at ~184K tokens.
For a 128K context with explicit inputLimit: triggers at `inputLimit - 20000`.

The difference: **they check after EVERY step** (every tool-call round-trip), not just after the full agent turn completes. They also interrupt the stream mid-step if overflow is detected, rather than waiting for the turn to finish.

---

## Gap Analysis

| Aspect | Our Implementation | DCP | OpenCode | Gap |
|--------|-------------------|-----|----------|-----|
| **When check runs** | After full agent turn | Every fetch (with nudge) | Every step (mid-stream interrupt) | We wait too long - should check per-step or more frequently |
| **Default threshold** | ~85% of context | 50K soft / 100K hard nudge | `inputLimit - 20K` (~90%) | Our threshold is reasonable but idle being off is a miss |
| **Idle compaction** | Disabled by default | N/A (model decides) | N/A | Should be enabled |
| **Iteration nudging** | None | After 15 messages since user | None | We could add turn-count heuristic |
| **Tool output pruning** | Only at compaction time | Continuous (dedup + purge) | Continuous (prune on every compact) | Should prune more frequently |
| **Error input purging** | Never | After 4 turns | N/A | Missing feature |
| **Mid-stream interrupt** | No | N/A (pre-send) | Yes (takeUntil) | Not blocking, but worth considering |

---

## Recommended Changes

### Phase 1: Enable idle compaction by default and lower thresholds

**Files to modify:**
- `packages/coding-agent/src/config/settings-schema.ts`

**Changes:**
1. Change `compaction.idleEnabled` default from `false` to `true`
2. Lower `compaction.idleThresholdTokens` default from `200000` to `100000`
3. Lower `compaction.idleTimeoutSeconds` default from `300` to `120` (2 minutes)

**Rationale:** Idle compaction is free (user isn't waiting) and both reference implementations agree that context should be managed proactively. A 100K idle threshold with 2-minute delay catches sessions that grew during a tool-use burst.

### Phase 2: Lower the auto-compaction threshold

**Files to modify:**
- `packages/coding-agent/src/session/compaction/compaction.ts`

**Changes:**
1. Change `effectiveReserveTokens` formula: instead of `max(15% of contextWindow, reserveTokens)`, use `max(25% of contextWindow, reserveTokens)` - this brings the default threshold from ~85% to ~75% of context.

**Rationale:** DCP starts nudging at 50K (often ~25-50% of context). OpenCode triggers at ~90% but checks every step. Since we only check once per full turn, we need to trigger earlier to compensate.

### Phase 3: Add iteration-count based compaction trigger

**Files to modify:**
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/compaction/compaction.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

**Changes:**
1. Add a new setting `compaction.iterationThreshold` (default: 20) - number of assistant turns since last compaction (or session start) after which threshold maintenance fires regardless of token count (provided context > 50% full).
2. In `#checkCompaction`, after the token-based threshold check, add a turn-count check: if the number of assistant messages since the last compaction entry exceeds `iterationThreshold` AND context usage is above 50%, trigger compaction.

**Rationale:** DCP's `iterationNudgeThreshold: 15` ensures compression happens after extended agentic loops even if individual messages are small. This prevents the scenario where many small tool calls accumulate context slowly without ever crossing the token threshold.

### Phase 4: Run tool-output pruning more frequently

**Files to modify:**
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/modes/controllers/event-controller.ts`

**Changes:**
1. Run `#pruneToolOutputs()` as part of idle compaction scheduling (before the threshold check in `#scheduleIdleCompaction`)
2. Run `#pruneToolOutputs()` on every N-th turn (e.g., every 5 turns) even if compaction doesn't trigger, to keep the context lean continuously rather than only at compaction decision time.

**Rationale:** Both DCP (deduplication runs on every compress) and our own docs note that pruning can drop context below the idle threshold. Running it more frequently keeps context leaner.

---

## Verification

1. **Unit tests**: Verify `shouldCompact()` fires at the new 75% threshold
2. **Integration test**: Verify idle compaction arms and fires with the new defaults
3. **Manual verification**: Run a long session and confirm compaction triggers earlier than before
4. Run `bun check:ts` to verify no type errors

## Key Files

| File | Purpose |
|------|---------|
| `packages/coding-agent/src/config/settings-schema.ts` | Default settings |
| `packages/coding-agent/src/session/compaction/compaction.ts` | `shouldCompact()`, `resolveThresholdTokens()`, `effectiveReserveTokens()` |
| `packages/coding-agent/src/session/agent-session.ts` | `#checkCompaction()`, `#runAutoCompaction()`, `runIdleCompaction()` |
| `packages/coding-agent/src/modes/controllers/event-controller.ts` | `#scheduleIdleCompaction()`, idle timer logic |
| `packages/coding-agent/src/session/compaction/pruning.ts` | `pruneToolOutputs` implementation |
| `docs/compaction.md` | Documentation (needs update) |
