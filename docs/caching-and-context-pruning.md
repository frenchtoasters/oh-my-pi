# Caching & Context Pruning Improvements

## Overview

The coding agent manages two interrelated concerns: **context pruning** (keeping conversation history within the model's context window) and **prompt caching** (maximizing Anthropic/OpenAI's server-side KV cache hit rate to reduce API cost — cache reads cost 0.1x uncached input). The work spans Jan-May 2026 and replaced a 4,580-line DCP state machine with ~200 lines of pure functions while improving cache hit rates from ~60-70% to ~85-92%.

---

## 1. Context Lifecycle

The main loop: user prompt enters the agent session, passes through `transformContext` (which applies prune state), hits the LLM, returns a response, checks triggers, and either loops back or enters compaction.

```
                 User Prompt
                      |
                      v
                Agent Session  <--------------------+
                      |                             |
                      v                             |
               transformContext                     |
                      |                             |
                      v                             |
               applyPruneState                      |
                      |                             |
                      v                             |
                 LLM Request                        |
                      |                             |
                      v                             |
              Assistant Response                    |
                      |                             |
                      v                             |
              Check Triggers -----(none)------------+
                      |
          +-----------+-----------+-----------+
          |           |           |           |
     threshold   iteration    idle 120s   overflow
        75%         15          >100K     /compact
          |           |           |           |
          +-----------+-----------+-----------+
                      |
                      v
             Compaction Pipeline
                      |
         +------------+------------+
         |            |            |
    Prune tool   Find cut    Summarize
     outputs      point       history
                      |
                      v
              Replace messages
                      |
                      v
           Recompute prune state
                      |
                      +---> back to Agent Session
```

**Triggers for compaction:**
- Token threshold: 75% of context window consumed
- Iteration count: 15 assistant turns (if >50% full)
- Idle timer: 120s inactivity at >100K tokens
- Overflow error recovery
- Manual `/compact` command

---

## 2. Three Pruning Strategies (May 6 — replaced DCP)

Located in `packages/coding-agent/src/session/compaction/strategies/`:

| Strategy | Condition | Action | Guards |
|----------|-----------|--------|--------|
| **Deduplication** | Same tool name + identical JSON args | Remove all but latest invocation | 4-turn protection, protected tools (task/write/edit), protected file globs |
| **Error Purge** | Tool result has `isError=true` | Replace call args with `{_pruned: true}` (keeps error message) | 2-turn delay, protected tools excluded |
| **Supersede Writes** | Write to file X followed by read of X | Replace write args with `{_pruned, path}` | Read result has current content; write body is redundant |

```
+-------------------+                              +----------------------------+
|  Deduplication    |----(same tool + args)------->| Remove all but latest      |
+--------+----------+                              +----------------------------+
         |
         |.... (guards) ....> 4-turn protection window
         |                    Protected tools list
         |
+-------------------+                              +----------------------------+
|  Error Purge      |----(isError=true)----------->| Replace args with _pruned  |
+--------+----------+                              +----------------------------+
         |
         |.... (guards) ....> 2-turn delay for errors
         |                    Protected tools list |
+-------------------+                              +----------------------------+
|  Supersede Writes |----(write then read same)--->| Replace write args _pruned |
+-------------------+                              +----------------------------+
```

---

## 3. Cache-Stable Prune State (May 7)

**Core insight:** Separating *compute* from *apply* so the message array sent to the LLM stays byte-identical between turns.

- `computePruneState()` runs only at `agent_start`, `turn_end`, and after compaction
- `applyPruneState(messages, state)` runs on every LLM call — deterministic, no recomputation
- Result: prefix bytes don't change mid-session, so Anthropic's KV cache stays valid

The `PruneState` object holds `dedupRemovedIds`, `errorPurgedIds`, `supersededIds`, and `frozenBeforeIndex`.

```
COMPUTE (runs rarely):
+----------------------------------+
|  computePruneState()             |
|  -> PruneState {                 |
|      dedupRemovedIds: Set        |
|      errorPurgedIds: Set         |
|      supersededIds: Set          |
|      frozenBeforeIndex: number   |
|    }                             |
+----------------------------------+
  Triggers:
    - agent_start (cache already cold)
    - turn_end (between LLM calls)
    - after compaction (messages replaced)

APPLY (runs on every LLM call):
+----------------------------------+
|  applyPruneState(messages, state)|
|  -> Same output for same input   |
|  -> No recomputation             |
|  -> Cache prefix stays STABLE    |
+----------------------------------+

Result: ~85% prompt cache hit rate
```

