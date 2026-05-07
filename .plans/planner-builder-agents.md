# FLIGHT PLAN: Planner/Builder Modes and Agent Migration

## MISSION OVERVIEW

> **Mission Type**: Type-B Flight Operations
> **Classification**: Feature migration from pi-mono-bak to oh-my-pi
> **T-Minus**: Mon Apr 27 2026

---

## EXECUTIVE SUMMARY

### Mission Objective
> **Primary Objective**: Port plan/build modes and specialist agents from pi-mono-bak into oh-my-pi's existing architecture, renaming groundcontrol→planner and orchestrator→builder, while adapting all prompts to oh-my-pi conventions (model aliases, tool names, `local://` file scheme, `ask` tool, `task` tool).
>
> **Success Criteria**:
> - `bun check` passes with zero errors
> - All 10+ agents (explorer, designer, fixer, librarian, oracle, pre-flight, verification, reviewer, task, quick_task, init) load via `loadBundledAgents()` without `AgentParsingError`
> - Plan mode uses the planner prompt; post-approval execution uses the builder prompt
> - No references to `question` tool, `subagent` tool, literal model names, or `.plans/` paths remain in any prompt
> - Existing plan mode flow (enter → explore → plan → exit → approve → execute) is preserved

### Deliverables
- 5 new agent `.md` files: `explorer.md`, `fixer.md`, `oracle.md`, `pre-flight.md`, `verification.md`
- 2 replaced/enhanced agent `.md` files: `designer.md` (updated prompt), `librarian.md` (updated prompt)
- 1 removed agent: `plan.md` (replaced by planner prompt in plan mode)
- 1 new prompt: `planner.md` system prompt (~400 lines) replacing `plan-mode-active.md`
- 1 enhanced prompt: `plan-mode-approved.md` → builder prompt with delegation capabilities
- Updated `agents.ts` registration (add new agents, remove plan, rename explore→explorer)
- Updated `task/index.ts` plan mode subagent restriction list

### Mission Profile
- **Estimated Duration**: Medium
- **Parallel Execution**: YES — 4 waves
- **Flight Phases**: Phase 1 (Foundation) → Phase 2 (Agent Migration) → Phase 3 (Mode Prompts) → Phase 4 (Wiring & Verification)

---

## PHASE 1: REQUIREMENTS DEFINITION

### Requirements Traceability Matrix

| Req ID | Requirement Description | Design Component | Implementation | Verification | Status |
|--------|------------------------|------------------|----------------|-------------|--------|
| REQ-001 | Port planner system prompt from pi-mono-bak groundcontrol | Plan mode prompt | `plan-mode-active.md` replacement | Plan mode entry injects correct prompt | Open |
| REQ-002 | Port builder system prompt from pi-mono-bak orchestrator | Build/execute prompt | `plan-mode-approved.md` enhancement | Post-approval execution uses builder prompt | Open |
| REQ-003 | Add explorer agent (pi-mono-bak explorer) | Agent definition | `explorer.md` + `agents.ts` | `task({ agent: "explorer" })` spawnable | Open |
| REQ-004 | Add fixer agent | Agent definition | `fixer.md` + `agents.ts` | `task({ agent: "fixer" })` spawnable | Open |
| REQ-005 | Add oracle agent | Agent definition | `oracle.md` + `agents.ts` | `task({ agent: "oracle" })` spawnable | Open |
| REQ-006 | Add pre-flight agent | Agent definition | `pre-flight.md` + `agents.ts` | `task({ agent: "pre-flight" })` spawnable | Open |
| REQ-007 | Add verification agent | Agent definition | `verification.md` + `agents.ts` | `task({ agent: "verification" })` spawnable | Open |
| REQ-008 | Update designer agent prompt | Agent definition | `designer.md` body replacement | `task({ agent: "designer" })` spawnable | Open |
| REQ-009 | Update librarian agent prompt | Agent definition | `librarian.md` body replacement | `task({ agent: "librarian" })` spawnable | Open |
| REQ-010 | Remove plan agent, rename explore→explorer | Agent registration | `agents.ts` changes | No `plan` agent, `explorer` resolves | Open |
| REQ-011 | Keep existing ask tool, update prompts to reference it | Prompt adaptation | All `.md` files use `ask` not `question` | No `question` tool references in prompts | Open |
| REQ-012 | Keep reviewer agent (separate from verification) | Agent preservation | `reviewer.md` untouched | `task({ agent: "reviewer" })` still works | Open |
| REQ-013 | Builder prompt enables subagent delegation | Builder prompt content | `plan-mode-approved.md` references agents | Builder can spawn explorer, fixer, etc. | Open |
| REQ-014 | All agents use oh-my-pi model aliases | Frontmatter | `pi/smol`, `pi/slow`, etc. | No `claude-*` model names in agents | Open |
| REQ-015 | All prompts adapted to oh-my-pi conventions | Prompt content | `local://`, `task` tool, `ask` tool | No pi-mono-bak-isms remain | Open |

