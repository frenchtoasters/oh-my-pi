# FLIGHT PLAN: Subagent Prompt Cache Optimization

## MISSION OVERVIEW

> **Mission Type**: Type-B (Flight Operations)
> **Classification**: Performance Optimization
> **T-Minus**: 2026-04-29

---

## EXECUTIVE SUMMARY

### Mission Objective
> **Primary Objective**: Enable Anthropic server-side KV cache reuse across parallel subagent sessions by splitting the monolithic system prompt into a stable prefix block (with cache breakpoint) and a dynamic suffix block, so that identical-class subagents (e.g., 3 reviewer instances) share the cached prefix instead of each paying full input token cost.
>
> **Success Criteria**:
> - 2nd and 3rd reviewer subagents show `cache_read_input_tokens > 0` for the stable prefix
> - Effective per-token rate drops from ~$0.29/MTok toward ~$0.07/MTok for parallel subagent workloads
> - `bun check` passes with zero type errors
> - All 12+ providers in `packages/ai/src/providers/` compile without modification

### Deliverables
- Extended `Context` type in `packages/ai/src/types.ts` supporting structured system prompts
- Updated `buildAnthropicSystemBlocks` in `packages/ai/src/providers/anthropic.ts` to honor structured blocks with cache hints
- Updated `applyPromptCaching` to place cache breakpoints on stable-marked blocks
- Updated subagent system prompt construction in `packages/coding-agent/src/task/executor.ts` to emit structured prompts
- Updated agent loop in `packages/agent/src/agent-loop.ts` to propagate structured prompts
- Tests verifying cache-aligned block generation and backward compatibility

### Mission Profile
- **Estimated Duration**: Medium (2-3 focused sessions)
- **Parallel Execution**: YES - 2 waves
- **Flight Phases**: Phase 1 (Requirements) -> Phase 2 (Hazard/Architecture) -> Phase 3 (Implementation) -> Phase 4 (V&V)

---

## PHASE 1: REQUIREMENTS DEFINITION

### Mission Requirements & Bi-Directional Traceability

1. **[REQ-001]**: System prompt sent to Anthropic API MUST be splittable into multiple system blocks with independent cache control hints. -> *Traces to:* Task 3.1, Test T-001
2. **[REQ-002]**: For parallel subagents of the same class (same agent definition, same tools), the stable prefix block MUST be byte-identical across instances. -> *Traces to:* Task 3.3, Test T-002
3. **[REQ-003]**: Cache breakpoint MUST be placed on the stable prefix block (not the dynamic suffix) so Anthropic's KV cache can reuse it across sessions. -> *Traces to:* Task 3.2, Test T-003
4. **[REQ-004]**: Non-Anthropic providers MUST receive the full system prompt as a single string, unchanged from current behavior. -> *Traces to:* Task 3.1, Test T-004
5. **[REQ-005]**: `AgentState.systemPrompt` MUST remain `string` type. Structured prompts are introduced only at the `Context` level in `packages/ai`. -> *Traces to:* Task 3.1, Task 3.4
6. **[REQ-006]**: Parent (non-subagent) sessions MUST NOT have their caching behavior degraded. -> *Traces to:* Test T-005
7. **[REQ-007]**: The 4-breakpoint budget (`MAX_CACHE_BREAKPOINTS`) MUST NOT change. -> *Traces to:* Task 3.2
8. **[REQ-008]**: Existing Handlebars template (`subagent-system-prompt.md`) MUST NOT be modified. -> *Traces to:* Task 3.3

### Requirements Traceability Matrix

