# FLIGHT PLAN: Anthropic Prompt Cache — Role-Agnostic Message Breakpoints

## MISSION OVERVIEW

> **Mission Type**: Type-B Flight Operations
> **Classification**: Code change — single function refactor + tests
> **Flight Director**: Auto-authorized
> **T-Minus**: 2026-04-29

---

## EXECUTIVE SUMMARY

### Mission Objective
> **Primary Objective**: Replace user-only message filtering in `applyPromptCaching()` with role-agnostic "last N messages" approach, aligning with OpenCode's more aggressive caching strategy.
>
> **Success Criteria**:
> - `bun check` passes with zero errors
> - `bun test packages/ai/test/anthropic-alignment.test.ts` passes (existing + new tests)
> - Claude models through the Anthropic provider cache the last 2 messages regardless of role (user or assistant)

### Deliverables
- Modified `applyPromptCaching()` in `packages/ai/src/providers/anthropic.ts`
- New test cases in `packages/ai/test/anthropic-alignment.test.ts`

### Mission Profile
- **Estimated Duration**: Quick
- **Parallel Execution**: NO — sequential (single file change + tests)
- **Flight Phases**: Phase 1 → Phase 2 → Phase 3 → Phase 4

---

## PHASE 1: REQUIREMENTS DEFINITION

### Mission Requirements & Bi-Directional Traceability

1. **[REQ-001]**: Message-level cache breakpoints MUST target the last 2 messages regardless of role (user or assistant), iterating backward from the end of the messages array ➔ *Traces to:* `applyPromptCaching()` lines 1309-1355 replacement, Tests AC1-AC3
2. **[REQ-002]**: Tools (1 breakpoint) and system (1 breakpoint) cache placement MUST remain unchanged ➔ *Traces to:* No change to lines 1292-1307, Test AC6
3. **[REQ-003]**: MAX_CACHE_BREAKPOINTS MUST remain 4 with allocation: 1 tools + 1 system + 2 messages ➔ *Traces to:* Constant unchanged, Tests AC6-AC7
4. **[REQ-004]**: String content on user messages MUST still be coerced to array format with cache_control ➔ *Traces to:* Loop body string branch, Test AC-single-string
5. **[REQ-005]**: Assistant messages with only tool_use blocks (no text) MUST still receive a cache breakpoint on the last block via `applyCacheControlToLastBlock` fallback ➔ *Traces to:* `applyCacheControlToLastTextBlock` existing helper, Test AC4
6. **[REQ-006]**: Tool-result user messages MUST receive cache breakpoints on their content blocks ➔ *Traces to:* Role-agnostic loop, Test AC5
7. **[REQ-007]**: `applyPromptCaching` MUST be exported for direct unit testing ➔ *Traces to:* Export statement, test imports
8. **[REQ-008]**: Existing tests in `anthropic-alignment.test.ts` MUST continue to pass ➔ *Traces to:* `bun test` verification

### Requirements Traceability Matrix

| Req ID  | Description                                   | Design Component              | Implementation File                        | Test/Verification            | Status |
|---------|-----------------------------------------------|-------------------------------|--------------------------------------------|------------------------------|--------|
| REQ-001 | Role-agnostic last 2 messages                 | Backward loop in applyPromptCaching | `providers/anthropic.ts:1309-1355`    | AC1, AC2, AC3                | Open   |
| REQ-002 | Tools + system unchanged                      | No change                     | `providers/anthropic.ts:1292-1307`         | AC6                          | Open   |
| REQ-003 | MAX_CACHE_BREAKPOINTS = 4                     | Constant                      | `providers/anthropic.ts:1295`              | AC6, AC7                     | Open   |
| REQ-004 | String content coercion                       | String branch in loop         | `providers/anthropic.ts` loop body         | AC-single-string             | Open   |
| REQ-005 | tool_use-only assistant caching               | applyCacheControlToLastTextBlock fallback | Existing helper              | AC4                          | Open   |
| REQ-006 | Tool-result user caching                      | Role-agnostic loop            | `providers/anthropic.ts` loop body         | AC5                          | Open   |
| REQ-007 | Export applyPromptCaching                     | Export statement              | `providers/anthropic.ts`                   | Test imports                 | Open   |
| REQ-008 | Existing tests pass                           | No regression                 | N/A                                        | `bun test`                   | Open   |

### Constraints & Boundaries
- **MUST HAVE**: Role-agnostic backward iteration, string coercion, breakpoint budget enforcement
- **MUST NOT HAVE**: Changes to `applyCacheControlToLastTextBlock`, `applyCacheControlToLastBlock`, `enforceCacheControlLimit`, `normalizeCacheControlTtlOrdering`, `getCacheControl`, `buildParams()` call site, `maybeAddAnthropicCacheControl` in openai-completions.ts, MAX_CACHE_BREAKPOINTS constant value
- **ASSUMPTIONS**: `convertAnthropicMessages` never produces empty-content messages. Assistant messages always have array content. User messages can be string or array.

---

