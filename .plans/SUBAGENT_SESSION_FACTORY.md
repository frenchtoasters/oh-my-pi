# Plan: Subagent Session Factory (Fork-Based Spawn)

## Objective

Reduce subagent spawn time from ~8-15s to ~1-3s by creating a **session factory** that pre-computes all immutable/shareable artifacts once (at parent init or first subagent spawn) and stamps out lightweight subagent sessions from the cached template — eliminating redundant I/O, discovery, and rebuild work per child.

## Problem Statement

Each subagent today rebuilds expensive immutable artifacts that are identical across siblings:
- **Extensions discovery** (~200-500ms): filesystem scan + factory invocation
- **Rules discovery** (~100ms): filesystem scan + categorization
- **Workspace tree** (~100-300ms): directory enumeration
- **AGENTS.md search** (~200-400ms): recursive glob
- **System prompt base** (~800ms-2s): tool metadata + template rendering
- **Custom tool/command discovery** (~100-500ms): filesystem scan
- **ModelRegistry.refresh()** (~500-1s): called even when parent's registry is passed
- **Slash command discovery** (~50ms): filesystem scan

These are **deterministic given the same CWD + settings** — identical results for every sibling subagent.

## Architecture Decision

**Approach: `SubagentSessionFactory`** — a class instantiated once per parent session (lazily on first `task` tool use) that caches pre-computed discovery results and provides a fast `spawn()` method.

### Rejected Alternatives

| Alternative | Reason Rejected |
|---|---|
| OS-level fork() | Platform-dependent (no Windows), Bun doesn't support it cleanly, complicates GC/handles |
| Tool instance sharing | Tools bind to ToolSession at construction; refactoring AgentTool interface is too invasive |
| Full session cloning | AgentSession holds mutable state (message history, event listeners); copy semantics are fragile |
| Worker thread pool | Adds IPC overhead; tools need main-thread access (filesystem, MCP connections) |

### What IS Shareable (Immutable After Construction)

| Artifact | Current Cost | Sharing Mechanism |
|---|---|---|
| AuthStorage | ~200ms (disk) | Pass from parent (already done) |
| ModelRegistry | ~500-1s (refresh) | Pass from parent, **skip redundant refresh()** |
| Settings | ~100ms (disk) | Pass snapshot (already done via createSubagentSettings) |
| MCP connections | 2-8s (processes) | Pass MCPManager + proxy tools (already done) |
| Skills | ~100-500ms (disk) | Pass from parent (already done) |
| ContextFiles | ~50ms (disk) | Pass from parent (already done) |
| PromptTemplates | ~50ms (disk) | Pass from parent (already done) |
| Extensions (discovery result) | ~200-500ms | **NEW: cache LoadExtensionsResult, pass as preloadedExtensions** |
| Rules | ~100ms | **NEW: cache discovered rules, pass as options.rules** |
| SlashCommands | ~50ms | **NEW: cache discovered commands, pass as options.slashCommands** |
| Workspace tree (Promise) | ~100-300ms | **NEW: cache result, pass pre-resolved promise** |
| AGENTS.md search (Promise) | ~200-400ms | **NEW: cache result, pass pre-resolved promise** |
| System prompt base template | ~800ms-2s | **NEW: partially cache — see Phase 3** |
| Custom commands | ~100-500ms | **NEW: pass `disableExtensionDiscovery: true` when unneeded** |

### What MUST Be Per-Session (Mutable / Identity-Bound)

| Artifact | Reason |
|---|---|
| Tool instances | ToolSession binds session identity (agentId, sessionId, cwd) |
| AgentSession | Holds mutable message history, event listeners, tool choice queue |
| SessionManager | Unique session file per subagent |
| ToolSession object | Callbacks bound to specific session (getAgentId, getSessionFile) |
| InternalUrlRouter | Registers per-session protocol handlers |
| AsyncJobManager | Per-session background job tracking |
| Agent instance | Per-session model state, message history |

## Design

### New Type: `SubagentSessionFactory`

```typescript
// packages/coding-agent/src/task/session-factory.ts

export interface SubagentSessionFactoryOptions {
  cwd: string;
  settings: Settings;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  mcpManager?: MCPManager;
  eventBus?: EventBus;
  contextFiles: ContextFileEntry[];
  skills: Skill[];
  promptTemplates: PromptTemplate[];
}

export interface CachedDiscovery {
  cwd: string; // The CWD these discoveries were computed for
  rules: Rule[];
  slashCommands: FileSlashCommand[];
  preloadedExtensions: LoadExtensionsResult;
  workspaceTree: WorkspaceTree;
  agentsMdSearch: AgentsMdSearch;
}

export class SubagentSessionFactory {
  #options: SubagentSessionFactoryOptions;
  #cached?: CachedDiscovery;
  #warmPromise?: Promise<CachedDiscovery>;

  constructor(options: SubagentSessionFactoryOptions) { ... }

  /** Pre-compute all cacheable artifacts for parent's CWD. Idempotent. */
  async warm(): Promise<void> { ... }

  /**
   * Spawn a subagent session.
   * If effectiveCwd matches the cached CWD, uses cached workspace tree + AGENTS.md.
   * Otherwise, those are re-discovered for the target CWD (extensions/rules/slash commands
   * are still reusable since they come from user/project config dirs, not CWD content).
   */
  async spawn(spawnOptions: SubagentSpawnOptions): Promise<CreateAgentSessionResult> { ... }
}
```