| Req ID | Requirement Description | Design Component | Implementation | Test/Verification | Status |
|--------|------------------------|------------------|----------------|-------------------|--------|
| REQ-001 | Structured system prompt blocks with cache hints | `Context` type extension | `packages/ai/src/types.ts` | T-001: Structured blocks test | Open |
| REQ-002 | Byte-identical stable prefix across same-class subagents | Subagent prompt construction | `packages/coding-agent/src/task/executor.ts` | T-002: Prefix identity test | Open |
| REQ-003 | Cache breakpoint on stable block | `applyPromptCaching` update | `packages/ai/src/providers/anthropic.ts` | T-003: Breakpoint placement test | Open |
| REQ-004 | Non-Anthropic backward compat | `Context.systemPrompt` union type with string fallback | All non-Anthropic providers (no changes) | T-004: Type compilation test | Open |
| REQ-005 | `AgentState.systemPrompt` stays `string` | Agent runtime unchanged | `packages/agent/` (no changes) | T-005: `bun check` passes | Open |
| REQ-006 | Parent session unaffected | Structured prompts only for subagents | `packages/coding-agent/src/task/executor.ts` | T-005: Parent cache metrics | Open |
| REQ-007 | 4-breakpoint budget preserved | Cache strategy reallocation | `packages/ai/src/providers/anthropic.ts` | T-003: Breakpoint count test | Open |
| REQ-008 | Handlebars template unchanged | Code-level split, not template | `subagent-system-prompt.md` not modified | Diff verification | Open |

### Constraints & Boundaries
- **MUST HAVE**: Cache reuse for parallel same-class subagents; backward compat for all providers
- **MUST NOT HAVE**: Changes to `AgentState` type; changes to non-Anthropic providers; changes to Handlebars template; changes to agent definition tool lists
- **ASSUMPTIONS**: Reviewer subagents' tool blocks are already byte-identical (validated: `todo_write` filter is a no-op for reviewers). The `{{base}}` portion of the system prompt is identical across same-class subagents.

---

## PHASE 2: HAZARD ANALYSIS & ARCHITECTURE

### Hazard Analysis & Software Risk Management

| ID | Hazard Description | Severity | Probability | Mitigation Strategy | Abort Trigger | Recovery Path |
|----|-------------------|----------|-------------|---------------------|---------------|---------------|
| H1 | Type change to `Context.systemPrompt` breaks non-Anthropic providers | P1-Critical | Low | Union type `string \| StructuredSystemPrompt` with helper `flattenSystemPrompt()` that all non-Anthropic providers can use; `bun check` gates | Any non-Anthropic provider fails type check | Revert `Context` type change |
| H2 | Cache breakpoint reallocation steals message-level breakpoints | P2-Major | Medium | Only consume the stable-block breakpoint when structured prompt is present; plain string path unchanged | Parent session cache hit rate degrades >10% | Revert `applyPromptCaching` changes |
| H3 | Billing header hash diverges across subagents due to different system prompt content | P3-Minor | High (expected) | Billing header is NOT a cache breakpoint target; it's the first block but cache_control goes on the stable block. No mitigation needed. | N/A | N/A |
| H4 | `syncContextBeforeModelCall` overwrites structured prompt with plain string | P2-Major | Medium | `syncContextBeforeModelCall` in agent.ts reads `this.#state.systemPrompt` (string). The structured prompt must be set on the `Context` object AFTER sync, at the provider call site. | Structured prompt silently lost, no cache benefit | Verify structured prompt propagation in agent-loop.ts |
| H5 | `rebuildSystemPrompt` called mid-session flattens structured prompt back to string | P2-Major | Low | Structured split happens in executor.ts at session creation, not in rebuildSystemPrompt. Mid-session rebuilds produce monolithic string, which is fine — subagent sessions are short-lived and don't change tools mid-conversation. | N/A | Acceptable behavior |

### Abort & Adaptation Strategy

**Adaptation Protocol** (normal failures):
- **Type errors**: Fix the type, do not revert the design. Use `flattenSystemPrompt()` helper.
- **Cache metrics don't improve**: Instrument and diagnose. May indicate tool block divergence (not system prompt). Validate tool blocks first.
- **Test failures**: Fix implementation to match contract.

**Deviation Thresholds** (stop and re-plan):
- [ ] ABORT if `Context.systemPrompt` type change causes >3 provider files to need modification
- [ ] ABORT if agent-loop propagation requires changing `AgentState` type
- [ ] ABORT if tool blocks prove non-identical across same-class subagents (invalidates entire premise)

