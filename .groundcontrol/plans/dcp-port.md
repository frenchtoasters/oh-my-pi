# FLIGHT PLAN: Dynamic Context Pruning (DCP) Port

## MISSION OVERVIEW

> **Mission Type**: Type-B Flight Operations
> **Classification**: Feature Development — Major Enhancement
> **Flight Director**: User-authorized
> **T-Minus**: 2026-04-29

---

## EXECUTIVE SUMMARY

### Mission Objective
> **Primary Objective**: Port all Dynamic Context Pruning features from Opencode-DCP into oh-my-pi's coding-agent, adding zero-cost deterministic pruning strategies, LLM-driven range compression, and a nudge system to the existing compaction infrastructure.
>
> **Success Criteria**:
> - All three Tier-1 strategies (deduplication, purge-errors, supersede-writes) run automatically before every LLM call with <50ms overhead for 1000 messages
> - `compress` tool allows LLM to compress specific message ranges with startId/endId
> - Nudge system injects compression reminders when context exceeds configurable thresholds
> - `/decompress` and `/recompress` slash commands allow users to undo/redo compression blocks
> - Token counting via `@anthropic-ai/tokenizer` for Anthropic models with chars/4 fallback for others
> - All features configurable via oh-my-pi Settings system
> - No regression in existing compaction, pruning, or session persistence behavior

### Deliverables
- DCP state management module (`packages/coding-agent/src/session/compaction/dcp-state.ts`)
- Token counting module with `@anthropic-ai/tokenizer` + fallback (`packages/coding-agent/src/session/compaction/tokenizer.ts`)
- Three Tier-1 strategy modules in `packages/coding-agent/src/session/compaction/strategies/`
- Meta-transformer composition for `transformContext` hook
- Message ID injection system
- Compress tool (LLM-callable)
- Nudge system with prompt templates
- Decompression/recompression slash commands
- Compression block state management
- Configuration integration with Settings schema
- TDD test suites for all strategies and components

### Mission Profile
- **Estimated Duration**: Long (multi-week implementation)
- **Parallel Execution**: YES — 5 waves
- **Flight Phases**: Phase 1 (Requirements) → Phase 2 (Hazard Analysis) → Phase 3 (Implementation) → Phase 4 (V&V)

---

## PHASE 1: REQUIREMENTS DEFINITION

### Mission Requirements & Bi-Directional Traceability

| Req ID | Requirement Description | Design Component | Implementation | Test/Verification | Status |
|--------|------------------------|------------------|----------------|-------------------|--------|
| REQ-001 | Deduplicate repeated tool calls (same tool + normalized args), keep only most recent output | Deduplication Strategy | `strategies/deduplication.ts` | `test/dcp/deduplication.test.ts` | Open |
| REQ-002 | Purge inputs of errored tool calls after configurable turn threshold | Purge Errors Strategy | `strategies/purge-errors.ts` | `test/dcp/purge-errors.test.ts` | Open |
| REQ-003 | Prune file write/edit inputs once file subsequently read | Supersede Writes Strategy | `strategies/supersede-writes.ts` | `test/dcp/supersede-writes.test.ts` | Open |
| REQ-004 | Accurate token counting for Anthropic models, chars/4 fallback for others | Tokenizer Module | `compaction/tokenizer.ts` | `test/dcp/tokenizer.test.ts` | Open |
| REQ-005 | Track DCP pruning state (tool signatures, prune decisions, compression blocks) across transforms | DCP State | `compaction/dcp-state.ts` | `test/dcp/dcp-state.test.ts` | Open |
| REQ-006 | Compose multiple transformContext functions (DCP + extensions) without breaking single-slot hook | Meta-Transformer | `compaction/transform-compose.ts` | `test/dcp/transform-compose.test.ts` | Open |
| REQ-007 | Inject short message IDs (mNNNN) into messages for compression referencing | Message ID System | `compaction/message-ids.ts` | `test/dcp/message-ids.test.ts` | Open |
| REQ-008 | LLM-callable `compress` tool for fine-grained range compression (startId, endId, summary) | Compress Tool | `tools/compress.ts` | `test/dcp/compress-tool.test.ts` | Open |
| REQ-009 | System message nudges when context exceeds thresholds | Nudge System | `compaction/nudges.ts` | `test/dcp/nudges.test.ts` | Open |
| REQ-010 | `/decompress <n>` and `/recompress <n>` slash commands | Slash Commands | `capability/dcp-commands.ts` | `test/dcp/dcp-commands.test.ts` | Open |
| REQ-011 | Compression block state: create, deactivate, reactivate, nest blocks | Block State Mgmt | `compaction/compression-blocks.ts` | `test/dcp/compression-blocks.test.ts` | Open |
| REQ-012 | Configuration via Settings schema (enable/disable strategies, thresholds, protected tools) | Settings Integration | `config.ts` additions | `test/dcp/settings.test.ts` | Open |
| REQ-013 | Tier-1 strategies idempotent: identical results on same input across retries | All Strategies | All strategy files | Idempotency tests in each suite | Open |
| REQ-014 | Performance: <50ms transform overhead for sessions with 1000 messages | All Transform Logic | All DCP modules | `test/dcp/performance.test.ts` | Open |
| REQ-015 | Immutability: transformContext MUST NOT mutate source AgentMessage[] | All Transform Logic | All DCP modules | Mutation detection in tests | Open |
| REQ-016 | Respect `excludeFromContext` field on messages | All Strategies | All strategy files | Tests with excluded messages | Open |
| REQ-017 | Tool call + result atomicity: removing a tool call MUST remove its corresponding result | Dedup + Supersede | Strategy files | Atomicity tests | Open |
| REQ-018 | Protected tools merge: existing (`skill`, `read`) + DCP protected tools unified | All Strategies | Strategy config | Protected tool tests | Open |
| REQ-019 | Token savings tracking and logging via logger | DCP State + Stats | `dcp-state.ts` | Stats verification tests | Open |
| REQ-020 | Graceful degradation: compress tool validates input, rejects invalid/malformed summaries, original content always preserved in session | Compress Tool | `tools/compress.ts` | Failure mode tests | Open |