## PHASE 2: HAZARD ANALYSIS & ARCHITECTURE

### Hazard Analysis

| ID | Hazard Description | Severity | Probability | Mitigation Strategy | Abort Trigger | Recovery Path |
|----|-------------------|----------|-------------|---------------------|---------------|---------------|
| H1 | Caching tool-result messages wastes breakpoints on transient content | P3-Minor | Medium | `enforceCacheControlLimit` safety net; tool results near conversation tail are rare | N/A | Revert to user-only targeting |
| H2 | Empty array content messages cause breakpoint counting mismatch | P3-Minor | Low | `applyCacheControlToLastTextBlock` short-circuits on empty arrays; `enforceCacheControlLimit` corrects overcounting | N/A | Add explicit empty-array guard |
| H3 | Exporting `applyPromptCaching` exposes internal API | P3-Minor | Low | Function is pure (mutates params in place); no security concern. Mark with `@internal` JSDoc. | N/A | Test through `captureAnthropicPayload` instead |

### Abort & Adaptation Strategy

> **NOTE**: This is a small, well-scoped refactor. Abort only if the behavioral change causes test failures in unrelated areas.

**Adaptation Protocol**:
- **Test Failures**: Fix the implementation, do not abort
- **Type Errors**: Fix types, do not abort

**Deviation Thresholds**:
- [ ] ABORT if `enforceCacheControlLimit` behavior needs changes (out of scope)
- [ ] ABORT if `convertAnthropicMessages` output format assumptions are wrong

### Architecture Decisions
- **Role-agnostic backward loop**: Replaces `userIndexes` filtering. Simpler, more aggressive caching. Aligns with OpenCode.
- **"Last 2" not "Last 3"**: OpenCode uses 3 messages. oh-my-pi's breakpoint budget is 4 (1 tools + 1 system + 2 messages). With tools and system consuming 2, only 2 remain for messages. This is correct given the budget. OpenCode doesn't separately count tools/system in its budget.
- **Export for testing**: `applyPromptCaching` is a pure function. Exporting with `@internal` JSDoc is the cleanest testing approach vs. integration-testing through `captureAnthropicPayload`.

---

## PHASE 3: IMPLEMENTATION (Flight Operations)

### Mission Timeline

| Task | Description | Dependencies | Parallel | Duration |
|------|-------------|--------------|----------|----------|
| 3.1 | Replace message breakpoint logic in `applyPromptCaching()` | None | N | 5 min |
| 3.2 | Export `applyPromptCaching` for testing | 3.1 | N | 1 min |
| 3.3 | Add unit tests for message-level cache breakpoints | 3.1, 3.2 | N | 10 min |
| 3.4 | Run `bun check` + `bun test` | 3.1-3.3 | N | 2 min |

### Implementation Detail

- [ ] 1. Replace message breakpoint logic in `applyPromptCaching()`

  **File**: `packages/ai/src/providers/anthropic.ts`

  **What to do**:
  Replace lines 1309-1355 (the `userIndexes` filtering + penultimate/last user message logic) with a role-agnostic backward loop:

  ```typescript
  // Cache the last N messages regardless of role (user or assistant).
  // This aligns with OpenCode's aggressive caching: any message near the
  // conversation tail benefits from cache hits on subsequent turns.
  for (let i = params.messages.length - 1; i >= 0 && cacheBreakpointsUsed < MAX_CACHE_BREAKPOINTS; i--) {
      const msg = params.messages[i];
      if (typeof msg.content === "string") {
          const contentBlock: ContentBlockParam & CacheControlBlock = {
              type: "text",
              text: msg.content,
              cache_control: cacheControl,
          };
          msg.content = [contentBlock];
          cacheBreakpointsUsed++;
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          applyCacheControlToLastTextBlock(
              msg.content as Array<ContentBlockParam & CacheControlBlock>,
              cacheControl,
          );
          cacheBreakpointsUsed++;
      }
  }
  ```

  **DO NOT touch**:
  - Lines 1281-1307 (early return guard, tools breakpoint, system breakpoint)
  - `applyCacheControlToLastTextBlock`, `applyCacheControlToLastBlock`, or any enforcement helpers
  - `MAX_CACHE_BREAKPOINTS` constant (stays at 4)

  **Add a brief comment** above the new loop explaining: strategy changed from "penultimate + last user" to "last N messages, any role" to align with OpenCode's aggressive caching.

  **QA Scenarios**:
  - Verify lines 1281-1307 are untouched (tools + system logic)
  - Verify the backward loop iterates from end, respects `cacheBreakpointsUsed < MAX_CACHE_BREAKPOINTS`
  - Verify string-to-array coercion preserved in loop body
  - Verify `lsp_find_references` on `applyPromptCaching` confirms only one call site (`buildParams`)
  - `bun check` passes

