# Process Sandbox: In-Process napi-rs Integration via pre_exec Hook + Domain-Level Network Allowlists

## Objective

Add opt-in OS-enforced sandboxing to spawned commands using `nono` (Landlock on Linux, Seatbelt on macOS). Two enforcement layers:
1. **Filesystem + network kernel enforcement** — applied per-command via `pre_exec` in the forked child. Zero extra processes, zero runtime overhead, inherits naturally to all grandchildren.
2. **Domain-level network allowlists** — `nono-proxy` CONNECT tunnel running in the main process filters outbound HTTPS by hostname. Child processes get `NetworkMode::ProxyOnly` (kernel blocks all TCP except proxy port) + `HTTPS_PROXY` env var pointing to the proxy.
3. **In-process file tool enforcement** — `SandboxCaps.queryPath()` blocks read/write/edit tools from accessing paths outside the active profile.

## Decision: pre_exec in brush-core-vendored

The existing shell executes commands through `brush-core-vendored`, which already uses `std::process::Command::pre_exec()` hooks for process group management (`take_foreground`, `detach_session`). Adding a sandbox `pre_exec` is the **absolute minimum code path** — it requires no bootstrap scripts, no extra binaries, no CLI wrappers. The sandbox is applied in the forked child between `fork()` and `exec()`, exactly where kernel enforcement (Landlock/Seatbelt) takes effect.

**Prior plan (saved):** `local://PROCESS_SANDBOX_PLAN.md` describes the alternative `nono-ts` + `nono` CLI wrapping approach. That approach requires users to install `nono` separately and forks an extra process per command. This plan is strictly better on all axes except "doesn't touch vendored code."

## Architecture

```
┌─ Settings ──────────────────────────────────────────────────────────┐
│  security.sandbox: "off" | "warn" | "enforce"  (default: "off")    │
│  security.sandbox.profileOverrides: Record<agentName, profile>     │
└────────────────────────────────┬───────────────────────────────────-┘
                                 │
┌────────────────────────────────▼────────────────────────────────────┐
│  packages/coding-agent/src/security/sandbox.ts  (NEW ~100 lines)   │
│                                                                     │
│  - SandboxProfile type (fs paths + modes, network mode)             │
│  - BUILTIN_PROFILES: configurable map for all bundled agents        │
│  - buildSandboxCaps(profile, cwd): SandboxCaps from pi-natives      │
│  - resolveProfile(agentName, settings, cwd): SandboxCaps | null    │
│  - enforceSandboxAccess(session, path, mode): throws if blocked    │
│    └─ uses SandboxCaps.queryPath() for in-process file tools       │
└────────┬────────────────────────────────────────────────────────────┘
         │
         │          ┌─────────────────────────────────────────────────┐
         │          │  Network: Domain Filtering (proxy mode)         │
         │          │                                                 │
         │          │  When profile.network = { allowedHosts: [...] } │
         │          │  ┌──────────────────────────────────────────┐   │
         │          │  │ SandboxProxy (napi class, pi-natives)    │   │
         │          │  │   .start(allowedHosts) → port, envVars   │   │
         │          │  │   .shutdown()                             │   │
         │          │  │   Wraps nono_proxy::start(ProxyConfig)   │   │
         │          │  │   Runs in tokio runtime (already exists) │   │
         │          │  └──────────────┬───────────────────────────┘   │
         │          │                 │                               │
         │          │  ProxyHandle.env_vars() → HTTP_PROXY,           │
         │          │    HTTPS_PROXY injected into child env           │
         │          └─────────────────┼───────────────────────────────┘
         │                            │
┌────────▼────────────────────────────▼──────────────────────────────┐
│  crates/pi-natives/src/sandbox.rs  (NEW ~100 lines)                 │
│                                                                     │
│  #[napi] class SandboxCaps: wraps nono::CapabilitySet               │
│    .new() / .allowPath(path, mode) / .blockNetwork() / .toJson()   │
│    .proxyOnly(port) — restricts to localhost:port TCP only          │
│    .queryPath(path, mode) -> bool                                   │
│  #[napi] class SandboxProxy: wraps nono_proxy::ProxyHandle          │
│    .start(hosts, opts) → { port, envVars }                          │
│    .shutdown()                                                       │
│  #[napi] fn sandboxIsSupported() -> bool                            │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ passed to Shell via ShellOptions
┌────────────────────────────────▼────────────────────────────────────┐
│  crates/pi-natives/src/shell.rs  (MODIFY ~15 lines)                 │
│                                                                     │
│  ShellOptions gains: sandbox_caps: Option<&SandboxCaps>             │
│                      sandbox_env: Option<Vec<(String, String)>>      │
│  ShellConfig gains: sandbox_caps: Option<Arc<nono::CapabilitySet>>  │
│                     sandbox_env: Vec<(String, String)>               │
│  Env vars injected into child process environment                   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────┐
│  crates/brush-core-vendored/src/commands.rs  (MODIFY ~15 lines)     │
│  crates/brush-core-vendored/src/sys/unix/commands.rs (+20 lines)    │
│                                                                     │
│  ExecutionContext/Shell gains: sandbox_caps: Option<Arc<CapSet>>    │
│  In execute_external_command(), before spawn:                       │
│    if let Some(caps) = &context.shell.sandbox_caps {                │
│        cmd.apply_sandbox(caps.clone());                             │
│    }                                                                │
│  CommandSandboxExt trait: pre_exec that calls Sandbox::apply()      │
└─────────────────────────────────────────────────────────────────────┘
```