### Constraints & Boundaries
- **MUST HAVE**: All agents loadable, plan mode functional, builder prompt active post-approval
- **MUST NOT HAVE**: New infrastructure (worktrees, verification loops, `.plans/` directories, new mode state machines, new commands/keybindings)
- **ASSUMPTIONS**:
  - `init.md`, `task.md`, `quick_task.md` remain untouched
  - `reviewer.md` kept as-is (code review agent, separate from verification)
  - Existing plan-mode-subagent.md, plan-mode-reference.md, plan-mode-tool-decision-reminder.md untouched
  - Build mode is achieved via enhanced `plan-mode-approved.md` prompt, NOT a new mode with its own state machine
  - `explore` → `explorer` rename; `plan` agent removed
  - Planner prompt is a single `.md` file with Handlebars template variables, NOT assembled from TypeScript fragments

---

## PHASE 2: HAZARD ANALYSIS & ARCHITECTURE

### Hazard Analysis

| ID | Hazard Description | Severity | Probability | Mitigation Strategy | Abort Trigger | Recovery Path |
|----|-------------------|----------|-------------|---------------------|---------------|---------------|
| H1 | `explore` → `explorer` rename breaks existing `spawns: explore` references | P2-Major | High | Grep all `.md` files for `spawns:.*explore` and update | N/A | Revert rename |
| H2 | Removing `plan` agent breaks external user-facing references | P3-Minor | Medium | Plan agent only used internally; planner prompt replaces | N/A | Re-add plan agent |
| H3 | Large planner prompt (~400 lines) may have Handlebars rendering issues | P2-Major | Low | Test rendering with `prompt.render()` | Build fails | Fix template syntax |
| H4 | New agents not registered in `EMBEDDED_AGENT_DEFS` → runtime `AgentParsingError` | P1-Critical | Low | Explicit registration step in plan | bun check fails | Fix imports/registration |
| H5 | Builder prompt references agents by wrong names → task tool resolution fails | P2-Major | Medium | Cross-reference agent names in builder with registered names | N/A | Fix names |

### Abort & Adaptation Strategy

**Adaptation Protocol**:
- **Test Failures**: Fix the code, document the non-conformance. Do not abort.
- **Missing Dependencies**: Find alternatives or workarounds. Document the deviation.
- **Prompt Rendering Issues**: Fix Handlebars syntax. These are expected to occur and be fixed in-flight.

**Deviation Thresholds** (When to STOP and request re-planning):
- [ ] ABORT if the existing plan mode infrastructure (exit tool, approval flow, session clear) needs structural changes to support the builder prompt
- [ ] ABORT if oh-my-pi's frontmatter parser cannot handle new agent definitions
- [ ] ABORT if `bun check` reveals incompatible type changes needed in agent-session or interactive-mode

---

## PHASE 3: IMPLEMENTATION (Flight Operations)

### Mission Timeline

