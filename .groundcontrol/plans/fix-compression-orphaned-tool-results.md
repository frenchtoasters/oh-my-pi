# FLIGHT PLAN: Fix Orphaned toolResult Messages After Compaction

## MISSION OVERVIEW

> **Mission Type**: Type-B Flight Operations (Bug Fix)
> **Classification**: Official — Fixes Bedrock API rejection (HTTP 400)
> **Flight Director**: Auto-authorized (scoped bug fix, defense-in-depth)
> **T-Minus**: Ready for immediate execution

---

## EXECUTIVE SUMMARY

### Mission Objective
> **Primary Objective**: Fix the defect where compaction removes an assistant message containing `tool_use` blocks but preserves the subsequent `tool_result` messages, causing Bedrock (and potentially other providers) to reject API calls with: `"The number of toolResult blocks at messages.N.content exceeds the number of toolUse blocks of previous turn."` The fix applies defense-in-depth at two layers: (1) `transformMessages()` in the AI package as a universal send-time safety net for all 9 providers, and (2) `repairOrphanedToolUseBlocks()` in the session-manager as a load-time repair.
>
> **Success Criteria**:
> - `bun test packages/ai/test/duplicate-tool-results.test.ts` passes (no regressions)
> - `bun test packages/ai/test/orphaned-tool-results.test.ts` passes (new tests)
> - `bun check` passes (type-checking)
> - The real-world Bedrock 400 scenario (tool_results after user message, no preceding assistant with tool_use) is handled

### Deliverables
- Modified `packages/ai/src/providers/transform-messages.ts` — drop orphaned tool_results in second pass
- Modified `packages/coding-agent/src/session/session-manager.ts` — reverse orphan scan in `repairOrphanedToolUseBlocks()`
- New test file `packages/ai/test/orphaned-tool-results.test.ts` — 8 test cases

### Mission Profile
- **Estimated Duration**: Short (10-15 lines of logic, ~150-200 lines of tests)
- **Parallel Execution**: YES — 2 waves (Wave 1: tests + transform fix in parallel, Wave 2: session-manager fix)
- **Flight Phases**: Phase 1 → Phase 2 → Phase 3 → Phase 4

---

## PHASE 1: REQUIREMENTS DEFINITION

> **Objective**: Establish mission parameters, success criteria, and constraints.

### Mission Requirements & Bi-Directional Traceability

1. **[REQ-001]**: `transformMessages()` MUST silently drop any `toolResult` message whose `toolCallId` does not match any `toolCall.id` from any preceding assistant message in the conversation. ➔ *Traces to:* Task 3.1, Tests 1-6
2. **[REQ-002]**: `transformMessages()` MUST maintain a cumulative `knownToolCallIds: Set<string>` across ALL assistant messages (not just the most recent), populated from every assistant message's `toolCalls` array. ➔ *Traces to:* Task 3.1
3. **[REQ-003]**: The orphan check in `transformMessages()` MUST occur AFTER the `pendingAbortedToolCalls` check (line 206) so aborted-but-real results are still kept. ➔ *Traces to:* Task 3.1, Test 8
4. **[REQ-004]**: `repairOrphanedToolUseBlocks()` MUST add a reverse scan that removes `toolResult` messages whose `toolCallId` does not match any `toolCall.id` from any preceding assistant message. ➔ *Traces to:* Task 3.3
5. **[REQ-005]**: The reverse scan in `repairOrphanedToolUseBlocks()` MUST NOT have the contiguity limitation of the forward scan — it must check ALL tool_result messages, not just those immediately following an assistant. ➔ *Traces to:* Task 3.3
6. **[REQ-006]**: Existing behavior of `flushPendingToolCalls()`, `flushPendingAbortedToolCalls()`, and the first pass of `transformMessages()` MUST be preserved identically. ➔ *Traces to:* Tests 7-8 (regression guards)
7. **[REQ-007]**: No changes to message types, `ToolCallStatus` enum, compaction code, or provider-specific code. ➔ *Traces to:* Code review constraint

### Requirements Traceability Matrix

