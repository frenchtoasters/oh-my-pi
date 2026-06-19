# Session-Level Worktree Isolation

## Objective

Enable multiple independent omp sessions to work in parallel on the same mono-repo without file conflicts, by giving each session its own git worktree. This feature lets you run session A on `packages/auth`, session B on `packages/api`, and session C on the main checkout — all simultaneously, all isolated.

## Background & Existing Infrastructure

### What Already Exists

| Component | Location | Purpose |
|-----------|----------|---------|
| `/move <path>` command | `src/slash-commands/builtin-registry.ts:655` | Moves session to arbitrary dir |
| `SessionManager.moveTo(newCwd)` | `src/session/session-manager.ts:1964` | Migrates session files, updates header cwd |
| `ensureWorktree(baseCwd, id)` | `src/task/worktree.ts:50` | Creates detached worktree at `~/.omp/wt/<encoded-project>/<id>` |
| `captureBaseline()` / `applyBaseline()` | `src/task/worktree.ts:107,136` | Captures/restores dirty state (staged, unstaged, untracked) |
| `setProjectDir()` | `packages/utils/src/dirs.ts:87` | Updates global project dir + `process.chdir()` |
| `getWorktreeDir(segment)` | `packages/utils/src/dirs.ts:326` | Resolves `~/.omp/wt/<segment>` |
| Worktree CLI | `src/cli/worktree-cli.ts` | Lists/cleans orphaned worktrees |
| `ToolSession.cwd` | `src/tools/index.ts:118` | String property read by all tools for path resolution |
| `handleMoveCommand()` | `src/modes/controllers/command-controller.ts:951` | Validates dir, calls flush+moveTo, updates project dir |

### Critical Architecture Facts

1. **ToolSession.cwd is captured at creation** — assigned once from `options.cwd ?? getProjectDir()` in `sdk.ts:976`. It's a plain `string` on a shared object reference. Currently NEVER re-assigned after `/move`.

2. **CWD propagation after `/move` relies on `process.chdir()`** — `setProjectDir()` calls `process.chdir()`, so `process.cwd()` changes. But tools use `this.session.cwd` (the captured value), NOT `process.cwd()`.

3. **Bug in existing `/move`**: After `/move`, `toolSession.cwd` still points to the old directory. Tools resolve paths against the stale value. This works *coincidentally* if the tool's `cwd` parameter is absolute, but breaks for relative paths.

4. **Worktrees are currently task-scoped** — created per-task, ephemeral, cleaned up immediately after task completion. Branch naming: `omp/task/<taskId>`.

5. **Session persistence** — NDJSON file at `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. The `cwd` field in the session header is what's restored on resume.

## Design Decisions

### D1: Session Worktree vs. Process-Level Isolation

**Decision**: Session-level worktree (one worktree per session that uses isolation).

**Rationale**: Process-level isolation (one omp process per worktree) is simpler conceptually but requires no code changes — users can already `cd` into a worktree and run `omp`. The value of this feature is making it seamless *within* the tool: create worktree, move session, capture changes, merge back — all through slash commands.

### D2: Worktree Lifecycle

**Decision**: Session worktrees are long-lived (persist across session resume) and explicitly cleaned up via `/worktree remove` or `omp worktree clear`.

**Rationale**: Unlike task worktrees (ephemeral sandboxes), session worktrees represent ongoing work streams. Users may resume a session days later and expect the worktree to still exist.

### D3: Branch Strategy

**Decision**: Each session worktree gets a named branch `omp/session/<slug>` (not detached HEAD like task worktrees).

**Rationale**: Named branches make it easy to see what's happening in `git branch -a`, support standard merge/rebase workflows, and survive gc.

### D4: Dirty State Transfer

**Decision**: Reuse `captureBaseline()` / `applyBaseline()` from existing worktree module to optionally transfer uncommitted changes when moving into a worktree.

### D5: ToolSession.cwd Update

**Decision**: Fix the CWD propagation gap. After `/move` or `/worktree`, mutate `toolSession.cwd` directly (it's a shared object reference — all tools see the update immediately).

**Rationale**: This is a bug fix regardless of the worktree feature. The field is mutable by design (interface, not readonly). All tools read from the same object.

### D6: Naming Convention

Worktree directory: `~/.omp/wt/<encoded-project>/session-<slug>`
Branch: `omp/session/<slug>`
Slug: user-provided name or auto-generated short slug (e.g., `auth-refactor`, `api-v2`)

---

## Implementation Plan

### Phase 1: Fix CWD Propagation (Bug Fix)

**Files:**
- `packages/coding-agent/src/modes/controllers/command-controller.ts`
- `packages/coding-agent/src/sdk.ts`

**Changes:**
1. In `sdk.ts`, expose the `toolSession` object on the result or pass a `setCwd` callback into the session context so `handleMoveCommand` can update it.
2. In `handleMoveCommand()` (command-controller.ts:979), after `moveTo()` succeeds, also update the live `toolSession.cwd` value.

**Approach**: The cleanest path is to expose a `updateToolSessionCwd(newCwd: string)` function from `createAgentSession()` that mutates the shared `toolSession.cwd`. The interactive mode context already has access to the session result object.

---

### Phase 2: Session Worktree Module

**Files:**
- `packages/coding-agent/src/session/session-worktree.ts` (NEW)

**Changes:**
Create a module that manages session-level worktrees with these functions:

```typescript
/** Create a new session worktree for the given repo. */
export async function createSessionWorktree(
  repoRoot: string,
  slug: string,
  options?: { transferDirtyState?: boolean }
): Promise<{ worktreeDir: string; branch: string }>