### Integration Point

The factory is created and stored in the parent's `ToolSession` or `AgentSession`. The `TaskTool` (or `runSubprocess`) calls `factory.spawn()` instead of directly calling `createAgentSession()`.

## Implementation Phases

### Phase 1: Eliminate Redundant ModelRegistry.refresh()

**Files**: `packages/coding-agent/src/task/executor.ts`

The executor already passes `options.modelRegistry` from the parent. But at line 954-955, it still does:
```typescript
const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
await modelRegistry.refresh();  // <-- redundant when parent's registry is passed
```

**Change**: Skip `refresh()` when the registry was provided by the parent (it's already refreshed).

```typescript
const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
if (!options.modelRegistry) {
  await modelRegistry.refresh();
}
```

**Estimated gain**: 500ms-1s per subagent.

### Phase 2: Pass Pre-Computed Discovery Results

**Files**:
- `packages/coding-agent/src/task/executor.ts` (ExecutorOptions + runSubprocess)
- `packages/coding-agent/src/task/index.ts` (TaskTool passes discoveries)
- `packages/coding-agent/src/sdk.ts` (createAgentSession accepts new options)

**Changes**:
1. Add `rules`, `slashCommands`, `preloadedExtensions`, and `disableExtensionDiscovery` to `ExecutorOptions`
2. In `TaskTool#executeSync`, capture these from the parent session and pass them through
3. In `runSubprocess`, forward them to `createAgentSession`
4. `createAgentSession` already handles `rules`, `slashCommands`, `preloadedExtensions`, and `disableExtensionDiscovery` — no changes needed inside it

**Estimated gain**: 300-800ms per subagent (extension + rule + slash command discovery eliminated).

### Phase 3: Cache Workspace Tree and AGENTS.md Search (CWD-Gated)

**Files**:
- `packages/coding-agent/src/sdk.ts` (new options for pre-computed promises)
- `packages/coding-agent/src/task/executor.ts` (pass cached results)
- `packages/coding-agent/src/task/index.ts` (capture from parent session)

**Changes**:
1. Add `agentsMdSearch?: AgentsMdSearch` and `workspaceTree?: WorkspaceTree` to `CreateAgentSessionOptions`
2. In `createAgentSession`, use provided values instead of re-scanning:
   ```typescript
   const agentsMdSearchPromise = options.agentsMdSearch
     ? Promise.resolve(options.agentsMdSearch)
     : logger.time("buildAgentsMdSearch", buildAgentsMdSearch, cwd);
   const workspaceTreePromise = options.workspaceTree
     ? Promise.resolve(options.workspaceTree)
     : logger.time("buildWorkspaceTree", buildWorkspaceTree, cwd);
   ```
3. Expose `agentsMdSearch` and `workspaceTree` from the parent session (or compute once and cache)
4. Pass from executor **only when effective CWD matches parent CWD**:
   ```typescript
   const effectiveCwd = worktree ?? cwd;
   const cwdMatchesParent = path.resolve(effectiveCwd) === path.resolve(parentCwd);
   // Workspace tree and AGENTS.md are CWD-relative — only reuse if same directory
   const agentsMdSearch = cwdMatchesParent ? cachedAgentsMdSearch : undefined;
   const workspaceTree = cwdMatchesParent ? cachedWorkspaceTree : undefined;
   ```

**CWD matching rule**: Workspace tree and AGENTS.md describe directory **content**, so they
are only valid for the exact CWD they were computed against. When a subagent runs in a
worktree, subdirectory, or different project, these must be re-discovered. Extensions, rules,
and slash commands come from config directories (user-level `~/.omp/` and project-level
`.omp/agents/`) which are resolved by walking up from CWD — so they are valid as long as
the subagent is within the same project root. For worktrees of the same repo, the same
`.omp/` config dir is found, so these remain valid.

**Estimated gain**: 300-700ms per subagent (when CWD matches, which is the common case).

### Phase 4: SubagentSessionFactory Class

**Files**:
- `packages/coding-agent/src/task/session-factory.ts` (NEW)
- `packages/coding-agent/src/task/index.ts` (TaskTool uses factory)
- `packages/coding-agent/src/task/executor.ts` (runSubprocess accepts pre-warmed cache)
- `packages/coding-agent/src/session/agent-session.ts` (expose discovery results for caching)

**Changes**:
1. Create `SubagentSessionFactory` class that:
   - Takes parent's shared resources (auth, registry, MCP, settings, skills, etc.)
   - Stores parent CWD for cache validity checks
   - On `warm()`: runs extension discovery, rule discovery, workspace tree, AGENTS.md search **once**
   - On `spawn()`: passes cached results to `createAgentSession`, with CWD-gating for workspace tree and AGENTS.md
2. TaskTool lazily creates the factory on first task invocation and reuses it for all subsequent spawns
3. Factory cache validity rules:
   - **Always reusable** (CWD-independent): extensions, rules, slash commands (config-dir-based discovery)
   - **CWD-gated** (only when effectiveCwd === factory.cwd): workspace tree, AGENTS.md search
   - If effectiveCwd differs, workspace tree and AGENTS.md are left as `undefined` → `createAgentSession` re-discovers them for the target CWD

**Estimated gain**: Full cumulative benefit — subsequent same-CWD subagent spawns skip all cached discovery. Different-CWD spawns still benefit from extension/rule/slash command caching.

### Phase 5: Custom Command Discovery Opt-Out

**Files**:
- `packages/coding-agent/src/sdk.ts` (skip custom commands for subagents)

**Changes**:
1. When `disableExtensionDiscovery: true` is set (which already exists), also skip `loadCustomCommandsInternal` (currently this is partially done at line 1276-1278 but only for the outer conditional)
2. Subagents don't need custom slash commands (no interactive UI)

**Estimated gain**: 50-200ms per subagent.

## Critical Files to Modify

| File | Changes |
|---|---|
| `packages/coding-agent/src/task/executor.ts` | Skip redundant refresh(), accept/forward cached discovery |
| `packages/coding-agent/src/task/index.ts` | Capture parent discoveries, instantiate factory, pass to executor |
| `packages/coding-agent/src/sdk.ts` | Accept `agentsMdSearch`, `workspaceTree` options; short-circuit discovery |
| `packages/coding-agent/src/task/session-factory.ts` | **NEW**: SubagentSessionFactory class |
| `packages/coding-agent/src/session/agent-session.ts` | Expose cached discovery results (rules, extensions, workspace tree, AGENTS.md) |

## Verification

### Correctness
- All existing task/subagent tests pass (`bun test packages/coding-agent/test/task/`)
- Subagents produce identical outputs whether using cached or fresh discovery
- Factory invalidates properly when CWD or settings change
- **CWD-gating**: subagent spawned with `worktree` or different CWD does NOT receive parent's cached workspace tree or AGENTS.md — it re-discovers them fresh
- Subagent spawned in same CWD as parent DOES receive cached workspace tree and AGENTS.md

### Performance
- Add `PI_TIMING=1` benchmarks comparing before/after spawn times
- Measure time-to-first-LLM-token for subagent spawns
- Target: <3s from task invocation to first LLM streaming token (down from 8-15s)

### Regression
- `bun check:ts` passes (type safety)
- Isolated mode (worktree/fuse) still works correctly with cached discoveries
- MCP proxy tools still function via shared MCPManager
- Extension-registered models still available in subagents

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Stale cache if files change during session | Factory uses parent session's discovery results; same staleness window as parent. Acceptable. |
| Extension runtime state leakage | `preloadedExtensions` passes the discovery result, not the runtime. Each subagent still creates its own ExtensionRuntime with fresh `flagValues`. |
| Subagent runs in different CWD (worktree, subdirectory, different project) | **CWD-gating**: workspace tree and AGENTS.md are only passed from cache when `effectiveCwd === factory.cwd`. When CWD differs, these are left `undefined` and re-discovered fresh for the target CWD. Extensions/rules/slash commands are config-dir-based (walk up from CWD to find `.omp/`) so they remain valid for any CWD within the same project root. For truly different projects, even these should be re-discovered — add a `projectRoot` check (resolve nearest `.git` root) as the cache key. |
| ModelRegistry mutation after cache | Parent's registry is passed by reference (already the case). Mutations (extension-registered models) are visible to children. No change from current behavior. |
| Git worktree has different absolute path but same content | Worktrees are checkouts of same commit — same AGENTS.md files, same directory structure. However, `buildWorkspaceTree` may embed absolute paths or render from CWD root, so we still gate on CWD match. This means worktree-isolated tasks re-discover workspace tree (safe, ~200ms cost), but still benefit from extension/rule/model caching. |

## Sequencing

Phases 1-3 are independent, low-risk, and deliver immediate value. They can be implemented and merged separately.

Phase 4 (factory class) builds on 1-3 and adds the caching/warm infrastructure.

Phase 5 is independent and trivial.

**Recommended order**: Phase 1 → Phase 2 + 3 (parallel) → Phase 4 → Phase 5