| Req ID | Requirement Description | Design Component | Implementation | Test/Verification | Status |
|--------|------------------------|------------------|----------------|-------------------|--------|
| REQ-001 | Drop orphaned toolResults in transformMessages | transform-messages.ts second pass | knownToolCallIds gate | Tests 1-6 | Open |
| REQ-002 | Cumulative knownToolCallIds set | transform-messages.ts second pass | Set populated from all assistants | Tests 1-6 | Open |
| REQ-003 | Check order: aborted first, then orphan | transform-messages.ts line ~205 | Conditional ordering | Test 8 | Open |
| REQ-004 | Reverse orphan scan in repair function | session-manager.ts repairOrphanedToolUseBlocks | Full-array scan + splice | Task 3.3 | Open |
| REQ-005 | No contiguity limitation on reverse scan | session-manager.ts repairOrphanedToolUseBlocks | Scan all messages, not just contiguous | Task 3.3 | Open |
| REQ-006 | Preserve existing flush behavior | transform-messages.ts | No modification to flush functions | Tests 7-8 | Open |
| REQ-007 | No changes to types/compaction/providers | All files | Code review constraint | bun check | Open |

### Constraints & Boundaries
- **MUST HAVE**: Defense-in-depth at both transform-messages.ts and session-manager.ts
- **MUST NOT HAVE**: Changes to compaction code, provider-specific code, message types, ToolCallStatus enum
- **MUST NOT HAVE**: Logging additions to transform-messages.ts (pure function, no logger import)
- **MUST NOT HAVE**: New model fixtures per test (reuse single fixture like duplicate-tool-results.test.ts)
- **ASSUMPTIONS**: The `toolCallIdMap` normalization in pass 1 handles ID remapping before pass 2 sees the messages

### Success Criteria (Phase Gate)
- [ ] Requirements documented and approved
- [ ] Traceability matrix populated
- [ ] Scope boundaries established
- [ ] Success metrics defined

---

## PHASE 2: HAZARD ANALYSIS & ARCHITECTURE

> **Objective**: Identify hazards, establish abort criteria, define approach.

### Hazard Analysis & Software Risk Management

| ID | Hazard Description | Severity | Probability | Mitigation Strategy | Abort Trigger | Recovery Path |
|----|-------------------|----------|-------------|---------------------|---------------|---------------|
| H1 | Dropping valid toolResults that should be kept | P1-Critical | Low | knownToolCallIds is cumulative; aborted check runs first | Valid results dropped in tests | Revert commit |
| H2 | Regression in existing orphaned-tool_use handling | P2-Major | Low | No changes to flush functions; existing tests must pass | duplicate-tool-results.test.ts fails | Revert commit |
| H3 | pendingToolCalls replacement causes missed tracking | P2-Major | Medium | Use SEPARATE cumulative set, don't modify pendingToolCalls | Test case 2 (between two assistants) fails | Fix cumulative set logic |
| H4 | repairOrphanedToolUseBlocks splice corruption | P2-Major | Low | Iterate backwards when splicing to avoid index shift | Session reload produces invalid messages | Revert session-manager changes |

### Abort & Adaptation Strategy
> **NOTE: MISSION RESILIENCE** — Do not abort on the first failure. Fix and adapt.

**Adaptation Protocol**:
- **Test Failures**: Re-evaluate the implementation, fix the code, do not abort. Document the non-conformance.
- **Type Errors**: Fix types without modifying existing interfaces. `bun check` is the gate.

**Deviation Thresholds**:
- [ ] ABORT if the core approach (cumulative ID tracking) is fundamentally flawed
- [ ] ABORT if modifying transformMessages second pass requires changing flushPendingToolCalls
- [ ] ABORT if H1 manifests (valid results being dropped)

**Recovery Protocol**:
- Rollback: `git checkout -- packages/ai/src/providers/transform-messages.ts packages/coding-agent/src/session/session-manager.ts`
- Delete test file: `rm packages/ai/test/orphaned-tool-results.test.ts`

### Architecture Decisions
- **Two-layer defense**: transform-messages.ts (universal, all providers) + session-manager.ts (session-load-time). Both layers catch orphans independently.
- **Cumulative set vs modifying pendingToolCalls**: Separate `knownToolCallIds` set avoids any risk of disrupting the existing flush logic. `pendingToolCalls` continues to work exactly as before.
- **Drop silently vs inject synthetic**: Drop is correct here — there's no assistant to pair with. Injecting a synthetic assistant would be fragile and unnecessary.