**Recovery Protocol**:
- Rollback: `git revert` the change set
- Estimated recovery time: Immediate (no data changes, no infra changes)

### Architecture Decisions

**Decision 1: Structured prompts at `Context` level only, not `AgentState`**
- *Rationale*: `AgentState.systemPrompt` is consumed by agent.ts, agent-loop.ts, agent-session.ts, sdk.ts, and session serialization. Changing it cascades everywhere. `Context` is consumed only by providers — much smaller blast radius.
- *Alternative rejected*: Full `AgentState` type change — too invasive, touches serialization and state sync.

**Decision 2: Split point in executor.ts, not in the Handlebars template**
- *Rationale*: The template renders `{{base}}` + `{{agent}}` into a single string. Instead of splitting the template into two files (which would break the `{{SECTION_SEPARATOR}}` macro and other template features), we render the full template, then also separately capture the `{{base}}` content as the stable prefix. The structured prompt carries both the stable prefix and the full rendered string (for non-Anthropic fallback).
- *Alternative rejected*: Two separate templates — fragile, duplicates template logic.

**Decision 3: Cache breakpoint on stable block via explicit marking, not position-based**
- *Rationale*: Current `applyPromptCaching` uses positional logic ("last system block"). With structured prompts, the stable block should get the breakpoint regardless of position. Adding a `cacheHint: 'stable'` marker to blocks lets the caching logic target it explicitly.
- *Alternative rejected*: Assume stable block is always at a fixed position — fragile if block ordering changes.

---

## PHASE 3: IMPLEMENTATION (Flight Operations)

### Mission Timeline

| Task | Description | Dependencies | Parallel | Files |
|------|-------------|--------------|----------|-------|
| 3.1 | Extend `Context` type with structured system prompt | None | Wave 1 | `packages/ai/src/types.ts` |
| 3.2 | Update `buildAnthropicSystemBlocks` + `applyPromptCaching` | 3.1 | Wave 2 | `packages/ai/src/providers/anthropic.ts` |
| 3.3 | Update subagent prompt construction to emit structured prompt | 3.1 | Wave 2 | `packages/coding-agent/src/task/executor.ts`, `packages/agent/src/agent-loop.ts` |
| 3.4 | Add tests for structured prompt handling and cache alignment | 3.2, 3.3 | Wave 3 | `packages/ai/src/providers/__tests__/` |
| 3.5 | Verify full build and type check | 3.2, 3.3 | Wave 3 | N/A (validation) |

> **PARALLEL EXECUTION PROTOCOL**: Tasks 3.2 and 3.3 can run in parallel using `git worktrees` since they modify different packages. Task 3.1 must complete first as both depend on the new types.

### Implementation Detail

#### Task 3.1: Extend `Context` Type with Structured System Prompt

**Objective**: Define a `StructuredSystemPrompt` type and update `Context.systemPrompt` to accept it alongside plain strings. Provide a `flattenSystemPrompt()` helper for backward compat.

**Files Modified**:
- `packages/ai/src/types.ts`

**Approach**:
1. Add new types in `packages/ai/src/types.ts`:
   ```typescript
   export interface SystemPromptBlock {
     text: string;
     cacheHint?: 'stable' | 'dynamic';
   }
   
   export interface StructuredSystemPrompt {
     blocks: SystemPromptBlock[];
   }
   
   export type SystemPrompt = string | StructuredSystemPrompt;
   ```
2. Update `Context` interface:
   ```typescript
   export interface Context {
     systemPrompt?: SystemPrompt;  // was: string
     messages: Message[];
     tools?: Tool[];
   }
   ```
3. Add helper function (in same file or a new `packages/ai/src/utils/system-prompt.ts`):
   ```typescript
   export function flattenSystemPrompt(prompt: SystemPrompt | undefined): string | undefined {
     if (prompt === undefined) return undefined;
     if (typeof prompt === 'string') return prompt;
     return prompt.blocks.map(b => b.text).join('');
   }
   ```