| Wave | Tasks | Description | Parallel |
|------|-------|-------------|----------|
| Wave 1 | 1-7 | Create all new agent `.md` files + update designer/librarian | YES (7 parallel) |
| Wave 2 | 8-11 | Update `agents.ts` registration, planner prompt, builder prompt, task tool | YES (4 parallel) |
| Wave 3 | 12-15 | Update `init.md`, tool prompts, comment, verify renames | YES (4 parallel) |
| Wave 4 | 16-17 | Run `bun check`, final prompt audit | YES (2 parallel) |

---

## TODOs

- [ ] 1. Create `explorer.md` agent (rename from explore, port pi-mono-bak explorer prompt)

  **File**: `packages/coding-agent/src/prompts/agents/explorer.md`

  **What to do**:
  - Copy current `explore.md` as base (preserve the JTD `output:` schema in frontmatter exactly)
  - Change frontmatter: `name: explorer` (was `name: explore`), keep `model: pi/smol`, `thinking-level: med`, `tools: read, grep, find, web_search`
  - Replace prompt body with pi-mono-bak's explorer prompt style: fast codebase search specialist, returns structured findings. Preserve the `<results><files>...<answer>...` output format guidance from pi-mono-bak
  - Keep oh-my-pi's directives structure (`<directives>`, `<thoroughness>`, `<procedure>`, `<critical>`)
  - Ensure READ-ONLY constraint is present

  **Source reference**: `../pi-mono-bak/packages/coding-agent/agents/explorer.md` for prompt tone; current `explore.md` for frontmatter structure + output schema

  **QA Scenarios**:
  - [ ] Frontmatter parses without error (name, tools, model, output schema all present)
  - [ ] `name: explorer` (not `explore`)
  - [ ] JTD output schema preserved identically (summary, files, architecture)
  - [ ] No `question` or `subagent` tool references
  - [ ] READ-ONLY constraint present

- [ ] 2. Create `fixer.md` agent (new, from pi-mono-bak)

  **File**: `packages/coding-agent/src/prompts/agents/fixer.md`

  **What to do**:
  - Create new agent file with oh-my-pi frontmatter conventions
  - Frontmatter: `name: fixer`, `description: "Fast implementation specialist for executing well-defined code changes"`, `tools: read, write, edit, bash, grep, find, lsp, ast_grep`, `model: pi/smol`, `thinking-level: med`
  - Port prompt body from pi-mono-bak's fixer: fast implementation, receives complete context, executes changes efficiently
  - Adapt: NO external research, NO delegation, structured output (`<summary><changes><verification>`)
  - Use oh-my-pi directive style (`<directives>`, `<critical>`)
  - Must NOT reference `question`, `subagent`, or literal model names

  **Source reference**: `../pi-mono-bak/packages/coding-agent/agents/fixer.md`

  **QA Scenarios**:
  - [ ] Frontmatter parses without error
  - [ ] Tools list uses oh-my-pi names (no `ls` standalone — use `find` or `grep`)
  - [ ] No delegation capabilities (no `spawns:` field)
  - [ ] Structured output guidance present

- [ ] 3. Create `oracle.md` agent (new, from pi-mono-bak)

  **File**: `packages/coding-agent/src/prompts/agents/oracle.md`

  **What to do**:
  - Create new agent file with oh-my-pi frontmatter conventions
  - Frontmatter: `name: oracle`, `description: "Strategic technical advisor for architecture decisions, debugging, and code review guidance"`, `tools: read, grep, find, web_search, lsp, ast_grep`, `model: pi/slow`, `thinking-level: high`
  - Port prompt body from pi-mono-bak's oracle: strategic advisor, 5 Whys root cause analysis, architecture decisions
  - READ-ONLY constraint
  - Use oh-my-pi directive style

  **Source reference**: `../pi-mono-bak/packages/coding-agent/agents/oracle.md`

  **QA Scenarios**:
  - [ ] Frontmatter parses without error
  - [ ] READ-ONLY constraint present (`<critical>` block)
  - [ ] `model: pi/slow` (not `claude-sonnet-4-5`)
  - [ ] No `question` or `subagent` references