### Phase Gate Checkpoint
- [ ] All hazards identified and assessed
- [ ] Abort criteria established
- [ ] Recovery procedure verified
- [ ] **GO/NO-GO**: PROCEED

---

## PHASE 3: IMPLEMENTATION (Flight Operations)

> **Objective**: Execute mission operations following established parameters.

### Mission Timeline

| Task | Description | Dependencies | Files | Parallel | Duration |
|------|-------------|--------------|-------|----------|----------|
| 3.1 | Add knownToolCallIds gate in transformMessages() | None | transform-messages.ts | Wave 1 | 5 min |
| 3.2 | Write orphaned-tool-results test file | None | orphaned-tool-results.test.ts | Wave 1 | 15 min |
| 3.3 | Add reverse orphan scan in repairOrphanedToolUseBlocks | 3.1 (pattern reference) | session-manager.ts | Wave 2 | 5 min |
| 3.4 | Run all tests and type-check | 3.1, 3.2, 3.3 | N/A | Wave 3 | 2 min |

### Implementation Detail

> **PARALLEL EXECUTION**: Tasks 3.1 and 3.2 execute in Wave 1 (parallel via git worktrees). Task 3.3 in Wave 2 (references 3.1 pattern). Task 3.4 in Wave 3 (verification).

---

## TODOs

- [ ] 1. Add `knownToolCallIds` gate in `transformMessages()` second pass

  **File**: `packages/ai/src/providers/transform-messages.ts`

  **What to do**:
  1. At the start of the second pass (around line 130, near the existing variable declarations), add: `const knownToolCallIds = new Set<string>()`
  2. In the assistant message handling branch (around line 196-201 where `pendingToolCalls` is set), add: for each `toolCall` in the assistant's `toolCalls` array, call `knownToolCallIds.add(toolCall.id)`
  3. Also in the aborted-assistant branch (where `pendingAbortedToolCalls` is populated), add the same `knownToolCallIds.add()` for each tool call
  4. In the toolResult handling branch (around line 205-215), AFTER the existing `pendingAbortedToolCalls` check (line 206-211) and AFTER the `toolCallStatus` Aborted check (line 212-213), add a NEW check BEFORE pushing: if `!knownToolCallIds.has(msg.toolCallId)`, skip this toolResult (continue to next message — do not push it)
  5. The check order must be: (a) pendingAbortedToolCalls check, (b) already-Aborted skip, (c) NEW orphan check, (d) mark Resolved + push

  **Constraints**:
  - MUST NOT modify pass 1 (lines 31-124)
  - MUST NOT modify `flushPendingToolCalls()` or `flushPendingAbortedToolCalls()`
  - MUST NOT add imports or logging
  - MUST NOT modify `ToolCallStatus` enum
  - `knownToolCallIds` is a SEPARATE set from `pendingToolCalls` — do not merge them

  **QA Scenarios**:
  - `bun check` passes (type-checking)
  - `bun test packages/ai/test/duplicate-tool-results.test.ts` passes (no regressions)
  - After Task 3.2 is complete: `bun test packages/ai/test/orphaned-tool-results.test.ts` passes