---

## 4. Anthropic Cache Breakpoint Strategy (Apr 29)

Four breakpoints placed:
1. System prompt (stable across session)
2. Tool definitions (stable unless MCP tools change)
3-4. Last N messages **regardless of role** (was: user-only; now role-agnostic backward loop)

This fixed poor hit rates in assistant-heavy tool-use tails.

```
+==========================================+
|  System Prompt          [breakpoint 1]   |  <- stable across session
+==========================================+
|  Tool Definitions       [breakpoint 2]   |  <- stable unless MCP change
+==========================================+
|                                          |
|  Frozen Messages                         |  <- NEVER modified by pruning
|  (below frozenBeforeIndex)               |
|                                          |
+------------------------------------------+
|  Active Messages                         |  <- pruning CAN modify these
|  (above frozenBeforeIndex)               |
+------------------------------------------+
|  Recent Messages        [breakpoint 3-4] |  <- latest N msgs (role-agnostic)
+==========================================+
```

---

## 5. Structured System Prompt Blocks (Apr 30)

Subagent prompts split into:
- **Stable block** — shared base prompt with `_cacheHint` tag + cache breakpoint
- **Dynamic block** — task-specific instructions

```
BEFORE: Monolithic prompt per subagent
+--------------------------------------+
|  [Entire prompt - unique per agent]  |  <- cache miss every time
+--------------------------------------+

AFTER: Stable + Dynamic blocks
+--------------------------------------+
|  STABLE block (shared base)          |
|  - Default agent prompt              |  <- cache HIT (shared across
|  - _cacheHint tag                    |     all subagents of same class)
|  - cache breakpoint placed here      |
+--------------------------------------+
|  DYNAMIC block (per-agent)           |
|  - Task-specific instructions        |  <- unique per agent
|  - Context / assignment              |
+--------------------------------------+
```

Effect: All subagents of the same class (e.g., all `task` agents) share one cached prefix via Anthropic's KV cache.

---

## 6. Compaction Trigger Alignment (May 8)

| Setting | Before | After |
|---------|--------|-------|
| `idleEnabled` | `false` | `true` |
| `idleThresholdTokens` | 200K | 100K |
| `idleTimeoutSeconds` | 300s | 120s |
| Reserve formula | `max(15% window, 16K)` | `max(25% window, 16K)` -> triggers at ~75% |
| `iterationThreshold` | none | 15 turns |

---

## 7. Cache Retention & Turn Protection (May 11)

| Setting | Before | After | Cost |
|---------|--------|-------|------|
| `cacheRetention` | `"short"` (5min TTL) | `"long"` (1hr TTL) | Zero (Anthropic charges same) |
| `turnProtectionTurns` | 2 | 4 | ~$0.01/session (keeps ~1-3K duplicates 2 extra turns) |

---

## 8. Output Size Control — Middle Elision (May 13)

Multi-layer pipeline in `streaming-output.ts`:

1. **Column cap** — 1024 chars/line (prevents minified-line bloat)
2. **Line cap** — 3000 lines
3. **Byte cap** — 50KB windowed tail buffer, UTF-8 safe
4. **Middle elision** — keep head + tail bytes, `[... X bytes elided ...]` in middle
5. **Spill decision** — >30KB goes to `artifact://ID`; tail kept in context with reference

```
Raw Tool Output
      |
      v
Column Cap (maxColumns: 1024 chars/line)
      |
      v
Line Cap (maxLines: 3000)
      |
      v
Byte Cap (maxBytes: 50KB windowed tail)
      |
      v
Middle Elision (headBytes + tailBytes)
      |
      v
Spill Decision (artifactSpillThreshold: 30KB)
      |
  +---+---+
  |       |
  v       v
Below   Above
30KB    30KB
  |       |
  v       v
Inline  Save full output to artifact://ID
in      Keep tail in context + reference
context
```

---

## 9. Token Input Reduction (cumulative)