4. Export the new types and helper from the package barrel.

**Verification Requirements**:
- [ ] `bun check` passes — all consumers of `Context.systemPrompt` as `string` still compile (they will need `flattenSystemPrompt()` or type narrowing, but non-Anthropic providers should use the flattener)
- [ ] No runtime behavior change for any existing code path

**QA Scenarios**:
- [ ] `flattenSystemPrompt(undefined)` returns `undefined`
- [ ] `flattenSystemPrompt("hello")` returns `"hello"`
- [ ] `flattenSystemPrompt({blocks: [{text: "a"}, {text: "b"}]})` returns `"ab"`
- [ ] TypeScript compilation of all 12+ providers in `packages/ai/src/providers/` succeeds without modifying provider files (if any provider reads `context.systemPrompt` as `string`, add `flattenSystemPrompt()` call at the provider entry point)

**IMPORTANT**: If changing `Context.systemPrompt` type causes widespread breakage, use `lsp_find_references` on the `systemPrompt` property in `packages/ai/src/types.ts` to identify all consumers. Each non-Anthropic provider that reads `context.systemPrompt` needs a `flattenSystemPrompt()` wrapper. This may touch more files than expected — that is acceptable as long as the change at each site is mechanical (wrap in `flattenSystemPrompt()`).

**Phase Gate**: `bun check` passes after this task.

---

#### Task 3.2: Update Anthropic Provider — Cache-Aware System Blocks

**Objective**: Teach `buildAnthropicSystemBlocks` to accept structured prompts and emit separate system blocks with cache hints. Update `applyPromptCaching` to place the cache breakpoint on the stable block.

**Files Modified**:
- `packages/ai/src/providers/anthropic.ts`

**Approach**:
1. **Update `buildAnthropicSystemBlocks`** (line 1103):
   - Change signature to accept `systemPrompt: SystemPrompt | undefined` (instead of `string | undefined`)
   - When input is a `StructuredSystemPrompt`: emit each block as a separate `AnthropicSystemBlock` with metadata
   - When input is a plain `string`: current behavior unchanged
   - Each emitted block carries its `cacheHint` from the source `SystemPromptBlock`

2. **Update `applyPromptCaching`** (line 1283):
   - After applying cache_control to the last tool block (unchanged)
   - For system blocks: if any block has `cacheHint === 'stable'`, place `cache_control` on THAT block instead of the last system block
   - If no block has `cacheHint` (plain string path), current behavior: last system block gets `cache_control`
   - This consumes the same breakpoint budget — no change to MAX_CACHE_BREAKPOINTS=4

3. **Preserve billing header behavior**: The billing header block (`createClaudeBillingHeader`) is injected at position 0 of the system array. It does NOT get a cache breakpoint. The stable prompt block follows it. No change to billing header logic.

**Verification Requirements**:
- [ ] `bun check` passes
- [ ] Structured prompt with `cacheHint: 'stable'` on first block -> that block gets `cache_control`, not the last block
- [ ] Plain string prompt -> last system block gets `cache_control` (current behavior preserved)
- [ ] Total breakpoints used never exceeds MAX_CACHE_BREAKPOINTS=4

**QA Scenarios**:
- [ ] **Structured prompt, 2 blocks (stable + dynamic)**: `buildAnthropicSystemBlocks({blocks: [{text: base, cacheHint: 'stable'}, {text: agent, cacheHint: 'dynamic'}]})` produces system array with billing header + stable block + dynamic block. After `applyPromptCaching`, stable block has `cache_control`, dynamic block does not.
- [ ] **Plain string prompt**: `buildAnthropicSystemBlocks("full prompt")` produces identical output to current implementation. After `applyPromptCaching`, last system block has `cache_control`.
- [ ] **Cache alignment**: Two calls with same stable text but different dynamic text produce system arrays where blocks 0..N-1 are byte-identical (enabling KV cache reuse).
- [ ] **Breakpoint budget**: With structured prompt, total breakpoints = 1 (tools) + 1 (stable system) + 2 (messages) = 4. Not exceeded.