### Constraints & Boundaries
- **MUST HAVE**: All 20 requirements above
- **MUST NOT HAVE**: DCP's JSONC config system (use oh-my-pi Settings), DCP's plugin hook system (use oh-my-pi's hooks), priority map for compression (v2), sub-agent DCP context (v2)
- **ASSUMPTIONS**: `@anthropic-ai/tokenizer` is compatible with Bun runtime; SessionEntry.id is stable across transforms; existing pruning.ts immutable pattern is maintained

---

## PHASE 2: HAZARD ANALYSIS & ARCHITECTURE

### JPL Power of Ten Alignment
- **Simplicity**: Each Tier-1 strategy is a pure function: `(messages, state, config) → messages`
- **Separation**: Strategies are independent modules, composed via meta-transformer
- **Observability**: Token savings logged per strategy per transform
- **Recoverability**: Decompression restores original content; all transforms are non-destructive to session storage
- **Consistency**: Protected tools list merged globally, not per-strategy

### Hazard Analysis & Software Risk Management

| ID | Hazard Description | Severity | Probability | Mitigation Strategy | Abort Trigger | Recovery Path |
|----|-------------------|----------|-------------|---------------------|---------------|---------------|
| H1 | DCP removes context LLM needs, degrading response quality | P2-Major | Medium | Turn protection (recent N turns immune), protected tools list, configurable per-strategy | User reports quality degradation | Disable specific strategy via Settings |
| H2 | Race between async auto-compaction and transformContext DCP | P2-Major | Low | DCP runs in transformContext (sync before LLM call); auto-compaction runs post-turn. Different lifecycle phases, no shared mutable state. DCP state is read-only during transform. | State corruption detected | Restart session; DCP state rebuilt from session entries |
| H3 | `@anthropic-ai/tokenizer` incompatible with Bun | P2-Major | Medium | Test in Bun FIRST (Wave 1 task). Fallback to chars/4 heuristic if incompatible. | Package fails to load in Bun | Use chars/4 heuristic universally |
| H4 | transformContext mutation corrupts session state | P1-Critical | Low | Guardrail: all strategies return NEW objects. Test with Object.freeze on input. | Mutation detected in tests | Revert to pre-DCP transformContext |
| H5 | Double-pruning: DCP deduplicates then existing pruning also truncates | P3-Minor | Medium | Different targets: DCP removes entire tool call+result pairs; existing pruning truncates output content. Non-conflicting. | N/A | N/A |
| H6 | Compression block overlap during nested decompression | P2-Major | Low | Enforce parent-first decompression rule. Block state tracks `parentBlockIds`. | Inconsistent block state | Reset all blocks, re-apply from session |
| H7 | Token counting disagreement between tokenizer and heuristic | P3-Minor | Medium | Use tokenizer for Anthropic models ONLY; heuristic for all others. Never mix in same threshold decision. | N/A | N/A |
| H8 | Session export (HTML) shows pruned/compressed content incorrectly | P3-Minor | Low | Export uses session entries (unpruned). DCP operates on AgentMessage copies in transformContext only. | N/A | N/A |

### Abort & Adaptation Strategy
> **NOTE: MISSION RESILIENCE**
> Do not abort on first failure. Adapt and continue.

**Adaptation Protocol:**
- **Test failures**: Fix implementation, re-run tests. Document non-conformance.
- **Bun compatibility issues with tokenizer**: Fall back to chars/4 heuristic. Document as tech debt.
- **Performance exceeds budget**: Profile, optimize hot paths. Consider caching strategy signatures.
- **Integration conflicts with extensions**: Adjust meta-transformer composition order.

**Deviation Thresholds:**
- [ ] ABORT if `transformContext` hook architecture fundamentally cannot support composition
- [ ] ABORT if `@anthropic-ai/tokenizer` AND all alternative tokenizers fail in Bun (unlikely)
- [ ] ABORT if session persistence format requires breaking schema changes

**Recovery Protocol:**
- Rollback: `git revert` the DCP feature branch
- All DCP code in new files — no modification of existing files except `agent-session.ts` hook wiring and Settings schema
- Estimated recovery time: Instant (revert)

### Architecture Decisions
- **Pattern**: Pure function strategies composed via meta-transformer in `transformContext`
- **State**: In-memory `DCPState` object per session, rebuilt from session entries on load, not persisted separately
- **Token counting**: `@anthropic-ai/tokenizer` for Anthropic, chars/4 for others. Abstracted behind `tokenize(text, provider?)` interface.
- **Message IDs**: Derived from SessionEntry.id position (stable). Injected as metadata tags in transformContext, not persisted.
- **Compression blocks**: Stored in DCPState.compressionBlocks. Original messages remain in session entries — blocks just mark ranges to replace with summaries.
- **Meta-transformer**: Wraps extension `transformContext` + DCP transform into single function. DCP runs first (cheap), then extension transforms.

---

## PHASE 3: IMPLEMENTATION (Flight Operations)

### Mission Timeline

| Task | Description | Dependencies | Parallel | Wave |
|------|-------------|--------------|----------|------|
| 3.1 | Tokenizer module + Bun compatibility validation | None | Yes | 1 |
| 3.2 | DCP State management module | None | Yes | 1 |
| 3.3 | Settings schema additions for DCP configuration | None | Yes | 1 |
| 3.4 | Meta-transformer composition for transformContext | None | Yes | 1 |
| 3.5 | Message ID system | 3.2 | Yes | 2 |
| 3.6 | Deduplication strategy | 3.1, 3.2 | Yes | 2 |
| 3.7 | Purge Errors strategy | 3.1, 3.2 | Yes | 2 |
| 3.8 | Supersede Writes strategy | 3.1, 3.2 | Yes | 2 |
| 3.9 | DCP transform pipeline (compose Tier-1 + message IDs) | 3.4, 3.5, 3.6, 3.7, 3.8 | No | 3 |
| 3.10 | Compression block state management | 3.2 | Yes | 2 |
| 3.11 | Compress tool (LLM-callable) | 3.5, 3.10 | Yes | 3 |
| 3.12 | Nudge system | 3.1, 3.5, 3.9 | Yes | 3 |
| 3.13 | Nudge prompt templates | None | Yes | 1 |
| 3.14 | Decompress/Recompress slash commands | 3.10 | Yes | 3 |
| 3.15 | Agent-session integration (wire DCP into transformContext + settings) | 3.3, 3.9, 3.11, 3.12, 3.14 | No | 4 |
| 3.16 | Integration testing + performance validation | 3.15 | No | 5 |

### PARALLEL EXECUTION PROTOCOL
When executing tasks in parallel, executing agents MUST utilize `git worktrees` to prevent file conflicts. Each parallel task isolates changes in a dedicated worktree and merges back cleanly when verified.

### Implementation Detail

---

## TODOs

### Wave 1: Foundation (All Parallel)

- [ ] **3.1 — Tokenizer Module + Bun Compatibility**

  **Files**: `packages/coding-agent/src/session/compaction/tokenizer.ts`, `packages/coding-agent/test/dcp/tokenizer.test.ts`

  **What to do**:
  1. Install `@anthropic-ai/tokenizer` as a dependency of `packages/coding-agent`
  2. **TDD**: Write tests first in `test/dcp/tokenizer.test.ts`:
     - `countTokens("hello world", "anthropic")` returns accurate count (verify against known value)
     - `countTokens("hello world", "openai")` returns chars/4 heuristic fallback
     - `countTokens("hello world")` with no provider defaults to heuristic
     - `countTokens("")` returns 0
     - `countTokens(longString)` where longString is 100K chars — verify performance <10ms
     - `countTokensForMessages(AgentMessage[])` sums token counts across message content
  3. Create `packages/coding-agent/src/session/compaction/tokenizer.ts`:
     - Export `countTokens(text: string, provider?: string): number`
     - Export `countTokensForMessages(messages: AgentMessage[], provider?: string): number`
     - Use `@anthropic-ai/tokenizer` when `provider` starts with `"anthropic"` or `"claude"`
     - Fall back to `Math.ceil(text.length / 4)` for all other providers
     - Handle tokenizer import failure gracefully (catch, fall back to heuristic, log warning)
  4. Verify Bun compatibility: `bun test packages/coding-agent/test/dcp/tokenizer.test.ts`
  5. If `@anthropic-ai/tokenizer` fails in Bun: switch to heuristic-only, log as tech debt in test file comment

  **Acceptance Criteria**: Tests pass. Anthropic tokenizer loads in Bun OR graceful fallback works.

  **QA Scenarios**:
  - [ ] Anthropic provider → accurate token count (within 5% of known value for test string)
  - [ ] Unknown provider → chars/4 heuristic
  - [ ] Tokenizer package missing/broken → heuristic fallback + logger.warn
  - [ ] 100K character string → result in <10ms
  - [ ] Empty string → 0 tokens

- [ ] **3.2 — DCP State Management**

  **Files**: `packages/coding-agent/src/session/compaction/dcp-state.ts`, `packages/coding-agent/test/dcp/dcp-state.test.ts`

  **What to do**:
  1. **TDD**: Write tests first in `test/dcp/dcp-state.test.ts`:
     - `createDCPState()` returns empty state with all maps initialized
     - `registerToolCall(state, toolCallId, { tool, parameters, status, turn, tokenCount })` stores entry
     - `getToolSignature(tool, parameters)` normalizes params (sort keys, strip null/undefined) and returns `tool::JSON(sorted)`
     - `markForPruning(state, toolCallId, tokenCount)` adds to prune map
     - `isMarkedForPruning(state, toolCallId)` returns boolean
     - `getStats(state)` returns `{ totalPrunedTokens, prunedToolCount }`
     - `resetState(state)` clears all prune decisions (but keeps tool registry)
     - State is plain object (no class), serializable
  2. Create `packages/coding-agent/src/session/compaction/dcp-state.ts`:
     - Export `DCPState` interface: `{ toolParameters: Map<string, ToolParameterEntry>, pruneTools: Map<string, number>, compressionBlocks: Map<string, CompressionBlock>, messageIdMap: Map<string, string>, currentTurn: number, stats: DCPStats }`
     - Export `ToolParameterEntry` interface: `{ tool: string, parameters: Record<string, unknown>, status: "success" | "error", error?: string, turn: number, tokenCount: number }`
     - Export `CompressionBlock` interface: `{ blockId: string, active: boolean, mode: "range" | "message", topic: string, startId: string, endId: string, anchorMessageId: string, summary: string, includedBlockIds: string[], consumedBlockIds: string[], parentBlockIds: string[], effectiveMessageIds: string[], effectiveToolIds: string[], deactivatedByUser: boolean }`
     - Export `DCPStats` interface: `{ totalPrunedTokens: number, prunedToolCount: number, compressionBlockCount: number }`
     - Export all CRUD functions as pure functions: `createDCPState()`, `registerToolCall()`, `markForPruning()`, `getToolSignature()`, etc.
  3. Run tests: `bun test packages/coding-agent/test/dcp/dcp-state.test.ts`

  **Acceptance Criteria**: All state management functions pass TDD tests. State is immutable-friendly (functions return new state or mutate-in-place consistently).

  **QA Scenarios**:
  - [ ] Fresh state → all maps empty, stats zero
  - [ ] Register tool call → retrievable by ID
  - [ ] Duplicate signature detection → `getToolSignature("read", {filePath: "/a"}) === getToolSignature("read", {filePath: "/a"})`
  - [ ] Parameter normalization → `{b: 1, a: 2, c: null}` normalizes to `{a: 2, b: 1}` (null stripped, keys sorted)
  - [ ] Mark for pruning → stats updated, `isMarkedForPruning` returns true
  - [ ] Reset → prune maps cleared, tool registry preserved

- [ ] **3.3 — Settings Schema Additions**

  **Files**: `packages/coding-agent/src/config/settings-schema.ts` (extend), `packages/coding-agent/test/dcp/settings.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - Default DCP settings: `{ enabled: true, strategies: { deduplication: { enabled: true, protectedTools: [] }, purgeErrors: { enabled: true, turnThreshold: 4, protectedTools: [] }, supersedeWrites: { enabled: true, protectedTools: [] } }, compress: { permission: "allow", mode: "range" }, nudge: { enabled: true, maxContextLimit: 100000, minContextLimit: 50000, frequency: 5, iterationThreshold: 15 }, turnProtection: { turns: 2 }, protectedTools: ["task", "skill", "todowrite", "todoread", "compress", "write", "edit", "read"], protectedFilePatterns: [] }`
     - Settings validation: invalid `turnThreshold` (negative) rejects
     - Settings merge: user partial override merges with defaults
  2. Locate `packages/coding-agent/src/config/settings-schema.ts` and add a `dcp` section to the existing settings schema
  3. Add DCP configuration types matching the test expectations
  4. Ensure defaults are applied when user provides no DCP config
  5. Run tests + `bun check`

  **Acceptance Criteria**: DCP settings integrate cleanly with existing Settings. Defaults work. Partial overrides merge correctly.

  **QA Scenarios**:
  - [ ] No DCP config provided → all defaults applied
  - [ ] `dcp.strategies.deduplication.enabled: false` → only dedup disabled, others default
  - [ ] Invalid `turnThreshold: -1` → validation error
  - [ ] `dcp.protectedTools: ["custom"]` → merged with defaults (additive)

- [ ] **3.4 — Meta-Transformer Composition**

  **Files**: `packages/coding-agent/src/session/compaction/transform-compose.ts`, `packages/coding-agent/test/dcp/transform-compose.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - `composeTransforms([fn1, fn2])` returns a single function with `transformContext` signature
     - Composed function calls fn1 then fn2 in order, passing output of fn1 as input to fn2
     - If fn1 returns fewer messages, fn2 receives the reduced set
     - If any transform is undefined/null, it's skipped
     - Signal (AbortSignal) is passed through to all transforms
     - Empty array of transforms → identity function (returns input unchanged)
     - Transform that throws → error propagates, does not corrupt state
  2. Create `packages/coding-agent/src/session/compaction/transform-compose.ts`:
     - Export `composeTransforms(transforms: Array<TransformContextFn | undefined | null>): TransformContextFn`
     - Type: `type TransformContextFn = (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>`
     - Implement as sequential pipeline: each transform receives output of previous
  3. Run tests: `bun test packages/coding-agent/test/dcp/transform-compose.test.ts`

  **Acceptance Criteria**: Composition works, order preserved, nulls handled, errors propagate cleanly.

  **QA Scenarios**:
  - [ ] Two transforms in sequence → both applied in order
  - [ ] First transform filters 3 messages → second receives reduced set
  - [ ] `[undefined, fn1, null, fn2]` → only fn1 and fn2 run
  - [ ] Empty transforms array → messages pass through unchanged
  - [ ] Transform throws Error → error propagates to caller
  - [ ] AbortSignal passed through → each transform receives it

### Wave 2: Strategies + Building Blocks (All Parallel, depends on Wave 1)

- [ ] **3.5 — Message ID System**

  **Files**: `packages/coding-agent/src/session/compaction/message-ids.ts`, `packages/coding-agent/test/dcp/message-ids.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - `assignMessageIds(messages: AgentMessage[])` returns `Map<number, string>` mapping message index to `mNNNN` ID
     - IDs are sequential: first message → `m0001`, second → `m0002`, etc.
     - Messages with `excludeFromContext: true` get IDs but are flagged
     - `injectMessageIdTags(messages, idMap)` returns new messages with `<dcp-message-id>mNNNN</dcp-message-id>` metadata injected into content
     - Injection into user messages: prepend to first text content block
     - Injection into assistant messages: prepend to first text content block
     - Injection into tool result messages: prepend to content
     - `stripMessageIdTags(text)` removes `<dcp-message-id>...</dcp-message-id>` tags from text
     - Idempotency: injecting twice doesn't double-tag (strips first, then injects)
  2. Create `packages/coding-agent/src/session/compaction/message-ids.ts`:
     - Export `assignMessageIds`, `injectMessageIdTags`, `stripMessageIdTags`
     - IDs are ephemeral — regenerated every transform call. Not persisted.
     - Use SessionEntry.id as stable anchor when available (match by position)
  3. Run tests

  **Acceptance Criteria**: IDs assigned correctly, tags injected without mutation, stripping is clean.

  **QA Scenarios**:
  - [ ] 5 messages → IDs m0001 through m0005
  - [ ] Message with `excludeFromContext: true` → still gets ID (needed for block references)
  - [ ] Inject → strip → content identical to original
  - [ ] Inject twice → same result as inject once (idempotent)
  - [ ] Empty messages array → empty map, no errors

- [ ] **3.6 — Deduplication Strategy**

  **Files**: `packages/coding-agent/src/session/compaction/strategies/deduplication.ts`, `packages/coding-agent/test/dcp/deduplication.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - Given messages with two `read` calls for same file (`{filePath: "/a.ts"}`): only most recent kept
     - Given messages with two `read` calls for different files: both kept
     - Given messages with three `bash` calls with identical command: only most recent kept
     - Protected tool (`skill`) with duplicate signature: NOT pruned
     - Protected file pattern matching: tool call with `filePath` matching glob pattern NOT pruned
     - Tool call pruned → its corresponding ToolResultMessage also removed (atomicity)
     - Turn-protected calls (within recent N turns) → NOT pruned even if duplicate
     - `excludeFromContext: true` messages → skipped entirely
     - Idempotency: running twice on same input produces same output
     - Returns `{ messages: AgentMessage[], prunedCount: number, tokensSaved: number }`
  2. Create `packages/coding-agent/src/session/compaction/strategies/deduplication.ts`:
     - Export `deduplicateToolCalls(messages: AgentMessage[], state: DCPState, config: DeduplicationConfig): DeduplicationResult`
     - Build signature map: `Map<string, string[]>` (signature → [toolCallId, toolCallId, ...])
     - For each signature group with >1 entry: keep last, mark others for removal
     - Remove both the tool call (in AssistantMessage.content) and its ToolResultMessage
     - Respect `config.protectedTools`, `config.protectedFilePatterns`, `config.turnProtection`
     - MUST return new message objects — never mutate input
  3. Run tests

  **Acceptance Criteria**: Dedup correctly identifies and removes duplicate tool calls while preserving atomicity and protection rules.

  **QA Scenarios**:
  - [ ] 2 identical `read /a.ts` calls → older one + its result removed
  - [ ] 2 `read` calls, different files → both kept
  - [ ] Protected tool `skill` → never deduplicated
  - [ ] Protected file pattern `*.lock` matches → tool call kept
  - [ ] Recent turn protection → duplicate within last 2 turns kept
  - [ ] Tool call removed → corresponding ToolResultMessage also removed
  - [ ] Input messages not mutated (Object.freeze test)
  - [ ] `excludeFromContext: true` → skipped

- [ ] **3.7 — Purge Errors Strategy**

  **Files**: `packages/coding-agent/src/session/compaction/strategies/purge-errors.ts`, `packages/coding-agent/test/dcp/purge-errors.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - Tool call with `status: "error"` and age > threshold (4 turns) → input replaced with `[Error input pruned — N tokens saved]`
     - Tool call with `status: "error"` and age <= threshold → input preserved
     - Tool call with `status: "success"` → never touched regardless of age
     - Error message in ToolResultMessage preserved (only input pruned)
     - Protected tool with error → NOT pruned
     - Turn-protected error → NOT pruned
     - Returns `{ messages: AgentMessage[], prunedCount: number, tokensSaved: number }`
     - Idempotency: already-pruned error input not double-pruned
  2. Create `packages/coding-agent/src/session/compaction/strategies/purge-errors.ts`:
     - Export `purgeErrorInputs(messages: AgentMessage[], state: DCPState, config: PurgeErrorsConfig): PurgeErrorsResult`
     - Walk messages, identify tool calls where status is error and age exceeds threshold
     - Replace tool call arguments content (in AssistantMessage.content tool_use block) with placeholder
     - Preserve the ToolResultMessage (which contains the error description)
     - MUST return new message objects
  3. Run tests

  **Acceptance Criteria**: Old error inputs pruned, error messages preserved, protection rules respected.

  **QA Scenarios**:
  - [ ] Error call 5 turns old (threshold 4) → input pruned, error message kept
  - [ ] Error call 3 turns old (threshold 4) → input preserved
  - [ ] Success call 10 turns old → never pruned
  - [ ] Protected tool with old error → NOT pruned
  - [ ] Already-pruned input → not double-pruned (idempotent)
  - [ ] Input not mutated (Object.freeze test)

- [ ] **3.8 — Supersede Writes Strategy**

  **Files**: `packages/coding-agent/src/session/compaction/strategies/supersede-writes.ts`, `packages/coding-agent/test/dcp/supersede-writes.test.ts`

  **What to do**:
  1. **TDD**: Write tests first — define exact semantics:
     - `write` to `/a.ts` followed by `read` of `/a.ts` → write's input content pruned (the file content argument), write's result kept
     - `edit` to `/a.ts` followed by `read` of `/a.ts` → edit's input content pruned
     - `write` to `/a.ts` with NO subsequent read → write preserved
     - Multiple writes to `/a.ts` then one read → ALL writes' inputs pruned (read output supersedes all)
     - `write` to `/a.ts` then `read` of `/b.ts` → write preserved (different file)
     - Protected file pattern → write NOT pruned
     - Turn-protected write → NOT pruned
     - Tool call arguments pruned → replaced with `[Write input superseded by subsequent read — N tokens saved]`
     - Returns `{ messages: AgentMessage[], prunedCount: number, tokensSaved: number }`
  2. Create `packages/coding-agent/src/session/compaction/strategies/supersede-writes.ts`:
     - Export `supersedeWrites(messages: AgentMessage[], state: DCPState, config: SupersedeWritesConfig): SupersedeWritesResult`
     - Build file operation timeline: track write/edit operations and their subsequent reads
     - For each file with a read AFTER a write/edit: prune the write/edit input content
     - Only prune input arguments (the content being written), NOT the tool result
     - Respect protection rules
     - MUST return new message objects
  3. Run tests

  **Acceptance Criteria**: Write/edit inputs pruned when subsequent read exists, exact file matching, protection rules respected.

  **QA Scenarios**:
  - [ ] write `/a.ts` → read `/a.ts` → write input pruned
  - [ ] edit `/a.ts` → read `/a.ts` → edit input pruned
  - [ ] write `/a.ts` (no read) → preserved
  - [ ] 3 writes to `/a.ts` → read `/a.ts` → all 3 write inputs pruned
  - [ ] write `/a.ts` → read `/b.ts` → write preserved
  - [ ] Protected file pattern matches → write preserved
  - [ ] Turn-protected write → preserved
  - [ ] Input not mutated (Object.freeze test)

- [ ] **3.10 — Compression Block State Management**

  **Files**: `packages/coding-agent/src/session/compaction/compression-blocks.ts`, `packages/coding-agent/test/dcp/compression-blocks.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - `createBlock(state, { startId, endId, summary, topic })` → creates block with unique ID (b1, b2, ...), active=true
     - `deactivateBlock(state, blockId)` → sets `active=false`, `deactivatedByUser=true`
     - `reactivateBlock(state, blockId)` → sets `active=true`, `deactivatedByUser=false`
     - `getActiveBlocks(state)` → returns only active blocks
     - `filterCompressedRanges(messages, blocks, messageIdMap)` → replaces message ranges with summary blocks
     - Nested blocks: block B includes block A's range. Deactivating B without deactivating A → A's summary still visible
     - Overlapping blocks: new block that overlaps existing → existing block consumed, its summary included via `(bN)` placeholder
     - `getBlockById(state, blockId)` → returns block or undefined
     - Deactivating block that has child blocks → error (must deactivate children first)
  2. Create `packages/coding-agent/src/session/compaction/compression-blocks.ts`:
     - Export CRUD functions for compression blocks
     - Export `filterCompressedRanges(messages: AgentMessage[], blocks: Map<string, CompressionBlock>, messageIdMap: Map<string, string>): AgentMessage[]`
     - Block IDs use format `b1`, `b2`, etc. (sequential)
     - When filtering: active blocks replace their message range with a system/developer message containing the summary
     - Nested block references via `(bN)` placeholder in summary text
  3. Run tests

  **Acceptance Criteria**: Block lifecycle works, filtering replaces correct ranges, nesting handled, deactivation rules enforced.

  **QA Scenarios**:
  - [ ] Create block → ID is `b1`, active, stored in state
  - [ ] Deactivate block → `active=false`, messages in range visible again
  - [ ] Reactivate block → `active=true`, range replaced with summary
  - [ ] Filter with active block [m0003..m0007] → those messages replaced with summary
  - [ ] Nested: block B [m0001..m0010] consumes block A [m0003..m0005] → A's summary embedded in B via `(b1)` placeholder
  - [ ] Deactivate parent without deactivating child → error thrown
  - [ ] No active blocks → messages pass through unchanged

### Wave 3: Pipeline Assembly + Tools (Partially Parallel, depends on Wave 2)

- [ ] **3.9 — DCP Transform Pipeline**

  **Files**: `packages/coding-agent/src/session/compaction/dcp-transform.ts`, `packages/coding-agent/test/dcp/dcp-transform.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - `createDCPTransform(state: DCPState, config: DCPConfig)` returns a `TransformContextFn`
     - The returned function executes strategies in order: deduplication → purge-errors → supersede-writes → filter-compressed-ranges → inject-message-ids
     - Each strategy receives the output of the previous
     - Disabled strategies (via config) are skipped
     - State is updated with prune decisions and stats after each strategy
     - Returns final transformed messages
     - Full pipeline idempotent
     - `excludeFromContext` messages passed through but not processed
  2. Create `packages/coding-agent/src/session/compaction/dcp-transform.ts`:
     - Export `createDCPTransform(state: DCPState, config: DCPConfig): TransformContextFn`
     - Orchestrates all Tier-1 strategies + message ID injection + compression block filtering
     - Calls each strategy in sequence, passing results forward
     - Updates `state.stats` with cumulative savings
     - Logs savings per strategy via `logger.debug`
  3. Run tests

  **Acceptance Criteria**: Pipeline composes all strategies correctly, respects config, updates state, logs savings.

  **QA Scenarios**:
  - [ ] All strategies enabled → all run in order
  - [ ] Dedup disabled → only purge-errors + supersede-writes + message IDs run
  - [ ] Pipeline with 20 messages (5 duplicates, 2 old errors, 1 superseded write) → correct count of each type pruned
  - [ ] Stats updated after pipeline run → `totalPrunedTokens` reflects all strategies
  - [ ] Idempotent: running pipeline twice on same input → same result
  - [ ] `excludeFromContext` messages → passed through untouched

- [ ] **3.11 — Compress Tool (LLM-Callable)**

  **Files**: `packages/coding-agent/src/tools/compress.ts`, `packages/coding-agent/test/dcp/compress-tool.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - Tool schema: `{ startId: string, endId: string, summary: string, topic?: string }` — all required except topic
     - `execute({ startId: "m0003", endId: "m0007", summary: "Explored auth options..." })` → creates compression block in DCP state
     - Invalid startId/endId (not in message map) → tool error result with helpful message
     - startId after endId → tool error "startId must come before endId"
     - Range overlaps existing active block → existing block consumed, new block references it via `(bN)` placeholder
     - Summary too short (<20 chars) → tool error "Summary must be at least 20 characters"
     - Tool must NOT call LLM itself — the LLM provides the summary in the tool call arguments
     - Tool result confirms: "Compressed messages m0003-m0007 into block b3. Saved ~N tokens."
  2. Create `packages/coding-agent/src/tools/compress.ts`:
     - Register as an AgentTool following oh-my-pi's tool registration pattern
     - Tool name: `compress`
     - Schema validates startId, endId, summary (+ optional topic)
     - On execute: validate IDs → create compression block → update DCP state → return success message
     - This tool complements (does NOT replace) the existing `/compact` command
  3. Follow the project rules: no inline prompts, use static `.md` for tool description
  4. Create `packages/coding-agent/src/prompts/tools/compress.md` with tool usage instructions
  5. Run tests

  **Acceptance Criteria**: Tool creates valid compression blocks, validates inputs, returns clear feedback.

  **QA Scenarios**:
  - [ ] Valid compress call → block created, success message with token savings
  - [ ] Invalid startId → error: "Message ID m9999 not found"
  - [ ] startId > endId → error: "startId must come before endId"
  - [ ] Overlapping range → existing block consumed, referenced via `(bN)` in new block
  - [ ] Summary <20 chars → error: "Summary must be at least 20 characters"
  - [ ] Tool result message → includes block ID and estimated savings

- [ ] **3.12 — Nudge System**

  **Files**: `packages/coding-agent/src/session/compaction/nudges.ts`, `packages/coding-agent/test/dcp/nudges.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - `shouldInjectNudge(state: DCPState, config: NudgeConfig, tokenCount: number, messageCount: number): NudgeType | null`
     - Returns `"context_limit"` when `tokenCount > config.maxContextLimit`
     - Returns `"turn"` when `tokenCount > config.minContextLimit` AND at user→assistant boundary AND frequency check passes
     - Returns `"iteration"` when `tokenCount > config.minContextLimit` AND messages since last user message > `config.iterationThreshold`
     - Returns `null` when no nudge needed
     - Frequency: nudge only on every Nth transform call (`config.frequency`, default 5)
     - `createNudgeMessage(type: NudgeType)` returns a developer message with nudge text loaded from prompt template
     - `injectNudge(messages: AgentMessage[], nudgeMsg: AgentMessage)` appends nudge as developer message at end
     - Context limit nudge is URGENT — injected every time, ignoring frequency
  2. Create `packages/coding-agent/src/session/compaction/nudges.ts`:
     - Export `shouldInjectNudge`, `createNudgeMessage`, `injectNudge`
     - Track nudge invocation count in DCP state for frequency control
     - Load nudge prompt text from `.md` templates (see task 3.13)
  3. Run tests

  **Acceptance Criteria**: Nudges fire at correct thresholds, frequency control works, urgent nudges bypass frequency.

  **QA Scenarios**:
  - [ ] Token count 120K (max 100K) → `"context_limit"` nudge
  - [ ] Token count 60K (min 50K), at turn boundary, frequency check passes → `"turn"` nudge
  - [ ] Token count 60K, 20 messages since user (threshold 15) → `"iteration"` nudge
  - [ ] Token count 30K → no nudge (`null`)
  - [ ] Frequency: 4th call (frequency 5) → no nudge; 5th call → nudge
  - [ ] Context limit nudge ignores frequency → always fires
  - [ ] Nudge message is developer role, contains guidance text

- [ ] **3.13 — Nudge Prompt Templates**

  **Files**: `packages/coding-agent/src/prompts/compaction/nudge-context-limit.md`, `packages/coding-agent/src/prompts/compaction/nudge-turn.md`, `packages/coding-agent/src/prompts/compaction/nudge-iteration.md`

  **What to do**:
  1. Create three prompt template files:
     - `nudge-context-limit.md`: Urgent message telling LLM to use `compress` tool immediately. Explain context is near limit, provide guidance on selecting ranges, remind about `mNNNN` message IDs.
     - `nudge-turn.md`: Gentle reminder at turn boundaries. Suggest compressing stale exploration/research. Less urgent tone.
     - `nudge-iteration.md`: Mid-work reminder when many tool calls have happened. Suggest compressing completed investigation phases.
  2. Each template should reference the `compress` tool by name and explain the `startId`/`endId`/`summary` format
  3. Templates should be importable via `import text from "./nudge-context-limit.md" with { type: "text" }`
  4. Keep templates concise (under 200 tokens each) — they're injected into context and shouldn't consume much budget themselves

  **Acceptance Criteria**: Templates exist, are importable, reference compress tool correctly, each under 200 tokens.

  **QA Scenarios**:
  - [ ] Each template imports without error via `import ... with { type: "text" }`
  - [ ] Context-limit template mentions `compress` tool and urgency
  - [ ] Turn template is less urgent, suggests compressing stale content
  - [ ] Iteration template suggests compressing completed phases
  - [ ] Each template under 200 tokens (verify with tokenizer)

- [ ] **3.14 — Decompress/Recompress Slash Commands**

  **Files**: `packages/coding-agent/src/capability/dcp-commands.ts`, `packages/coding-agent/test/dcp/dcp-commands.test.ts`

  **What to do**:
  1. **TDD**: Write tests first:
     - `/decompress b3` → calls `deactivateBlock(state, "b3")` → success message "Block b3 decompressed. Original messages restored."
     - `/decompress b99` (nonexistent) → error "Block b99 not found"
     - `/decompress b3` where b3 has active child blocks → error "Deactivate child blocks first: b4, b5"
     - `/recompress b3` → calls `reactivateBlock(state, "b3")` → success "Block b3 recompressed."
     - `/recompress b3` where b3 is already active → error "Block b3 is already active"
     - `/dcp stats` → shows pruning stats (total tokens saved, blocks active, strategies breakdown)
     - `/dcp context` → shows token breakdown (current context size, pruned tokens, compression savings)
  2. Create `packages/coding-agent/src/capability/dcp-commands.ts`:
     - Register slash command providers using oh-my-pi's capability system (`registerProvider(slashCommandCapability.id, {...})`)
     - Commands: `/decompress <blockId>`, `/recompress <blockId>`, `/dcp stats`, `/dcp context`
     - Each command accesses DCP state from the agent session
     - Format output as user-friendly text with stats
  3. Run tests

  **Acceptance Criteria**: Commands work, error handling is clear, stats display correctly.

  **QA Scenarios**:
  - [ ] `/decompress b3` (valid, no children) → block deactivated, success message
  - [ ] `/decompress b99` → "Block b99 not found"
  - [ ] `/decompress b3` with child blocks → error listing children
  - [ ] `/recompress b3` (deactivated) → block reactivated
  - [ ] `/recompress b3` (already active) → error
  - [ ] `/dcp stats` → shows total pruned tokens, block count, per-strategy counts
  - [ ] `/dcp context` → shows current token count, savings breakdown

### Wave 4: Integration (Sequential, depends on Wave 3)

- [ ] **3.15 — Agent-Session Integration**

  **Files**: `packages/coding-agent/src/session/agent-session.ts` (modify), `packages/coding-agent/test/dcp/agent-session-integration.test.ts`

  **What to do**:
  1. **TDD**: Write integration test:
     - Create AgentSession with DCP enabled → DCP state initialized
     - `transformContext` hook includes DCP transform composed with extension transforms via meta-transformer
     - DCP transform runs BEFORE extension transforms (cheap first, then custom)
     - Session with duplicate tool calls → after transformContext, duplicates removed
     - Session with old errors → after transformContext, error inputs pruned
     - Session with write→read → after transformContext, write inputs pruned
     - Message IDs injected into final output
     - Compression blocks applied
     - Nudges injected at threshold
     - DCP settings from config respected (enable/disable per strategy)
     - DCP state persists across multiple transformContext calls within same session
     - DCP state resets correctly on session branch
  2. Modify `packages/coding-agent/src/session/agent-session.ts`:
     - Import DCP modules: `createDCPState`, `createDCPTransform`, `composeTransforms`, DCP settings
     - In constructor (or session init): create `DCPState` instance, store on session
     - Replace single `transformContext` assignment with `composeTransforms([dcpTransform, extensionTransform])`
     - Pass DCP settings from session config to `createDCPTransform`
     - Wire `syncContextBeforeModelCall` to update DCP state's `currentTurn` counter
     - Wire compress tool registration (add to tools list when DCP enabled)
     - Wire slash command registration for `/decompress`, `/recompress`, `/dcp`
  3. Verify no regression: run existing compaction tests
  4. Run `bun check` for type safety
  5. Run full test suite

  **Acceptance Criteria**: DCP fully integrated, existing functionality unbroken, all settings respected.

  **QA Scenarios**:
  - [ ] DCP enabled (default) → all strategies run in transformContext
  - [ ] DCP disabled → transformContext passes through unchanged (no DCP processing)
  - [ ] Extension transform exists + DCP → both run in correct order (DCP first)
  - [ ] No extension transform + DCP → only DCP runs
  - [ ] Session config overrides default DCP settings → overrides respected
  - [ ] Multiple transformContext calls in one session → DCP state accumulates correctly
  - [ ] `bun check` passes
  - [ ] Existing compaction tests still pass
  - [ ] Compress tool appears in tool list when DCP enabled
  - [ ] `/decompress` and `/recompress` commands registered

---

## Final Verification Wave

### Wave 5: Integration Testing + Performance (Task 3.16)

**Objective**: Validate the complete DCP pipeline end-to-end and verify performance budget.

**What to do**:
1. Write integration tests in `packages/coding-agent/test/dcp/integration.test.ts` that:
   - Create a mock session with 50+ messages including duplicate tool calls, errored calls, write→read sequences
   - Run the full DCP transform pipeline and verify correct pruning decisions
   - Verify compression blocks are created and applied correctly
   - Verify decompression restores original content
   - Verify nudge injection at threshold boundaries
   - Verify `excludeFromContext` messages are respected throughout
   - Verify tool call + result atomicity (no orphaned results)
   - Verify protected tools are never pruned
   - Verify idempotency: running transform twice produces identical output
2. Write performance benchmark in `packages/coding-agent/test/dcp/performance.test.ts`:
   - Generate 1000-message session
   - Time full DCP transform pipeline
   - Assert <50ms total overhead
3. Run `bun check` to verify no type errors
4. Run full DCP test suite: `bun test packages/coding-agent/test/dcp/`
5. Manually verify with `bun run dev` that a real session triggers Tier-1 pruning (check logs)

**QA Scenarios**:
- [ ] Full pipeline: 50-message session with mixed tool calls → correct pruning, no mutations, <50ms
- [ ] Idempotency: transform(transform(messages)) === transform(messages)
- [ ] Empty session: 0 messages → no errors, passthrough
- [ ] All-protected session: every tool call is protected → no pruning occurs
- [ ] Compression + decompression round-trip: compress range → decompress → messages restored
- [ ] Nudge threshold boundary: exactly at minContextLimit → nudge injected on correct frequency
- [ ] Multi-provider: Anthropic tokenizer for Claude, heuristic for GPT-4 → no errors
- [ ] `excludeFromContext: true` messages → not counted in token budgets, not deduplicated
- [ ] Race simulation: concurrent transformContext calls → no state corruption

**Phase Gate**: `bun check` passes, all test suites green, performance under budget.

---

## Commit Strategy

Each wave produces one or more commits:
- **Wave 1**: `feat(coding-agent): add DCP foundation — tokenizer, state, settings, meta-transformer`
- **Wave 2**: `feat(coding-agent): add DCP Tier-1 strategies — dedup, purge-errors, supersede-writes, message IDs, compression blocks`
- **Wave 3**: `feat(coding-agent): add DCP compress tool, nudge system, decompress/recompress commands`
- **Wave 4**: `feat(coding-agent): integrate DCP pipeline into agent-session transformContext`
- **Wave 5**: `test(coding-agent): add DCP integration tests and performance benchmarks`

---

## Success Criteria

- [ ] All 20 requirements (REQ-001 through REQ-020) verified via tests
- [ ] `bun check` passes with zero type errors
- [ ] All DCP test suites pass: `bun test packages/coding-agent/test/dcp/`
- [ ] Performance: DCP transform <50ms for 1000-message sessions
- [ ] Existing compaction tests still pass (no regression)
- [ ] Token savings logged per strategy (observable via `logger.debug`)
- [ ] Settings schema validates DCP configuration options

---

## PHASE 4: VERIFICATION & VALIDATION (V&V)

### Verification Matrix

| Verification Type | Method | Acceptance Criteria | Status |
|-------------------|--------|---------------------|--------|
| Unit (Strategies) | `bun test test/dcp/{strategy}.test.ts` | All Tier-1 strategies pass TDD suites | Pending |
| Unit (State) | `bun test test/dcp/dcp-state.test.ts` | State creation, update, rebuild from entries | Pending |
| Unit (Tokenizer) | `bun test test/dcp/tokenizer.test.ts` | Anthropic accurate, fallback consistent | Pending |
| Unit (Compress) | `bun test test/dcp/compress-tool.test.ts` | Range compression creates valid blocks | Pending |
| Unit (Nudges) | `bun test test/dcp/nudges.test.ts` | Threshold detection, frequency control | Pending |
| Unit (Commands) | `bun test test/dcp/dcp-commands.test.ts` | Decompress/recompress state transitions | Pending |
| Integration | `bun test test/dcp/integration.test.ts` | Full pipeline, atomicity, idempotency | Pending |
| Performance | `bun test test/dcp/performance.test.ts` | <50ms for 1000 messages | Pending |
| Type Safety | `bun check` | Zero type errors | Pending |
| Regression | `bun test packages/coding-agent/test/` | Existing tests still pass | Pending |

### V&V Protocols

#### Protocol 4.1: Functional Verification
```
Test: Full DCP pipeline with mixed session
Command: bun test packages/coding-agent/test/dcp/
Expected: All tests pass, zero failures
```

#### Protocol 4.2: Safety Verification
```
Check: H4 — Mutation prevention
Verification: Tests use Object.freeze on input messages; any mutation throws
Threshold: Zero mutations detected
```

#### Protocol 4.3: Performance Verification
```
Check: REQ-014 — Transform overhead
Verification: Benchmark 1000-message transform
Threshold: <50ms total, measured via performance.now()
```

### Final Mission Certification

| Assessment | Rating | Notes |
|------------|--------|-------|
| Mission Objectives | [Pending] | All 20 REQs must be verified |
| Hazard Prevention | [Pending] | H1-H8 mitigations active |
| State Integrity | [Pending] | No session corruption |
| Performance | [Pending] | <50ms budget met |

---

## FLIGHT LOG

| Event | Timestamp | Action | Result |
|-------|-----------|--------|--------|
| Mission Brief | T-0 | Requirements gathered, PreFlight consulted | GO |
| Plan Generated | T-0 | Flight plan created | Pending review |

---

## APPENDICES
- **Rollback**: `git revert` the DCP feature branch. All new code in new files.
- **Reference**: [Opencode-DCP repo](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
- **Oh-my-pi compaction**: `packages/coding-agent/src/session/compaction/`
- **Oh-my-pi agent hooks**: `packages/agent/src/agent-loop.ts` (transformContext, syncContextBeforeModelCall, convertToLlm)