### Network Filtering Flow

```
When profile.network = { allowedHosts: ["api.openai.com", "*.github.com"] }:

1. Agent starts → SandboxProxy.start(["api.openai.com", "*.github.com"])
   → nono-proxy binds localhost:0, returns port=49152, session token
   → Returns envVars: { HTTP_PROXY, HTTPS_PROXY, NODE_USE_ENV_PROXY }

2. Shell spawns command:
   a. SandboxCaps includes .proxyOnly(49152) — kernel blocks all TCP except localhost:49152
   b. sandbox_env injects HTTP_PROXY=http://localhost:49152 into child

3. Child's curl/git/npm reads HTTPS_PROXY → CONNECT to proxy → proxy checks HostFilter:
   - api.openai.com → ALLOWED (exact match)
   - uploads.github.com → ALLOWED (*.github.com wildcard)
   - evil.example.com → DENIED (403 + audit log)
   - 169.254.169.254 → DENIED (always-deny cloud metadata)

When profile.network = "blocked":
  - SandboxCaps includes .blockNetwork() — kernel denies ALL outbound TCP
  - No proxy started

When profile.network = "allow-all":
  - No network caps applied — unrestricted
  - No proxy started
```

## Key Design: Configurable Profiles

Profiles are user-configurable via `security.sandbox.profileOverrides`. Built-in defaults exist for all bundled agents but can be replaced or augmented per-project.

### Profile Shape (TypeScript)

```typescript
interface SandboxProfile {
  fs: Array<{ path: string; mode: "read" | "readwrite" }>;
  network:
    | "blocked"                                // deny all outbound
    | "allow-all"                              // no filtering
    | { allowedHosts: string[] };              // proxy-mode: only these domains reachable
}
```

`allowedHosts` supports:
- Exact domains: `"api.openai.com"`, `"registry.npmjs.org"`
- Wildcard subdomains: `"*.googleapis.com"`, `"*.github.com"`
- Cloud metadata endpoints are always denied (nono builtin)

Paths support:
- `"$CWD"` — resolved to agent's working directory at runtime
- `"$HOME/.bun"` — environment variable expansion
- Absolute paths

### Built-in Defaults

| Agent | fs | network |
|-------|-----|---------|
| `explore` | `$CWD` read | blocked |
| `reviewer` | `$CWD` read | blocked |
| `librarian` | `$CWD` read, `$HOME/.bun` read | `{ allowedHosts: ["registry.npmjs.org", "*.crates.io", "docs.rs", "*.pypi.org"] }` |
| `plan` | `$CWD` read | blocked |
| `designer` | `$CWD` read/write | blocked |
| `task` | `$CWD` read/write, `$HOME/.bun` read, `$HOME/.cargo` read | blocked |
| `quick_task` | `$CWD` read/write | blocked |
| `init` | `$CWD` read/write | `{ allowedHosts: ["registry.npmjs.org", "*.crates.io"] }` |

