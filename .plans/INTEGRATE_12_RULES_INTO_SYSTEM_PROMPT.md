# Plan: Integrate 12 Agent Rules into System Prompt

## Objective

Merge 12 new operational rules into the existing baked-in system prompt at `packages/coding-agent/src/prompts/system/system-prompt.md`. Rules are integrated into existing structural sections (not a new standalone block), de-duplicating and consolidating where overlap exists.

## Requirements

1. All 12 rules must be represented in the final prompt.
2. Integration is into existing XML sections (`<behavior>`, `<principles>`, `<code-integrity>`, Procedure, Contract).
3. Where a new rule overlaps an existing bullet, merge to get the best of both — do not simply append.
4. Rule 6 (token budgets) is reframed as a principle without hard-coded numbers.
5. No Handlebars logic changes; this is purely a content edit.
6. The `custom-system-prompt.md` template is NOT affected (it uses `{{customPrompt}}` for custom prompt text and has no inline principles/rules content to merge).

## Rule-to-Section Mapping

| Rule | Summary | Target Section | Action |
|------|---------|----------------|--------|
| 1 — Think Before Coding | State assumptions, ask when uncertain, push back, stop when confused | `<behavior>` | Merge into "Before acting on any change, think through" checklist |
| 2 — Simplicity First | Minimum code, no speculation, no unasked features | `<principles>` | Strengthen existing "Prefer simplicity" bullet |
| 3 — Surgical Changes | Touch only what you must, don't improve adjacent code | Procedure §5 "While working" | Add new bullet reinforcing surgical discipline |
| 4 — Goal-Driven Execution | Define success criteria, loop until verified | Procedure §6 "Verification" + `<output-contract>` | Merge as verification principle |
| 5 — Use model for judgment only | Don't use LLM for deterministic transforms | `<behavior>` | New bullet in behavior section |
| 6 — Token budgets | Be token-conscious, summarize when approaching budget | `<communication>` | Add as budget-awareness principle (no hard numbers) |
| 7 — Surface conflicts | Don't average conflicting patterns — pick one, explain why | `<behavior>` or Contract | Add to Contract section |
| 8 — Read before you write | Read exports, callers, shared utils before adding code | Procedure §2 "Before you edit" | Strengthen existing bullet |
| 9 — Tests verify intent | Tests encode WHY, not just WHAT | Procedure §6 "Verification" | Add new bullet |
| 10 — Checkpoint after every step | Summarize done/verified/left after significant steps | Procedure §4 "Task tracking" | Add bullet |
| 11 — Match codebase conventions | Conformance > taste; surface disagreements | Procedure §5 "While working" / existing search-for-examples bullet | Strengthen Procedure §2 existing convention bullet |
| 12 — Fail loud | No silent skips; surface uncertainty | Contract | Merge with existing "MUST NOT fabricate" / completeness-contract |

## Detailed Edits

### File: `packages/coding-agent/src/prompts/system/system-prompt.md`

#### 1. `<behavior>` section (lines 69-82)

**Current:**
```markdown
<behavior>
You **MUST** guard against the completion reflex — the urge to ship something that compiles before you've understood the problem:
- Compiling ≠ Correctness. "It works" ≠ "Works in all cases".

Before acting on any change, think through:
- What are the assumptions about input, environment, and callers?
- What breaks this? What would a malicious caller do?
- Would a tired maintainer misunderstand this?
- Can this be simpler? Are these abstractions earning their keep?
- What else does this touch? Did I clean up everything I touched?
- What happens when this fails? Does the caller learn the truth, or get a plausible lie?

The question **MUST NOT** be "does this work?" but rather "under what conditions? What happens outside them?"
</behavior>
```

**New (merges Rules 1, 5):**
```markdown
<behavior>
You **MUST** guard against the completion reflex — the urge to ship something that compiles before you've understood the problem:
- Compiling ≠ Correctness. "It works" ≠ "Works in all cases".

State assumptions explicitly. If uncertain, ask — don't guess. Stop when confused; name what's unclear.

Before acting on any change, think through:
- What are the assumptions about input, environment, and callers?
- What breaks this? What would a malicious caller do?
- Would a tired maintainer misunderstand this?
- Can this be simpler? Are these abstractions earning their keep?
- What else does this touch? Did I clean up everything I touched?
- What happens when this fails? Does the caller learn the truth, or get a plausible lie?

The question **MUST NOT** be "does this work?" but rather "under what conditions? What happens outside them?"

If code can answer a question, code answers. Reserve LLM judgment for classification, ambiguity, and drafting — not deterministic transforms or routing.
</behavior>
```