- [ ] 4. Create `pre-flight.md` agent (new, from pi-mono-bak)

  **File**: `packages/coding-agent/src/prompts/agents/pre-flight.md`

  **What to do**:
  - Create new agent file with oh-my-pi frontmatter conventions
  - Frontmatter: `name: pre-flight`, `description: "Pre-planning consultant that analyzes requests to identify gaps, risks, and ambiguities before planning begins"`, `tools: read, grep, find, web_search, lsp, ast_grep`, `model: pi/slow`, `thinking-level: high`
  - Port prompt body from pi-mono-bak's pre-flight (~231 lines): Intent Classification (Refactoring/Build/Mid-sized/Collaborative/Architecture/Research), Phase 1 intent-specific analysis, output structure (Intent Classification + Pre-Analysis + Questions + Risks + Directives)
  - READ-ONLY constraint
  - Adapt references: `subagent` → `task` tool, `question` → `ask` tool
  - Use oh-my-pi directive style

  **Source reference**: `../pi-mono-bak/packages/coding-agent/agents/pre-flight.md`

  **QA Scenarios**:
  - [ ] Frontmatter parses without error
  - [ ] READ-ONLY constraint present
  - [ ] No `question`, `subagent`, or `claude-*` references
  - [ ] Intent classification system preserved
  - [ ] Output structure guidance present

- [ ] 5. Create `verification.md` agent (new, from pi-mono-bak — separate from reviewer)

  **File**: `packages/coding-agent/src/prompts/agents/verification.md`

  **What to do**:
  - Create new agent file with oh-my-pi frontmatter conventions
  - Frontmatter: `name: verification`, `description: "Plan reviewer that verifies work plans are executable, references are valid, and no blocking issues exist"`, `tools: read, grep, find, lsp, ast_grep`, `model: pi/slow`, `thinking-level: high`, `blocking: true`
  - Port prompt body from pi-mono-bak's verification (~154 lines): plan review checks (reference verification, executability, critical blockers, QA scenario executability), output [OKAY] or [REJECT] with max 3 blocking issues, approval bias
  - READ-ONLY constraint
  - Adapt: plans are at `local://` paths, not `.plans/` paths. Reference `task` tool not `subagent`
  - Use oh-my-pi directive style

  **Source reference**: `../pi-mono-bak/packages/coding-agent/agents/verification.md`

  **QA Scenarios**:
  - [ ] Frontmatter parses without error
  - [ ] READ-ONLY constraint present
  - [ ] `blocking: true` set (blocks until verification complete)
  - [ ] No `.plans/` path references — uses `local://` or generic plan file references
  - [ ] [OKAY]/[REJECT] output protocol preserved

- [ ] 6. Update `designer.md` agent prompt (enhanced from pi-mono-bak)

  **File**: `packages/coding-agent/src/prompts/agents/designer.md`

  **What to do**:
  - Keep existing oh-my-pi frontmatter (name, model=pi/designer)
  - Replace/enhance prompt body with pi-mono-bak's designer prompt: UI/UX specialist with design principles (typography, color, motion, spatial, depth, styling), plus anti-slop patterns from current oh-my-pi version
  - Merge best of both: pi-mono-bak's structured design principles + oh-my-pi's anti-slop directives
  - Ensure CAN write (not read-only)
  - Use oh-my-pi directive style

  **Source reference**: `../pi-mono-bak/packages/coding-agent/agents/designer.md`, current `designer.md`

  **QA Scenarios**:
  - [ ] Frontmatter unchanged (name=designer, model=pi/designer)
  - [ ] Design principles present (typography, color, motion, spatial)
  - [ ] Anti-slop patterns preserved from current version
  - [ ] Not READ-ONLY (designer writes code)