### Profile Resolution Order

1. `settings.get("security.sandbox.profileOverrides")[agentName]` (user override)
2. `BUILTIN_PROFILES[agentName]` (hardcoded defaults above)
3. Fallback: `$CWD` read/write, network allowed (most permissive)

All profiles automatically include system paths for executable resolution:
- `/usr`, `/lib`, `/bin`, `/sbin` (read)
- `/dev/null`, `/dev/zero`, `/dev/urandom` (read)
- `/tmp` (read/write)
- `/etc` (read) — needed for DNS resolution, timezone, etc.

## Files to Create/Modify

| File | Action | ~Lines | Description |
|------|--------|--------|-------------|
| `crates/pi-natives/src/sandbox.rs` | **CREATE** | 100 | napi-rs `SandboxCaps` + `SandboxProxy` classes + `sandboxIsSupported()` |
| `crates/pi-natives/src/lib.rs` | MODIFY | +1 | `pub mod sandbox;` |
| `crates/pi-natives/Cargo.toml` | MODIFY | +2 | Add `nono` + `nono-proxy` dependencies |
| `crates/brush-core-vendored/Cargo.toml` | MODIFY | +1 | Add `nono` dependency |
| `crates/brush-core-vendored/src/shell.rs` | MODIFY | +8 | Add `sandbox_caps` + `sandbox_env` fields to Shell struct |
| `crates/brush-core-vendored/src/commands.rs` | MODIFY | +12 | Apply sandbox + inject env in `execute_external_command` |
| `crates/brush-core-vendored/src/sys/unix/commands.rs` | MODIFY | +20 | `CommandSandboxExt` trait with `pre_exec` |
| `crates/pi-natives/src/shell.rs` | MODIFY | +15 | Pass sandbox caps + env from ShellOptions → brush Shell |
| `packages/coding-agent/src/security/sandbox.ts` | **CREATE** | 100 | Profile types, builtin defaults, caps builder, proxy lifecycle, enforceSandboxAccess |
| `packages/coding-agent/src/security/index.ts` | MODIFY | +1 | Re-export |
| `packages/coding-agent/src/config/settings-schema.ts` | MODIFY | +25 | Settings + `SecuritySettings` type update |
| `packages/coding-agent/src/exec/bash-executor.ts` | MODIFY | +15 | Pass sandbox caps + proxy env to Shell constructor |
| `packages/coding-agent/src/tools/write.ts` | MODIFY | +3 | Call `enforceSandboxAccess` before write |
| `packages/coding-agent/src/tools/read.ts` | MODIFY | +3 | Call `enforceSandboxAccess` before read |
| `packages/coding-agent/src/tools/ast-edit.ts` | MODIFY | +3 | Call `enforceSandboxAccess` before edit |
| `packages/coding-agent/src/tools/find.ts` | MODIFY | +3 | Validate root paths against sandbox |
| `packages/coding-agent/src/tools/search.ts` | MODIFY | +3 | Validate root paths against sandbox |
| `packages/coding-agent/CHANGELOG.md` | MODIFY | +3 | Document new feature |

**Total: ~290 lines new code** (100 Rust sandbox + 100 TS sandbox + 90 lines modifications)

## Implementation Phases

### Phase 0: Setup

- Create and checkout branch `feat/process-sandbox` from current HEAD

### Phase 1: Rust — sandbox.rs napi module (pi-natives)

New file `crates/pi-natives/src/sandbox.rs`:
- `#[napi] enum SandboxAccessMode { Read, Write, ReadWrite }`
- `#[napi] class SandboxCaps` wrapping `nono::CapabilitySet`
  - `new()`, `allowPath(path, mode)`, `blockNetwork()`, `proxyOnly(port)`, `toJson()`, `summary()`
  - `queryPath(path, mode) -> bool` — pre-flight check: would this path be allowed?