- [ ] 2. Export `applyPromptCaching` for direct unit testing

  **File**: `packages/ai/src/providers/anthropic.ts`

  **What to do**:
  Change `function applyPromptCaching(` to `export function applyPromptCaching(`. Add `@internal` JSDoc:

  ```typescript
  /** @internal Exported for testing. Not part of the public API. */
  export function applyPromptCaching(
  ```

  Also export the `AnthropicCacheControl` type (needed for test params construction). It's currently a file-local type alias at approximately line 233. Change to `export type AnthropicCacheControl = ...`.

  **QA Scenarios**:
  - `bun check` passes (no circular dependency issues)
  - The function is importable from `@oh-my-pi/pi-ai/providers/anthropic` in test files
  - Verify no other barrel file (`index.ts`) re-exports this (it shouldn't — it's `@internal`)

- [ ] 3. Add unit tests for message-level cache breakpoints

  **File**: `packages/ai/test/anthropic-alignment.test.ts`

  **What to do**:
  Add a new `describe("applyPromptCaching — message breakpoints", ...)` block. Import `applyPromptCaching` and `AnthropicCacheControl` from the Anthropic provider. Construct `MessageCreateParamsStreaming` params objects directly (no mocks, no network calls).

  **Test cases** (each is a separate `test()` call):

  **AC1 — Last 2 of 5 messages cached (mixed roles)**:
  Params: messages = `[user("a"), assistant([text("b")]), user("c"), assistant([text("d")]), user("e")]`, no tools, no system.
  After `applyPromptCaching(params, { type: "ephemeral" })`:
  - messages[3] (assistant "d") has `cache_control` on its text block
  - messages[4] (user "e") has `cache_control` on its content (coerced from string to array)
  - messages[0], [1], [2] have NO `cache_control`

  **AC2 — 2 messages, both cached**:
  Params: messages = `[user("a"), assistant([text("b")])]`, no tools, no system.
  After: Both messages have `cache_control`.

  **AC3 — Single message cached**:
  Params: messages = `[user("hello")]`, no tools, no system.
  After: messages[0] has `cache_control`, only 1 breakpoint used.

  **AC4 — Assistant with only tool_use blocks**:
  Params: messages = `[user("a"), assistant([{type: "tool_use", id: "t1", name: "bash", input: {}}])]`, no tools, no system.
  After: messages[1] (assistant) has `cache_control` on the `tool_use` block (via `applyCacheControlToLastBlock` fallback). messages[0] (user) also has `cache_control`.

  **AC5 — Tool-result user message**:
  Params: messages = `[user("a"), assistant([text("b")]), user([{type: "tool_result", tool_use_id: "t1", content: "result"}])]`, no tools, no system.
  After: messages[2] (tool_result user) has `cache_control` on the tool_result block. messages[1] (assistant) has `cache_control` on its text block.

  **AC6 — Budget with tools + system (2 message breakpoints)**:
  Params: messages = `[user("a"), assistant([text("b")]), user("c"), assistant([text("d")])]`, tools = `[{name: "bash", ...}]`, system = `[{type: "text", text: "system prompt"}]`.
  After: tools[0] has `cache_control`, system[0] has `cache_control`, messages[2] and messages[3] have `cache_control`, messages[0] and [1] do NOT.

  **AC7 — No tools, no system (still only 2 message breakpoints)**:
  Params: messages = `[user("a"), assistant([text("b")]), user("c"), assistant([text("d")])]`, no tools, no system.
  After: Only messages[2] and [3] have `cache_control`. Total breakpoints = 2, not 4.

  **AC8 — Empty messages array**:
  Params: messages = `[]`, no tools, no system.
  After: No errors, no breakpoints placed.

  **AC9 — No cacheControl (undefined)**:
  Params: any messages.
  Call `applyPromptCaching(params, undefined)`.
  After: No `cache_control` on any messages (early return).

  **Use `Anthropic.Messages.MessageCreateParamsStreaming` type** for params construction. Structure messages using the Anthropic SDK types. Each test should verify exact indexes.

  **QA Scenarios**:
  - All 9 test cases pass: `bun test packages/ai/test/anthropic-alignment.test.ts`
  - Existing tests in the same file still pass
  - No mocks used — direct params construction and mutation inspection

- [ ] 4. Run final verification

  **What to do**:
  - `bun check` — must pass clean
  - `bun test packages/ai/test/anthropic-alignment.test.ts` — all tests pass
  - `bun lint` — must pass clean

  **QA Scenarios**:
  - Zero TypeScript errors
  - Zero lint errors
  - All existing + new tests green

---

## Final Verification Wave

- [ ] `bun check` passes
- [ ] `bun test packages/ai/test/anthropic-alignment.test.ts` passes
- [ ] Existing tests not broken
- [ ] New tests cover AC1-AC9

---

## Commit Strategy

Single commit: `fix(ai): align Anthropic prompt cache breakpoints with role-agnostic strategy`

---

## Success Criteria

- [ ] `applyPromptCaching` targets last 2 messages regardless of role
- [ ] Tools + system breakpoints unchanged
- [ ] String content coercion preserved for user messages
- [ ] All new tests pass
- [ ] All existing tests pass
- [ ] `bun check` clean