/** List session worktrees for a project. */
export async function listSessionWorktrees(repoRoot: string): Promise<SessionWorktreeInfo[]>

/** Remove a session worktree (with safety check for uncommitted changes). */
export async function removeSessionWorktree(
  repoRoot: string,
  slug: string,
  options?: { force?: boolean }
): Promise<void>

/** Merge a session worktree branch back to the source branch. */
export async function mergeSessionWorktree(
  repoRoot: string,
  slug: string,
  options?: { strategy?: "merge" | "rebase" | "squash" }
): Promise<MergeResult>
```

Key behaviors:
- `createSessionWorktree`: `git worktree add -b omp/session/<slug> <dir> HEAD` (checked out, not detached)
- Captures baseline from main checkout if `transferDirtyState` is true
- Applies baseline into the new worktree
- Uses `getWorktreeDir(path.join(encodedProject, `session-${slug}`))`

---

### Phase 3: `/worktree` Slash Command

**Files:**
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` (register command)
- `packages/coding-agent/src/modes/controllers/command-controller.ts` (handler)

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `/worktree new <name>` | Create a new session worktree with the given slug, move session into it |
| `/worktree list` | Show all session worktrees for the current project |
| `/worktree switch <name>` | Switch this session to an existing worktree |
| `/worktree merge [name]` | Merge worktree branch back to parent (default: current) |
| `/worktree remove <name>` | Remove a worktree (fails if uncommitted changes unless --force) |

**Flow for `/worktree new <name>`:**
1. Detect repo root from current CWD
2. Check if working tree is dirty (`git status`); if so, prompt user: "Transfer uncommitted changes to the new worktree? (y/n)"
3. Call `createSessionWorktree(repoRoot, name, { transferDirtyState: userChoice })`
4. Call `handleMoveCommand(worktreeDir)` (reuses existing move infrastructure)
5. Persist worktree metadata in session header (new optional field: `worktreeSlug`)

---

### Phase 4: Session Header Extension

**Files:**
- `packages/coding-agent/src/session/session-manager.ts`

**Changes:**
1. Add optional `worktreeSlug?: string` and `worktreeRepoRoot?: string` to `SessionHeader` type
2. Populate on `/worktree new` or `/worktree switch`
3. On session resume: validate worktree still exists. If not, warn user and fall back to repo root.
4. On session list: show worktree indicator (e.g., `[wt: auth-refactor]`)

---

### Phase 5: Worktree CLI Enhancement

**Files:**
- `packages/coding-agent/src/cli/worktree-cli.ts`