**Phase Gate**: `bun check` passes. Cache breakpoint placement test passes.

---

#### Task 3.3: Update Subagent Prompt Construction to Emit Structured Prompt

**Objective**: Modify executor.ts to produce a `StructuredSystemPrompt` when creating subagent sessions, with the `{{base}}` (defaultPrompt) portion marked as `stable` and the `{{agent}}` + job context portion marked as `dynamic`.

**Files Modified**:
- `packages/coding-agent/src/task/executor.ts`
- `packages/agent/src/agent-loop.ts` (propagation)

**Approach**:
1. **In executor.ts** (lines 972-981), the `systemPrompt` callback currently returns a single rendered string:
   ```typescript
   systemPrompt: (defaultPrompt) => prompt.render(subagentSystemPromptTemplate, {
     base: defaultPrompt, agent: agent.systemPrompt, ...
   })
   ```
   Change to: render the full template as before (for the monolithic fallback), AND separately construct a `StructuredSystemPrompt`:
   ```typescript
   systemPrompt: (defaultPrompt) => {
     const fullPrompt = prompt.render(subagentSystemPromptTemplate, {
       base: defaultPrompt, agent: agent.systemPrompt, ...
     });
     return {
       blocks: [
         { text: defaultPrompt, cacheHint: 'stable' as const },
         { text: fullPrompt.slice(defaultPrompt.length), cacheHint: 'dynamic' as const }
       ]
     };
   }
   ```
   **CRITICAL**: The split must be exact. `defaultPrompt` is the stable prefix. Everything after it (the `{{SECTION_SEPARATOR}}`, `{{agent}}`, job context, closure instructions) is the dynamic suffix. Verify that `fullPrompt.startsWith(defaultPrompt)` — if the Handlebars template doesn't place `{{base}}` at position 0, this slice approach fails. Check the template: line 1 is `{{base}}`, so this should work. But add a runtime assertion.

2. **In agent-loop.ts** (lines 328-332), the `llmContext` is constructed as:
   ```typescript
   const llmContext: Context = { systemPrompt, messages, tools };
   ```
   Where `systemPrompt` comes from `this.#state.systemPrompt` (a string, set by `syncContextBeforeModelCall`). The structured prompt from executor.ts's callback gets stored as `AgentState.systemPrompt` — but `AgentState.systemPrompt` is `string` (REQ-005). 
   
   **Resolution**: The `systemPrompt` callback in `createAgentSession` (sdk.ts line 1378) calls `options.systemPrompt(defaultPrompt)`. Currently it expects a `string` return. We need this to accept `string | StructuredSystemPrompt`. The returned structured prompt should be:
   - Stored as a **flattened string** in `AgentState.systemPrompt` (preserving REQ-005)
   - Also stored in a **separate field** on the session (e.g., `structuredSystemPrompt`) that the agent-loop can read and pass to `Context`
   
   Alternatively, **simpler approach**: Keep the callback returning `string`. Instead, have executor.ts store the `defaultPrompt` length or content as metadata on the session, and have the Anthropic provider split the monolithic string at the known boundary. This avoids changing the callback signature entirely.
   
   **Recommended approach**: Add an optional `systemPromptMetadata` field to `AgentSession` options that carries the split boundary. The agent-loop reads this metadata and constructs a `StructuredSystemPrompt` from the monolithic string + boundary info when building `llmContext`. This way:
   - `AgentState.systemPrompt` stays `string` (REQ-005 satisfied)
   - `rebuildSystemPrompt` stays monolithic (no cascade)
   - Only the `llmContext` construction in agent-loop.ts produces the structured form
   - Non-subagent sessions have no metadata -> plain string path (REQ-006 satisfied)