- [ ] 7. Update `librarian.md` agent prompt (enhanced from pi-mono-bak)

  **File**: `packages/coding-agent/src/prompts/agents/librarian.md`

  **What to do**:
  - Keep existing oh-my-pi frontmatter exactly (name=librarian, model=pi/smol, thinking-level=minimal, tools, JTD output schema)
  - Enhance prompt body with pi-mono-bak's librarian: research specialist for docs/libraries, structured output
  - Preserve oh-my-pi's JTD output schema (answer, sources, api, version, breaking_changes, caveats)
  - Merge best of both: pi-mono-bak's research focus + oh-my-pi's structured output
  - READ-ONLY on project, can clone to /tmp

  **Source reference**: `../pi-mono-bak/packages/coding-agent/agents/librarian.md`, current `librarian.md`

  **QA Scenarios**:
  - [ ] JTD output schema preserved identically
  - [ ] Frontmatter unchanged
  - [ ] Research specialist focus present
  - [ ] READ-ONLY on project constraint

- [ ] 8. Update `agents.ts` — register new agents, remove plan, rename explore→explorer

  **File**: `packages/coding-agent/src/task/agents.ts`

  **What to do**:
  - Add imports for new agent files:
    ```typescript
    import explorerMd from "../prompts/agents/explorer.md" with { type: "text" };
    import fixerMd from "../prompts/agents/fixer.md" with { type: "text" };
    import oracleMd from "../prompts/agents/oracle.md" with { type: "text" };
    import preFlightMd from "../prompts/agents/pre-flight.md" with { type: "text" };
    import verificationMd from "../prompts/agents/verification.md" with { type: "text" };
    ```
  - Remove old imports: `import exploreMd from "../prompts/agents/explore.md"` and `import planMd from "../prompts/agents/plan.md"`
  - Update `EMBEDDED_AGENT_DEFS` array:
    - Replace `{ fileName: "explore.md", template: exploreMd }` with `{ fileName: "explorer.md", template: explorerMd }`
    - Remove `{ fileName: "plan.md", template: planMd }`
    - Add entries for fixer, oracle, pre-flight, verification (all use their `.md` template directly, no programmatic frontmatter needed since frontmatter is in the `.md` files)
  - Keep `designer.md`, `reviewer.md`, `librarian.md`, `task.md`, `quick_task.md` entries unchanged
  - **Delete old files**: `packages/coding-agent/src/prompts/agents/explore.md` and `packages/coding-agent/src/prompts/agents/plan.md`
  - **Update spawns references**: Check `reviewer.md` frontmatter — it has `spawns: explore` which must change to `spawns: explorer`. Grep for `spawns:.*explore` in all agent `.md` files.

  **Source reference**: Current `agents.ts` (lines 1-70 for imports/EMBEDDED_AGENT_DEFS)

  **QA Scenarios**:
  - [ ] `bun check` passes (all imports resolve)
  - [ ] `EMBEDDED_AGENT_DEFS` has entries for: explorer, designer, reviewer, librarian, fixer, oracle, pre-flight, verification, task, quick_task
  - [ ] No `plan.md` or `explore.md` entries remain
  - [ ] `loadBundledAgents()` returns all agents without `AgentParsingError`