**Changes:**
1. Add `"session-worktree"` to `WorktreeKind` type
2. Update `classifyDir()` to detect session worktrees (branch prefix `omp/session/`)
3. Show session worktrees differently in `omp worktree list` (with session info if available)
4. `omp worktree clear` should NOT remove session worktrees unless `--all` is passed (they're intentionally long-lived)

---

### Phase 6: Status Line & UX

**Files:**
- `packages/coding-agent/src/modes/interactive-mode.ts` (status line)
- `packages/coding-agent/src/modes/controllers/command-controller.ts` (move confirmation)

**Changes:**
1. When session is in a worktree, show `[wt: <slug>]` in the status line (next to the branch indicator)
2. On session start/resume in a worktree, display a one-line notice: `Working in worktree: <slug> (branch: omp/session/<slug>)`
3. On `/worktree new`, confirm success with the path and branch name

---

### Phase 7: Merge Workflow

**Files:**
- `packages/coding-agent/src/session/session-worktree.ts` (merge logic)
- `packages/coding-agent/src/modes/controllers/command-controller.ts` (handler)

**Changes:**

`/worktree merge` flow:
1. Commit all current changes in the worktree (or fail if nothing to merge)
2. Switch strategy based on user preference or setting:
   - **merge**: `git merge omp/session/<slug>` from the parent branch
   - **rebase**: `git rebase <parent-branch>` in the worktree, then fast-forward merge
   - **squash**: `git merge --squash omp/session/<slug>` from parent
3. After successful merge, optionally move session back to main checkout and clean up

Configuration: `task.worktree.mergeStrategy` setting (default: `"merge"`)

---

### Phase 8: Subagent Worktree Propagation

**Files:**
- `packages/coding-agent/src/task/index.ts`
- `packages/coding-agent/src/task/worktree.ts`

**Changes:**
1. When a session is in a worktree, the task executor should pass the session's worktree dir as `baseCwd` to `ensureWorktree()` instead of the original repo root.
2. In `packages/coding-agent/src/task/index.ts` (around line 914 where `ensureWorktree` is called), check if the session has an active worktree and use that as the base.
3. This means subagent task-isolation worktrees are created relative to the session worktree, so their diffs apply cleanly back into the session's working copy.

---

## File Summary

| File | Action | Phase |
|------|--------|-------|
| `src/modes/controllers/command-controller.ts` | Edit: fix CWD propagation, add worktree handlers | 1,3,6,7 |
| `src/sdk.ts` | Edit: expose CWD update callback | 1 |
| `src/session/session-worktree.ts` | **New**: session worktree lifecycle module | 2 |
| `src/slash-commands/builtin-registry.ts` | Edit: register `/worktree` command | 3 |
| `src/session/session-manager.ts` | Edit: add worktreeSlug to header, expose in list | 4 |
| `src/cli/worktree-cli.ts` | Edit: classify session worktrees | 5 |
| `src/modes/interactive-mode.ts` | Edit: status line worktree indicator | 6 |
| `src/config/settings-schema.ts` | Edit: add `task.worktree.mergeStrategy` setting | 7 |
| `src/task/index.ts` | Edit: use session worktree as baseCwd for subagent isolation | 8 |
| `src/task/worktree.ts` | Edit: no structural change, just called with different baseCwd | 8 |

All paths relative to `packages/coding-agent/`.

---

## Verification

### Phase 1 Verification
- Start session, `/move /tmp/test-dir`, confirm tool paths resolve to new dir
- Verify `toolSession.cwd` reflects the new path (add a debug log or test)

### Phase 2 Verification
- Unit test: `createSessionWorktree` produces a worktree with correct branch
- Unit test: `listSessionWorktrees` returns created worktrees
- Unit test: `removeSessionWorktree` cleans up fs + git
- Integration: create worktree, make changes, verify they're isolated from main

### Phase 3 Verification
- `/worktree new test-feature` → creates worktree, moves session, status shows `[wt: test-feature]`
- `/worktree list` → shows the new worktree
- `/worktree switch` → moves to existing worktree

### Phase 4 Verification
- Resume a session that was in a worktree → restores into the worktree CWD
- Resume with deleted worktree → warns and falls back

### Phase 5 Verification
- `omp worktree list` shows session worktrees with `(session)` label
- `omp worktree clear` skips session worktrees (without `--all`)

### Phase 7 Verification
- Create worktree, make changes, `/worktree merge` → changes appear on parent branch
- Conflict detection works (doesn't silently corrupt)

---

## Resolved Questions

1. **Dirty state transfer UX**: **Prompt the user** — ask whether to move uncommitted changes to the new worktree or leave them in place.

2. **Auto-commit before merge**: **Auto-commit** uncommitted changes with a generated message (matches task isolation behavior). No confirmation needed.

3. **Subagent propagation**: **Yes** — subagent task isolation continues to create its own worktrees, but uses the session's worktree as the base `repoRoot` (not the original main checkout).

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Worktree left dangling on crash | Disk waste, confusing git state | `omp worktree clear` already handles orphans; add session-worktree classification |
| Merge conflicts | Blocked merge workflow | Detect conflicts, report to user, don't auto-resolve |
| CWD propagation missed in some code path | Tools operate in wrong directory | The fix is a single assignment; add a test that asserts all tools see the updated CWD |
| Session resume with missing worktree | Session starts in nonexistent dir | Validate on resume, warn + fallback to repo root |
| Multiple sessions in same worktree | Race conditions on files | Allow it (git handles concurrent reads fine) but warn. This is the user's choice. |