**Verification Requirements**:
- [ ] `bun check` passes
- [ ] Subagent sessions produce `Context.systemPrompt` as `StructuredSystemPrompt` with correct stable/dynamic split
- [ ] Parent sessions produce `Context.systemPrompt` as plain `string` (unchanged)
- [ ] `flattenSystemPrompt()` on the structured prompt produces byte-identical content to the original monolithic prompt

**QA Scenarios**:
- [ ] **Subagent creation**: Create a reviewer subagent. Verify `llmContext.systemPrompt` is a `StructuredSystemPrompt` with 2 blocks. Verify `blocks[0].text` equals the `defaultPrompt` passed to the callback. Verify `blocks[0].cacheHint === 'stable'`.
- [ ] **Parent session**: Create a parent session. Verify `llmContext.systemPrompt` is a plain `string`.
- [ ] **Content equivalence**: `flattenSystemPrompt(structuredPrompt)` === original monolithic prompt string (byte-for-byte).
- [ ] **3 parallel reviewers**: Spawn 3 reviewer subagents with identical agent config. All 3 produce `blocks[0].text` that is byte-identical.

**Phase Gate**: `bun check` passes. Structured prompt content equivalence verified.

---

#### Task 3.4: Add Tests for Cache Alignment and Backward Compatibility

**Objective**: Write unit tests verifying the cache optimization works correctly and doesn't break existing behavior.

**Files Created/Modified**:
- New test file: `packages/ai/src/providers/__tests__/anthropic-cache-alignment.test.ts` (or extend existing test file if one exists for anthropic provider)

**Tests to Write**:

1. **T-001: Structured prompt block generation**
   - Input: `StructuredSystemPrompt` with 2 blocks (stable + dynamic)
   - Call `buildAnthropicSystemBlocks` with this input
   - Assert: output contains separate system blocks for stable and dynamic content
   - Assert: blocks are in correct order (billing header, stable, dynamic)

2. **T-002: Cache-aligned prefix identity**
   - Input: Two `StructuredSystemPrompt` instances with SAME `stablePrefix`, DIFFERENT `dynamicSuffix`
   - Call `buildAnthropicSystemBlocks` on each
   - Assert: system blocks up to and including the stable block are byte-identical
   - Assert: dynamic blocks differ

3. **T-003: Cache breakpoint placement**
   - Input: `StructuredSystemPrompt` with `cacheHint: 'stable'` on first block
   - Build full Anthropic params and run `applyPromptCaching`
   - Assert: `cache_control` is on the stable system block
   - Assert: `cache_control` is NOT on the dynamic system block
   - Assert: total breakpoints <= MAX_CACHE_BREAKPOINTS

4. **T-004: Plain string backward compatibility**
   - Input: plain `string` system prompt
   - Call `buildAnthropicSystemBlocks` with this input
   - Assert: output is identical to current implementation (last system block gets cache_control)
   - This is a regression test — capture current behavior first, then verify it's preserved

5. **T-005: flattenSystemPrompt helper**
   - Test `undefined` -> `undefined`
   - Test `string` -> same string
   - Test `StructuredSystemPrompt` -> concatenated blocks

6. **T-006: Breakpoint budget compliance**
   - Input: structured prompt + tools + messages
   - Run full `applyPromptCaching`
   - Count total `cache_control` annotations across system + tools + messages
   - Assert: count <= 4

**Verification Requirements**:
- [ ] All tests pass: `bun test packages/ai/src/providers/__tests__/anthropic-cache-alignment.test.ts`
- [ ] Tests are not tautological — they assert meaningful cache alignment contracts

**Phase Gate**: All 6 test categories pass.

---

#### Task 3.5: Full Build and Type Verification

**Objective**: Verify the complete change set compiles and passes all checks.

**Approach**:
1. Run `bun check` — zero type errors across all packages
2. Run `bun lint` — no lint violations
3. Run existing test suite for affected packages: `bun test packages/ai/` and `bun test packages/agent/`
4. Verify no changes to files outside the planned scope (no drift)

**Verification Requirements**:
- [ ] `bun check` exits 0
- [ ] `bun lint` exits 0
- [ ] Existing tests pass (no regressions)
- [ ] `git diff --stat` shows only planned files modified