- [ ] 9. Create planner system prompt (replaces `plan-mode-active.md`)

  **File**: `packages/coding-agent/src/prompts/system/plan-mode-active.md`

  **What to do**:
  - Replace entire contents of `plan-mode-active.md` with the planner (groundcontrol) system prompt
  - This is a ~350-450 line Handlebars-enabled markdown file
  - **MUST preserve all existing Handlebars template variables**: `{{exitToolName}}`, `{{askToolName}}`, `{{editToolName}}`, `{{writeToolName}}`, `{{planFilePath}}`, `{{planExists}}`, `{{reentry}}`, `{{iterative}}`
  - Content to port from pi-mono-bak's groundcontrol prompt assembly (6 fragments):
    1. **Identity & Constraints**: "You are a PLANNER, not a coder." Strict READ-ONLY enforcement. Plan output to `{{planFilePath}}` (NOT `.plans/` or `.groundcontrol/` — use the existing Handlebars variable). Single plan mandate.
    2. **Interview Mode**: Consultant first, planner second. Use `{{askToolName}}` for interviews. Clearance checklist (core objective, scope, technical approach, test strategy). Draft-as-working-memory (write to plan file incrementally).
    3. **Plan Generation**: PreFlight consultation (reference `task({ agent: "pre-flight", ... })` syntax). Auto-generate plan. Self-review. Gap classification (critical/minor/ambiguous). Summary format.
    4. **High Accuracy Mode**: Verification loop using `task({ agent: "verification", ... })`. [OKAY]/[REJECT] protocol.
    5. **Plan Template**: The canonical plan structure for generated plans.
    6. **Behavioral Summary**: Turn termination rules. Exit via `{{exitToolName}}`.
  - **CRITICAL ADAPTATIONS from pi-mono-bak**:
    - `.plans/` paths → `{{planFilePath}}` (already a Handlebars variable)
    - `.plans/drafts/` → just use `{{planFilePath}}` (no draft directory concept needed — plan file IS the working document)
    - `question` tool → `{{askToolName}}`
    - `subagent({ agent: "X" })` → `task({ agent: "X" })`
    - `.groundcontrol/plans/` → `{{planFilePath}}`
    - `TodoWrite` references → `todo_write` (oh-my-pi convention)
    - Model names: use generic references ("fast model", "slow model"), not literal names
    - Remove any TypeScript/code-specific assembly references
    - Preserve `{{#if iterative}}...{{else}}...{{/if}}` conditional blocks for workflow type
    - Preserve `{{#if reentry}}...{{/if}}` for re-entry flow
    - Preserve `{{#if planExists}}...{{/if}}` for plan file existence check
    - Keep the `<critical>` tag wrapping for key constraints (oh-my-pi pattern)
    - End with: exit via `{{exitToolName}}` when plan is complete, leading to user approval then execution session

  **Source reference**: 
  - `../pi-mono-bak/packages/coding-agent/src/nmc-orbit/prompts/groundcontrol/` (all 6 files)
  - Current `plan-mode-active.md` for Handlebars variable names and conditional structure

  **QA Scenarios**:
  - [ ] All 8 Handlebars variables present: `{{exitToolName}}`, `{{askToolName}}`, `{{editToolName}}`, `{{writeToolName}}`, `{{planFilePath}}`, `{{planExists}}`, `{{reentry}}`, `{{iterative}}`
  - [ ] `{{#if iterative}}` and `{{#if reentry}}` and `{{#if planExists}}` conditionals present
  - [ ] No `.plans/`, `.groundcontrol/`, `question` tool, `subagent` tool references
  - [ ] Plan identity ("You are a PLANNER") clearly stated
  - [ ] READ-ONLY constraint preserved in `<critical>` block
  - [ ] Exit via `{{exitToolName}}` instruction present
  - [ ] PreFlight and Verification agent references use `task({ agent: "..." })` syntax
  - [ ] Plan template section included
  - [ ] Interview/ask workflow included