- [ ] 2. Write `orphaned-tool-results.test.ts` test file

  **File**: `packages/ai/test/orphaned-tool-results.test.ts`

  **What to do**:
  Create a new test file modeled on `packages/ai/test/duplicate-tool-results.test.ts` structure:
  - Import `transformMessages` from `../src/providers/transform-messages.ts`
  - Import `Model` type, create a single model fixture (reuse the pattern from duplicate-tool-results.test.ts — `{ id: "test", ...defaults }`)
  - Use `describe("orphaned tool results", () => { ... })` wrapper

  **Test Cases** (8 total):

  **Test 1: "drops toolResult after user message (no preceding assistant)"**
  - Input: `[{ role: "user", content: [...] }, { role: "toolResult", toolCallId: "orphan-1", content: "result" }]`
  - Assert: output has only the user message, toolResult is dropped
  - Verifies: REQ-001 — orphan at basic level

  **Test 2: "drops toolResult after assistant with no tool calls"**
  - Input: `[{ role: "assistant", content: [{ type: "text", text: "hello" }] }, { role: "toolResult", toolCallId: "orphan-1", content: "result" }]`
  - Assert: output has assistant + no toolResult
  - Verifies: REQ-001 — assistant exists but has no toolCalls

  **Test 3: "drops toolResult with non-matching tool call ID"**
  - Input: `[{ role: "assistant", content: [...], toolCalls: [{ id: "real-1", ... }] }, { role: "toolResult", toolCallId: "orphan-1", content: "result" }]`
  - Assert: the orphaned toolResult is dropped, synthetic result for "real-1" is injected (by existing flush logic)
  - Verifies: REQ-001 — ID mismatch

  **Test 4: "keeps valid toolResults and drops orphans in mixed sequence"**
  - Input: `[{ role: "assistant", toolCalls: [{ id: "real-1" }] }, { role: "toolResult", toolCallId: "real-1", content: "valid" }, { role: "toolResult", toolCallId: "orphan-1", content: "orphan" }]`
  - Assert: "real-1" result kept, "orphan-1" result dropped
  - Verifies: REQ-001 — mixed valid + orphan

  **Test 5: "drops toolResult at start of message array"**
  - Input: `[{ role: "toolResult", toolCallId: "orphan-1", content: "result" }, { role: "user", content: [...] }]`
  - Assert: toolResult dropped, user message kept
  - Verifies: REQ-001 — edge case, tool_result before any message

  **Test 6: "drops multiple consecutive orphaned toolResults"**
  - Input: `[{ role: "user", content: [...] }, { role: "toolResult", toolCallId: "orphan-1", ... }, { role: "toolResult", toolCallId: "orphan-2", ... }, { role: "toolResult", toolCallId: "orphan-3", ... }]`
  - Assert: all three toolResults dropped, only user message remains
  - Verifies: REQ-001 — multiple orphans (mirrors the real Bedrock error with 5 orphaned tool results)

  **Test 7: "keeps valid toolResult after developer message (regression guard)"**
  - Input: `[{ role: "assistant", toolCalls: [{ id: "real-1" }] }, { role: "developer", content: [...] }, { role: "toolResult", toolCallId: "real-1", content: "valid" }]`
  - Assert: toolResult for "real-1" is kept (not dropped despite interleaved developer message)
  - Verifies: REQ-006 — regression guard, interleaved developer messages

  **Test 8: "keeps toolResult for aborted assistant (regression guard)"**
  - Input: `[{ role: "assistant", toolCalls: [{ id: "aborted-1" }], aborted: true }, { role: "toolResult", toolCallId: "aborted-1", content: "result" }]`
  - Assert: toolResult is kept (handled by pendingAbortedToolCalls path)
  - Verifies: REQ-003, REQ-006 — aborted assistant regression guard

  **Constraints**:
  - Follow test patterns from `packages/ai/test/duplicate-tool-results.test.ts` exactly
  - Single model fixture, reused across tests
  - No real API calls — pure unit tests calling `transformMessages()` directly
  - Use the exact message type shapes from the existing test file

  **QA Scenarios**:
  - All 8 tests pass: `bun test packages/ai/test/orphaned-tool-results.test.ts`
  - No regressions: `bun test packages/ai/test/duplicate-tool-results.test.ts`
  - Tests fail BEFORE Task 3.1 fix is applied (red-green verification)

- [ ] 3. Add reverse orphan scan in `repairOrphanedToolUseBlocks()`

  **File**: `packages/coding-agent/src/session/session-manager.ts`

  **What to do**:
  1. After the existing forward scan loop (which injects synthetic results for orphaned tool_use), add a NEW reverse scan section
  2. Build a `knownToolCallIds: Set<string>` by iterating all messages and collecting `toolCall.id` from every assistant message's content blocks (where `block.type === "toolCall"`)
  3. Iterate the messages array BACKWARDS (to safely splice). For each `toolResult` message, check if `msg.content[0].toolCallId` (or however the toolCallId is stored on the AgentMessage type) is in `knownToolCallIds`
  4. If NOT in `knownToolCallIds`, splice it out: `messages.splice(i, 1)`
  5. Iterating backwards avoids index-shift issues from splice

  **Constraints**:
  - MUST NOT modify the existing forward scan logic
  - MUST iterate backwards when splicing
  - MUST check the correct property path for toolCallId on the AgentMessage type (examine the type definition)
  - This scan must check ALL toolResult messages, not just contiguous ones (no `break` on non-toolResult)

  **QA Scenarios**:
  - `bun check` passes
  - `bun test packages/coding-agent/test/session-manager/` passes (no regressions)
  - Orphaned toolResults from compaction are removed at session-load time