**Phase Gate**: Clean build, clean lint, all tests green.

---

## Final Verification Wave

- [ ] `bun check` passes with zero errors across all packages
- [ ] `bun lint` passes
- [ ] All new tests pass
- [ ] Non-Anthropic providers compile without changes (verified by `bun check`)
- [ ] Structured prompt `flattenSystemPrompt()` produces byte-identical output to original monolithic prompt

---

## PHASE 4: VERIFICATION & VALIDATION (V&V)

### Verification Matrix

| ID | Verification Type | Method | Acceptance Criteria | Status |
|----|-------------------|--------|---------------------|--------|
| T-001 | Functional | Unit test | `buildAnthropicSystemBlocks` with structured input produces separate blocks with cache hints | Pending |
| T-002 | Functional | Unit test | Two structured prompts with same `stablePrefix` but different `dynamicSuffix` produce byte-identical first N system blocks | Pending |
| T-003 | Functional | Unit test | `applyPromptCaching` places `cache_control` on the block marked `stable`, not the last block, when structured prompt is present | Pending |
| T-004 | Compilation | `bun check` | All 12+ providers compile without modification | Pending |
| T-005 | Regression | `bun check` + manual | Parent session (non-subagent) cache behavior unchanged — no structured prompt injected for parent sessions | Pending |
| T-006 | Functional | Unit test | `flattenSystemPrompt()` on a structured prompt returns the full concatenated string | Pending |

### V&V Protocols

#### Protocol 4.1: Cache Alignment Verification
```
Test: Two structured prompts with identical stablePrefix, different dynamicSuffix
Command: bun test packages/ai/src/providers/__tests__/anthropic-cache.test.ts
Expected: First system block (after billing header) is byte-identical between both
```

#### Protocol 4.2: Backward Compatibility Verification
```
Test: Plain string systemPrompt still works identically to current behavior
Command: bun test packages/ai/src/providers/__tests__/anthropic-cache.test.ts
Expected: Output matches current buildAnthropicSystemBlocks behavior exactly
```

#### Protocol 4.3: Full Build Verification
```
Command: bun check
Expected: Zero type errors across all packages
```

---

## FLIGHT LOG

| Event | Timestamp | Action | Result |
|-------|-----------|--------|--------|
| Mission Planning | T-0 | Plan generated | GO |

---

## APPENDICES

### Rollback
```bash
git revert HEAD~N  # Revert all commits in the change set
bun check          # Verify clean state
```

### Key File References
- `packages/ai/src/types.ts` — `Context` interface (line 451)
- `packages/ai/src/providers/anthropic.ts` — `buildAnthropicSystemBlocks` (line 1103), `applyPromptCaching` (line 1283)
- `packages/coding-agent/src/task/executor.ts` — subagent creation (line 960-1017)
- `packages/coding-agent/src/prompts/system/subagent-system-prompt.md` — Handlebars template (43 lines, NOT modified)
- `packages/agent/src/agent-loop.ts` — `llmContext` construction (line 328-332)
- `packages/agent/src/agent.ts` — `syncContextBeforeModelCall` (line 781)

### Cache Economics
- Current: 3 reviewer subagents each pay full input cost for ~identical system prompt (~100K tokens each = ~300K total)
- After: 1st subagent pays full cost, 2nd and 3rd pay cache-read rate (0.1x) for stable prefix
- Estimated savings: ~60-70% reduction in effective per-token rate for parallel subagent workloads
- Anthropic cache pricing: write = 1.25x base, read = 0.1x base. Break-even at 2nd read.

### Commit Strategy
- Commit 1: Type changes (`packages/ai/src/types.ts`) + helper function
- Commit 2: Anthropic provider changes (`anthropic.ts`)
- Commit 3: Subagent construction changes (`executor.ts`, `agent-loop.ts`)
- Commit 4: Tests
- Alternative: Single atomic commit if changes are tightly coupled