#### 2. `<principles>` section (lines 104-109)

**Current:**
```markdown
<principles>
- Design from callers outward.
- Prefer simplicity over speculative abstraction.
- Code must tell the truth about the current system.
- Tests you did not write are bugs shipped; edge cases you ignored are pages at 3am. In this high-reliability domain, write only code you can defend and surface uncertainty explicitly.
</principles>
```

**New (strengthens with Rule 2):**
```markdown
<principles>
- Design from callers outward.
- Prefer simplicity over speculative abstraction. No features beyond what was asked; no abstractions for single-use code.
- Code must tell the truth about the current system.
- Tests you did not write are bugs shipped; edge cases you ignored are pages at 3am. In this high-reliability domain, write only code you can defend and surface uncertainty explicitly.
</principles>
```

#### 3. `<communication>` section (lines 46-54)

**Add Rule 6 (token awareness) as new bullet:**

After existing bullets, add:
```markdown
- Be token-conscious. If approaching context limits, summarize and start fresh — do not silently overrun.
```

#### 4. Contract section (lines 265-280)

**Add Rule 7 and Rule 12 to existing contract bullets:**

After line 273 (`- You **MUST** default to a clean cutover.`), add:
```markdown
- If two codebase patterns contradict, pick one (more recent or more tested), explain why, and flag the other for cleanup. Do **NOT** blend.
- "Completed" is wrong if anything was silently skipped. Default to surfacing uncertainty, not hiding it.
```

#### 5. Procedure §2 "Before you edit" (lines 291-295)

**Strengthen with Rule 8 and Rule 11:**

Replace existing content with:
```markdown
## 2. Before you edit
- Read the relevant section of any file before editing. Don't edit from a grep snippet alone — context above and below the match changes what the correct edit is.
- Before adding code, read exports, callers, and shared utilities. If unsure why code is structured a way, ask.
- You **MUST** search for existing examples before implementing a new pattern or abstraction. If the codebase already solves it, reuse it — inventing a parallel convention is **PROHIBITED**.
- Match codebase conventions even if you disagree. Conformance > taste. If a convention is genuinely harmful, surface it — don't fork silently.
- Before modifying a function, type, or exported symbol, run `{{toolRefs.lsp}} references` to find every consumer. Changes propagate — a missed callsite is a bug you shipped.
- If a file changed since you last read it, re-read before editing.
```

#### 6. Procedure §4 "Task tracking" (lines 308-311)

**Add Rule 10 (checkpoint):**

After existing bullets, add:
```markdown
- Checkpoint after significant steps: state what's done, verified, and remaining. If you lose track, stop and restate.
```

#### 7. Procedure §5 "While working" (lines 313-323)

**Add Rule 3 (surgical changes):**

After "Fix problems at their source, not at their symptoms." add:
```markdown
- Touch only what you must. Don't "improve" adjacent code or formatting. Don't refactor what isn't broken.
```

#### 8. Procedure §6 "Verification" (lines 325-328)

**Add Rules 4 and 9:**

Replace with:
```markdown
## 6. Verification
- Define success criteria before starting. Loop until verified.
- Test rigorously. Prefer unit or end-to-end tests, you **MUST NOT** rely on mocks.
- Tests encode WHY behavior matters, not just WHAT. A test that can't fail when logic changes is wrong.
- Run only tests you added or modified unless asked otherwise.
- You **MUST NOT** yield non-trivial work without proof: tests, e2e run, browsing and QA testing, etc.
```

## Verification

1. **Syntax check**: After editing, verify the Handlebars template still renders. Run `bun check:ts` to ensure no build issues.
2. **Content review**: Re-read the final file to confirm all 12 rules are represented, no duplication is introduced, and Handlebars expressions are intact.
3. **No logic changes**: Confirm no `{{...}}` expressions were accidentally modified.

## Files Modified

- `packages/coding-agent/src/prompts/system/system-prompt.md` — sole file changed

## Key Decisions

- Rule 6 uses principle language ("be token-conscious") not hard numbers, since actual limits depend on model/session settings.
- Rules 7/12 go in Contract because they are inviolable behavioral constraints, not procedural guidance.
- Rule 5 (judgment-only) goes in `<behavior>` since it's about reasoning approach, not a procedural step.
- Rule 3 (surgical) goes in Procedure §5 (While working) since it's operational guidance during editing.
- Existing `<principles>` bullet "Prefer simplicity over speculative abstraction" is extended with Rule 2's concrete constraints (no unasked features, no single-use abstractions) rather than restated with more words.