| Change | Savings |
|--------|---------|
| `read.defaultLimit` 500 -> 300 | ~40% per read call |
| `artifactSpillThreshold` 50 -> 30KB | 5-7.5K tokens/spill |
| `purgeErrors.turnThreshold` 4 -> 2 | 10-50KB per error |
| Web search noise removal | 200-500 tokens/search |
| Per-line truncation (2000 chars) | Bounds minified files |
| URL fetch limit 300 -> 200 | ~33% per URL read |

---

## 10. OpenAI Remote Compaction (Jan 28)

For OpenAI/Codex models: uses the provider's native `/compact` endpoint rather than a separate LLM summarization call. Builds native history format, trims to fit, POSTs, and stores the compacted conversation.

```
1. Build native history format from AgentMessages
2. Trim input to fit context window (keep user msgs)
3. POST to model's /compact endpoint
4. Receive compacted conversation
5. Store as replacement history
6. Preserve data across compaction cycles

Benefits:
  - Provider-native summarization (better quality)
  - No extra LLM call needed
  - Maintains tool call ID consistency
```

---

## 11. Plan Mode Compact-and-Execute (May)

When a plan is approved, the planning transcript is compacted with planning-specific instructions, producing a fresh summary as the cache anchor. Execution starts with a clean window containing only the rationale.

---

## 12. Freeze-Prefix (`frozenBeforeIndex`)

All three compute functions (`computeDeduplicationIds`, `computeErrorPurgeIds`, `computeSupersededIds`) accept a `frozenBeforeIndex` parameter and skip tool call IDs belonging to messages below this threshold. This prevents pruning from modifying bytes deep in the cached prefix.

The threshold is advanced:
- At `agent_start` — set to current message count
- After compaction — set to new message count (history was rewritten)

```
Messages array:
[0]  [1]  [2]  [3]  [4]  [5]  [6]  [7]  [8]  [9]
=====================  ----------------------------
^ frozenBeforeIndex    ^ pruning operates here only
  (never modified)

After compaction:
[summary]  [recent0]  [recent1]  [recent2]
=============================================
^ frozenBeforeIndex advances to here
```

Implementation: `packages/coding-agent/src/session/compaction/strategies/prune-state.ts` and `agent-session.ts`.

---

## Evolution Timeline

```
Jan 28        Apr 29              Apr 30                May 6
OpenAI     -> Cache strategy   -> Structured prompt  -> DCP strip ->
remote        alignment           blocks                3 strategies
compaction

May 7             May 8                  May 11                    May 13
Cache-stable   -> Compaction trigger  -> Cache retention +      -> Middle
prune state       alignment              turn protection           elision
```

---

## Cumulative Impact

| Metric | Before | After |
|--------|--------|-------|
| Prompt cache hit rate | ~60-70% | ~85-92% |
| Compaction trigger point | ~85% of window | ~75% + idle + iteration |
| Per-tool-call context | unbounded | capped (lines/bytes/columns/middle-elision) |
| Subagent cache sharing | 0% | shared stable prefix |
| Pruning code complexity | 4,580 lines (DCP) | ~200 lines (3 pure functions) |
| Error persistence | 4 turns | 2 turns |

---

## Key Source Files

| File | Role |
|------|------|
| `packages/coding-agent/src/session/compaction/strategies/prune-state.ts` | PruneState type, compute/apply separation, frozenBeforeIndex |
| `packages/coding-agent/src/session/compaction/strategies/deduplication.ts` | Duplicate tool call removal |
| `packages/coding-agent/src/session/compaction/strategies/purge-errors.ts` | Error arg pruning |
| `packages/coding-agent/src/session/compaction/strategies/supersede-writes.ts` | Write supersession by subsequent read |
| `packages/coding-agent/src/session/compaction/compaction.ts` | Compaction pipeline orchestration |
| `packages/coding-agent/src/session/compaction/pruning.ts` | Pruning integration |
| `packages/coding-agent/src/session/streaming-output.ts` | OutputSink with caps and middle elision |
| `packages/coding-agent/src/session/compaction/branch-summarization.ts` | History summarization for compaction |
| `packages/coding-agent/src/modes/components/status-line/context-thresholds.ts` | UI threshold indicators |
| `packages/coding-agent/src/modes/utils/context-usage.ts` | Token usage calculation |