- `#[napi] class SandboxProxy` wrapping `nono_proxy::ProxyHandle`
  - `start(allowedHosts: string[], opts?: { bindPort?: number }) -> { port: number, envVars: Record<string, string> }`
    - Creates `HostFilter::new(&allowed_hosts)`, builds `ProxyConfig`, calls `nono_proxy::start()`
    - Returns assigned port + env vars from `ProxyHandle::env_vars()`
  - `shutdown()` — signals graceful proxy shutdown
  - `drainAuditEvents() -> AuditEvent[]` — returns proxy audit log for diagnostics
- `#[napi] fn sandboxIsSupported() -> bool`

Dependencies added to `crates/pi-natives/Cargo.toml`:
```toml
nono = { version = "0.53", default-features = false }
nono-proxy = { version = "0.53", default-features = false }
```

### Phase 2: Rust — brush-core pre_exec integration

1. Add `nono` dep to `crates/brush-core-vendored/Cargo.toml`
2. In `sys/unix/commands.rs`: add `CommandSandboxExt` trait:
   ```rust
   pub trait CommandSandboxExt {
       fn apply_sandbox(&mut self, caps: Arc<nono::CapabilitySet>);
   }
   impl CommandSandboxExt for std::process::Command {
       fn apply_sandbox(&mut self, caps: Arc<nono::CapabilitySet>) {
           unsafe {
               self.pre_exec(move || {
                   nono::Sandbox::apply(&caps)
                       .map_err(|e| io::Error::other(e.to_string()))
               });
           }
       }
   }
   ```
3. In `shell.rs`: add `pub sandbox_caps: Option<Arc<nono::CapabilitySet>>` to `Shell`
4. In `commands.rs`: in `execute_external_command`, before spawn:
   ```rust
   if let Some(caps) = &context.shell.sandbox_caps {
       cmd.apply_sandbox(caps.clone());
   }
   ```

### Phase 3: Rust — pi-natives shell.rs integration

- Add `sandbox_caps: Option<&SandboxCaps>` to `ShellOptions`
- Add `sandbox_env: Option<Vec<(String, String)>>` to `ShellOptions`
- In `create_session` / `ShellConfig`: store caps and env; pass through to brush-core's Shell
- In brush-core's `execute_external_command`: inject `sandbox_env` vars into the command's
  environment before spawn (alongside sandbox caps application)

### Phase 4: TypeScript — sandbox.ts + settings + proxy lifecycle

1. `packages/coding-agent/src/security/sandbox.ts`:
   - Type definitions (`SandboxProfile`, network modes)
   - `BUILTIN_PROFILES` constant with domain allowlists
   - `resolveProfile()` — merges overrides with builtins
   - `buildSandboxCaps()` — creates `SandboxCaps` from profile + cwd
   - `startSandboxProxy(profile)` — starts `SandboxProxy` if `network` has `allowedHosts`
   - `shutdownSandboxProxy()` — graceful shutdown (called on session end)
2. Settings: `security.sandbox` enum, `security.sandbox.profileOverrides` record
3. `bash-executor.ts`: when sandbox enabled:
   - Resolve profile → build caps (with `proxyOnly(port)` if proxy active)
   - Pass caps + proxy env vars to Shell constructor

### Phase 5: In-process query enforcement on file tools (~30 lines)