- [ ] 10. Enhance `plan-mode-approved.md` with builder (orchestrator) prompt

  **File**: `packages/coding-agent/src/prompts/system/plan-mode-approved.md`

  **What to do**:
  - Enhance the existing 23-line prompt with builder/orchestrator capabilities
  - **MUST preserve existing Handlebars variables**: `{{finalPlanFilePath}}`, `{{planContent}}`, and `{{#has tools "todo_write"}}` conditional
  - Add builder identity and delegation capabilities:
    - Define available specialist agents and when to delegate: explorer (codebase search), fixer (fast implementation), designer (UI/UX), librarian (docs/research), oracle (architecture advice), pre-flight (gap analysis), verification (plan review), reviewer (code review)
    - Delegation heuristics from pi-mono-bak orchestrator: 3+ independent tasks → parallel subagents, 1-2 tasks → do yourself, always explore before modifying unfamiliar code, use fixer for well-scoped changes
    - Workflow: Understand → Path Analysis → Delegation Check → Parallelize → Execute → Verify
    - Communication rules: clarity, conciseness, honest pushback
  - Use `task({ agent: "X", prompt: "..." })` syntax for delegation (oh-my-pi's task tool)
  - Keep existing execution mandate ("You MUST execute this plan step by step")
  - Keep `todo_write` tracking requirement
  - Structure: existing execution instructions FIRST, then builder capabilities section

  **Source reference**: 
  - Current `plan-mode-approved.md` (23 lines — preserve structure)
  - `../pi-mono-bak/packages/coding-agent/agents/orchestrator.md` for agent delegation rules
  - `../pi-mono-bak/packages/coding-agent/src/nmc-orbit/prompts/orchestrator.ts` for detailed delegation heuristics

  **QA Scenarios**:
  - [ ] `{{finalPlanFilePath}}` and `{{planContent}}` Handlebars variables present
  - [ ] `{{#has tools "todo_write"}}` conditional preserved
  - [ ] All 8 specialist agents listed with descriptions and delegation guidance
  - [ ] `task({ agent: "..." })` syntax used (not `subagent`)
  - [ ] Execution mandate preserved ("MUST execute step by step")
  - [ ] `todo_write` tracking preserved
  - [ ] No `question`, `subagent`, or `claude-*` references
  - [ ] Delegation heuristics present (when to delegate vs do yourself)

- [ ] 11. Update plan mode subagent tool restriction in `task/index.ts`

  **File**: `packages/coding-agent/src/task/index.ts`

  **What to do**:
  - Find the plan mode tool restriction block (around line 569): `if (planModeState?.enabled)` → restricts tools to `["read", "grep", "find", "ls", "lsp", "web_search"]`
  - Add `"ast_grep"` to the allowed tools list (several new agents need it for code search)
  - This is a minimal change — just expanding the allowed tool list for subagents spawned during plan mode

  **Source reference**: `packages/coding-agent/src/task/index.ts` line ~569

  **QA Scenarios**:
  - [ ] Plan mode subagent tool restriction includes: `read`, `grep`, `find`, `ls`, `lsp`, `web_search`, `ast_grep`
  - [ ] No other changes to `task/index.ts`
  - [ ] `bun check` passes

- [ ] 12. Update `init.md` agent — rename `explore` references to `explorer`

  **File**: `packages/coding-agent/src/prompts/agents/init.md`

  **What to do**:
  - Change `launch multiple explore agents` → `launch multiple explorer agents`
  - This is the only content change to `init.md` — do NOT modify frontmatter or other prompt content

  **QA Scenarios**:
  - [ ] No references to `explore` (as agent name) remain — `explorer` used instead
  - [ ] No other changes to `init.md`

- [ ] 13. Update tool prompts — rename `explore` subagent references to `explorer`

  **Files**: 
  - `packages/coding-agent/src/prompts/tools/ast-grep.md`
  - `packages/coding-agent/src/prompts/tools/grep.md`

  **What to do**:
  - In `ast-grep.md`: change `explore subagent` → `explorer subagent`
  - In `grep.md`: change `explore subagent` → `explorer subagent`
  - These are tool description prompts that reference agent names for delegation guidance

  **QA Scenarios**:
  - [ ] No `explore subagent` references remain in tool prompts — `explorer subagent` used instead
  - [ ] No other changes to these files

- [ ] 14. Update `file-display-mode.ts` comment — rename `explore` reference

  **File**: `packages/coding-agent/src/utils/file-display-mode.ts`

  **What to do**:
  - Change comment `explore agents` → `explorer agents` (line 24)
  - This is a comment-only change

  **QA Scenarios**:
  - [ ] Comment updated
  - [ ] No functional code changes

- [ ] 15. Verify ALL `explore` → `explorer` renames are complete across codebase

  **Commands**:
  ```bash
  # From packages/coding-agent/src/
  grep -rn "explore" --include="*.md" --include="*.ts" . | grep -v "explorer" | grep -v "explored" | grep -v "exploration" | grep -v "urban explorer"
  ```

  **What to verify**: The ONLY remaining hits should be:
  - `compaction/branch-summary-preamble.md` ("explored a different conversation branch" — generic English, not agent name)
  - `plan-mode-subagent.md` ("explore the codebase" — generic verb, not agent name)
  - No agent-name uses of `explore` remain anywhere

  **QA Scenarios**:
  - [ ] Zero agent-name references to `explore` (all should be `explorer`)
  - [ ] Generic English uses of "explore"/"explored" are fine and untouched

---

## Final Verification Wave

### Verification Matrix

| Verification Type | Method | Acceptance Criteria | Status |
|-------------------|--------|---------------------|--------|
| Compilation | `bun check` | Zero errors | Pending |
| Agent Loading | `loadBundledAgents()` returns all agents | No `AgentParsingError` | Pending |
| Prompt Audit | `grep -r "question\|subagent\|claude-\|\.plans/" prompts/ agents/` | Zero hits | Pending |
| Plan Mode E2E | Enter plan mode → planner prompt visible | Planner identity present | Pending |
| Build Mode E2E | Approve plan → builder prompt with delegation | Builder can reference agents | Pending |
| Agent Name Resolution | `task({ agent: "X" })` for each agent | All resolve | Pending |

### Final Verification Tasks

- [ ] 16. Run `bun check` — verify zero compilation errors

  **Command**: `bun check` from repo root

  **What to verify**:
  - All new `.md` imports resolve (no missing file errors)
  - `EMBEDDED_AGENT_DEFS` array type-checks
  - No type errors introduced by agent registration changes
  - All existing tests still compile (don't run them — just type-check)

  **QA Scenarios**:
  - [ ] `bun check` exits with code 0
  - [ ] No TypeScript errors related to agent imports or definitions

- [ ] 17. Audit all `.md` files for stale pi-mono-bak references

  **Commands**:
  ```bash
  # In packages/coding-agent/src/prompts/
  grep -r "question" --include="*.md" . | grep -v "askToolName" | grep -v "clarifying questions"  # should find zero tool references
  grep -r "subagent" --include="*.md" .  # should find zero
  grep -r "claude-" --include="*.md" .   # should find zero literal model names
  grep -r "\.plans/" --include="*.md" .  # should find zero
  grep -r "\.groundcontrol/" --include="*.md" .  # should find zero
  ```

  **What to fix**: Any hits from the above greps must be corrected:
  - `question` (as tool name) → `ask` or `{{askToolName}}`
  - `subagent(...)` → `task(...)`
  - `claude-sonnet-4-5` → remove or use `pi/slow`
  - `claude-haiku-4-5` → remove or use `pi/smol`
  - `.plans/` → `{{planFilePath}}` or `local://`
  - `.groundcontrol/` → remove

  **QA Scenarios**:
  - [ ] Zero grep hits for stale references
  - [ ] All agent `.md` files and system prompt `.md` files clean

---

## Commit Strategy

Single atomic commit:
```
feat(coding-agent): add planner/builder modes and specialist agents

Port plan/build mode prompts and specialist agents from pi-mono-bak:
- Add agents: explorer, fixer, oracle, pre-flight, verification
- Update agents: designer, librarian (enhanced prompts)
- Remove: plan agent (replaced by planner system prompt)
- Rename: explore → explorer
- Enhance plan-mode-approved.md with builder/orchestrator capabilities
- Replace plan-mode-active.md with planner (groundcontrol) prompt
- All prompts adapted to oh-my-pi conventions (model aliases, ask tool, task tool, local://)
```

---

## Success Criteria

- [ ] `bun check` passes
- [ ] All agents discoverable via `loadBundledAgents()` (explorer, designer, fixer, librarian, oracle, pre-flight, verification, reviewer, task, quick_task, init)
- [ ] Plan mode injects planner prompt (not the old generic plan-mode-active)
- [ ] Post-approval injects builder prompt with agent delegation
- [ ] Zero references to `question` tool, `subagent` tool, `claude-*` models, `.plans/` paths
- [ ] `reviewer.md` preserved as code review agent
- [ ] `init.md`, `task.md`, `quick_task.md` untouched