- [ ] 4. Run full verification suite

  **What to do**:
  1. Run `bun test packages/ai/test/orphaned-tool-results.test.ts` — all 8 tests pass
  2. Run `bun test packages/ai/test/duplicate-tool-results.test.ts` — no regressions
  3. Run `bun check` — type-checking passes
  4. Run `bun test packages/coding-agent/test/session-manager/` — no regressions

  **QA Scenarios**:
  - All commands exit 0
  - Zero test failures across all suites
  - Zero type errors

---

## PHASE 4: VERIFICATION & VALIDATION (V&V)

> **Objective**: Comprehensive verification that mission objectives were achieved safely.

### Verification Matrix

| Verification Type | Method | Acceptance Criteria | Status |
|-------------------|--------|---------------------|--------|
| Functional (AI layer) | `bun test packages/ai/test/orphaned-tool-results.test.ts` | All 8 tests pass | Pending |
| Regression (AI layer) | `bun test packages/ai/test/duplicate-tool-results.test.ts` | All existing tests pass | Pending |
| Functional (Session layer) | `bun test packages/coding-agent/test/session-manager/` | All tests pass | Pending |
| Type Safety | `bun check` | Zero errors | Pending |

### V&V Protocols

#### Protocol 4.1: Functional Verification
```
Test: Orphaned tool_result handling in transformMessages()
Command: bun test packages/ai/test/orphaned-tool-results.test.ts
Expected: 8 tests pass, 0 failures
```

#### Protocol 4.2: Regression Verification
```
Test: Existing tool-call-without-result handling
Command: bun test packages/ai/test/duplicate-tool-results.test.ts
Expected: All existing tests pass unchanged
```

#### Protocol 4.3: Type Safety Verification
```
Test: Full type-checking
Command: bun check
Expected: Zero type errors
```

#### Protocol 4.4: Safety Verification
```
Check: H1 (valid results not dropped)
Verification: Tests 4, 7, 8 specifically verify valid results are preserved
Threshold: All three tests pass

Check: H2 (no regression in orphaned-tool_use handling)
Verification: duplicate-tool-results.test.ts passes unchanged
Threshold: Zero test failures
```

### Final Mission Certification

| Assessment | Rating | Notes |
|------------|--------|-------|
| Mission Objectives | Pending | All 4 tasks complete |
| Hazard Prevention | Pending | H1-H4 verified via tests |
| State Integrity | Pending | No type changes, no compaction changes |
| Performance | Pending | Negligible overhead (one Set lookup per toolResult) |

### Mission Outcome
- [ ] **MISSION SUCCESS**: All tests pass, all types check, orphaned toolResults handled at both layers

---

## FLIGHT LOG

| Event | Timestamp | Action | Result |
|-------|-----------|--------|--------|
| Planning | T-0 | Plan generated | GO |

---

## APPENDICES

### Rollback
```bash
git checkout -- packages/ai/src/providers/transform-messages.ts packages/coding-agent/src/session/session-manager.ts
rm packages/ai/test/orphaned-tool-results.test.ts
```

### References
- Error log: `/Users/tfrench/.omp/logs/http-400-requests/1777668864952-6ox9r0lwmldj.json`
- Root cause: compaction removes assistant with tool_use, leaves tool_result messages orphaned
- Bedrock validation: toolResult count must not exceed toolUse count in preceding assistant turn
- Fix locations: `packages/ai/src/providers/transform-messages.ts` (line ~130-215), `packages/coding-agent/src/session/session-manager.ts` (line ~728-790)

### Commit Strategy
Single commit: `fix: drop orphaned toolResult messages after compaction removes their assistant`
- Include all 3 files (transform-messages.ts, session-manager.ts, orphaned-tool-results.test.ts)
- Reference the error: "Bedrock rejects with 400 when toolResult count exceeds toolUse count"