Since subagents run in the same OS process as the main agent, `Sandbox::apply()` cannot
be used (it's irreversible). Instead, file tools (read, write, ast-edit, find, search)
call `SandboxCaps.queryPath(resolvedPath, mode)` before performing I/O.

This provides **advisory enforcement** — not kernel-enforced, but blocks the tool from
proceeding. Combined with kernel-enforced shell sandboxing, this covers both:
- Shell commands: kernel-enforced via `pre_exec` (cannot bypass)
- File tools: query-enforced in TypeScript (blocks tool execution if path is outside profile)

**Integration point:** `packages/coding-agent/src/security/sandbox.ts` exports:
```typescript
function enforceSandboxAccess(session: ToolSession, absolutePath: string, mode: "read" | "write"): void
// Throws ToolError if sandbox is enabled and path is not covered by active profile
```

Called from:
- `WriteTool.execute()` — after `resolvePlanPath()`, before write
- `ReadTool.execute()` — after path resolution, before read
- `AstEditTool.execute()` — before file modification
- `FindTool.execute()` / `SearchTool.execute()` — validate root paths

Pattern follows existing `enforcePlanModeWrite()` guard already in these tools.

### Phase 6: Wiring + CHANGELOG

- Update `packages/coding-agent/src/security/index.ts`
- Update `SecuritySettings` interface
- Add CHANGELOG entry

## Graceful Degradation

- `sandboxIsSupported()` returns `false` on unsupported platforms (Windows, old Linux kernels)
- When `security.sandbox = "warn"`: log that sandbox would apply, proceed without
- When `security.sandbox = "enforce"`: if unsupported, fail tool execution with clear error
- Default is `"off"` — fully opt-in, zero behavior change for existing users
- Proxy mode (`allowedHosts`): if proxy fails to start, falls back based on sandbox mode:
  - `"warn"`: log warning, proceed without network filtering
  - `"enforce"`: fail the command execution
- WSL2: per-port filtering unavailable on kernel <6.7; proxy mode falls back to `blockNetwork()` with warning

## nono Crate Feature Selection

**`nono` (core):** `default-features = false`
- Core `CapabilitySet`, `Sandbox::apply()`, `NetworkMode`, `HostFilter` are in the base crate
- We do NOT need: `supervisor`, `keystore`, `trust`, `undo`, `state`
- Need to verify which features gate what — may need `landlock` and `seatbelt` features
- `query` module needed for `queryPath` pre-flight checks

**`nono-proxy`:** `default-features = false`
- Provides `ProxyConfig`, `start()`, `ProxyHandle`
- Needs tokio runtime (already present in pi-natives: `tokio = { features = ["full"] }`)
- We use CONNECT tunnel mode only (Mode 1 — Host Filtering)
- We do NOT use: reverse proxy credential injection, external proxy passthrough, TLS interception

## Verification

1. `bun check:rs` — new sandbox module compiles
2. `bun check:ts` — TypeScript picks up regenerated native types
3. Unit test: profile resolution, caps building, `queryPath` correctness (pure TS)
4. Unit test: `enforceSandboxAccess` throws for paths outside profile, allows paths inside
5. Integration test: spawn `echo hello` with CWD-read-only caps → succeeds; spawn `touch /tmp/test` with restricted caps → fails
6. Integration test: proxy mode — spawn `curl https://allowed.example.com` → succeeds; `curl https://blocked.example.com` → fails
7. Platform test: verify `sandboxIsSupported()` returns correct value
8. File tool test: write tool with sandbox enabled rejects write to path outside profile
9. Proxy lifecycle test: start proxy, verify port assigned, shutdown cleanly

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| brush-core-vendored modification | Change is isolated (~30 lines), well-understood pattern matching existing `pre_exec` usage |
| nono crate version churn | Pin to `0.53`, `default-features = false` for minimal surface |
| Binary size increase | nono-core ~50KB + nono-proxy ~150KB compiled; negligible vs 109MB native addon |
| macOS code signing | Seatbelt `sandbox_init` works without entitlements for restrictive policies |
| `pre_exec` safety | Already proven pattern in this codebase; nono's `Sandbox::apply()` is async-signal-safe on supported platforms |
| macOS DNS in proxy mode | Seatbelt blocks mDNSResponder Unix socket (nono#588); proxy-aware tools (curl, git, npm) work via CONNECT tunnel where proxy does DNS externally. Non-proxy-aware tools may fail — acceptable tradeoff for domain filtering |
| Proxy port discovery | Use OS-assigned ephemeral port (port 0); inject via env vars. No fixed port conflicts. |
| Proxy lifetime management | Proxy runs in tokio runtime already present in pi-natives; shutdown on session end via `SandboxProxy.shutdown()` |

## Scope Limits

- Does NOT sandbox the main agent process itself (irreversible `apply()` would lock down everything)
- Does NOT require any external tool installation
- Does NOT modify `AgentDefinition` type (profiles resolved externally via settings)
- Domain filtering requires proxy-aware child tools (curl, git, npm, node with `NODE_USE_ENV_PROXY`); non-proxy-aware tools get kernel-level TCP block but not per-domain filtering