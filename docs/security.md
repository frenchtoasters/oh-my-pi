# Security

oh-my-pi's security system provides defense-in-depth for a local CLI agent: OS-enforced process isolation, command execution policy, encrypted credentials and session transcripts, tamper-evident audit logging, and transport security. All features are opt-in and configurable per environment.

## Configuration

Security settings are available in the `/settings` TUI under the **Security** tab, or directly in `config.yml`:

```yaml
security:
  sandbox: "off"                    # "off" | "warn" | "enforce"
  sandbox.profileOverrides: {}      # per-agent SandboxProfile overrides
  executionPolicy: "permissive"     # "permissive" | "strict"
  encryptCredentials: false
  encryptSessions: false
  auditEnabled: true
  tlsRejectUnauthorized: true
  maxAuthFailures: 3
```

---

## Process Sandbox

The process sandbox applies OS-enforced isolation to every command spawned by the agent. On macOS it uses **Seatbelt** (`sandbox-exec`); on Linux it uses **Landlock** (kernel 5.13+). Windows is not supported — sandbox settings are silently ignored on Windows.

### Modes

| Mode | Behavior |
|---|---|
| `off` (default) | No isolation. All filesystem and network access permitted. |
| `warn` | Sandbox is active. Violations are logged to the audit log but not blocked. |
| `enforce` | Sandbox is active. Violations are blocked. Denied in-process file tool calls raise a hard error. |

In `warn` mode, a spawned process that touches a disallowed path generates a `PERMISSION_DENIED` audit event; the access still succeeds at the kernel level. Use `warn` to audit what an agent actually reaches before committing to `enforce`.

### Enforcement layers

Two distinct layers combine to cover all access paths:

1. **Kernel-level (spawned processes)** — `SandboxCaps` is applied as a `pre_exec` hook on every shell command. The kernel rejects disallowed filesystem reads, writes, and network connections before the child process can act on them. This cannot be bypassed by the child.

2. **Query-level (in-process file tools)** — File tools (`read`, `write`, `edit`, `find`, `search`, `ast_grep`, `ast_edit`, `notebook`) call `enforceSandboxAccess()` before operating. In `enforce` mode this throws a hard error and instructs the agent not to substitute from memory. In `warn` mode it logs a `PERMISSION_DENIED` event and proceeds.

### Built-in profiles

Each agent type ships with a least-privilege profile:

| Agent | Filesystem | Network |
|---|---|---|
| `explore` | `$CWD` read | blocked |
| `reviewer` | `$CWD` read | blocked |
| `librarian` | `$CWD` read, `$HOME/.bun` read | `registry.npmjs.org`, `*.crates.io`, `docs.rs`, `*.pypi.org` |
| `plan` | `$CWD` read | blocked |
| `designer` | `$CWD` read/write | blocked |
| `task` | `$CWD` read/write, `$HOME/.bun` read, `$HOME/.cargo` read | blocked |
| `quick_task` | `$CWD` read/write | blocked |
| `init` | `$CWD` read/write | `registry.npmjs.org`, `*.crates.io` |

Unknown agent names fall back to `$CWD` read/write with network blocked.

### Custom profile overrides

Override any built-in profile or define profiles for custom agent types via `security.sandbox.profileOverrides` in `config.yml`:

```yaml
security:
  sandbox:
    profileOverrides:
      # Widen the task agent to also read /etc/ssl for certificate access
      task:
        fs:
          - path: "$CWD"
            mode: "readwrite"
          - path: "$HOME/.bun"
            mode: "read"
          - path: "$HOME/.cargo"
            mode: "read"
          - path: "/etc/ssl"
            mode: "read"
        network: "blocked"

      # Custom agent that must reach an internal registry
      my-custom-agent:
        fs:
          - path: "$CWD"
            mode: "readwrite"
        network:
          allowedHosts:
            - "registry.internal.example.com"
```

The `SandboxProfile` shape:

```typescript
interface SandboxProfile {
  fs: Array<{ path: string; mode: "read" | "readwrite" }>;
  network: "blocked" | "allow-all" | { allowedHosts: string[] };
}
```

Resolution order: user override → built-in profile → fallback (`$CWD` read/write, network blocked).

### Network filtering

When a profile specifies `allowedHosts`, a local CONNECT proxy (`nono-proxy`) is started and injected into child processes via `HTTP_PROXY` / `HTTPS_PROXY` environment variables. The proxy allows only the listed hostnames; all other CONNECT requests are rejected. The proxy is shared across agents in the same session and shut down on session exit.

`allow-all` disables network filtering entirely for that agent. `blocked` rejects all outbound network connections.

### Path variable expansion

Profile paths support variable expansion:

| Variable | Expands to |
|---|---|
| `$CWD` | Current working directory at session start |
| `$HOME` | User home directory |
| Any `$VAR` | Value of the matching environment variable |

Paths that do not exist at profile resolution time are silently skipped (system directories vary by OS).

### Graceful degradation

If the sandbox cannot be initialized (unsupported kernel version, missing capability, macOS SIP restriction), behavior depends on mode:

- `warn` — logs a warning and continues without sandbox enforcement.
- `enforce` — logs an `INTEGRITY_VIOLATION` audit event. The session continues but the sandbox is inactive; the agent is not aware it is unsandboxed.

Use `sandboxIsSupported()` (exported from `@oh-my-pi/pi-natives`) to check availability programmatically.

---

## Execution Policy

Controls which shell commands the agent may run.

```yaml
security:
  executionPolicy: "permissive"  # or "strict"
```

| Mode | Behavior |
|---|---|
| `permissive` (default) | All commands allowed. Each execution emits a `TOOL_EXECUTION` audit event. |
| `strict` | Only allowlisted commands may run. File paths must be under CWD. Denials emit `TOOL_BLOCKED`. |

### Strict mode

**Blocked commands** (partial list): `curl`, `wget`, `nc`, `ncat`, `netcat`, `ssh`, `scp`, `sftp`, `rsync`, `docker`, `podman`, `sudo`, `su`, `doas`, `rm -rf /`, `mkfs`, `dd`, `shutdown`, `reboot`, `halt`, `iptables`, `ip6tables`, `nft`

**Allowed commands**: `ls`, `cat`, `head`, `tail`, `grep`, `find`, `wc`, `echo`, `printf`, `test`, `git`, `bun`, `node`, `npm`, `npx`, `cargo`, `rustc`, `rustup`, `python`, `python3`, `pip`, `mkdir`, `cp`, `mv`, `rm`, `touch`, `sed`, `awk`, `sort`, `uniq`, `tr`, `cut`, `diff`, `patch`, `which`, `env`, `printenv`

Commands containing shell injection metacharacters (`; & | > < $( \``) are rejected in strict mode regardless of the allowlist.

Extend the lists per-project:

```yaml
security:
  executionPolicy: "strict"
  executionPolicyConfig:
    allowCommands:
      - "make"
      - "just"
    denyCommands:
      - "git push"
```

---

## Credential Encryption

Encrypts stored API keys and provider credentials at rest using AES-256-GCM. The master key is derived via PBKDF2-SHA-256 (210,000 iterations, 32-byte salt) and stored in the OS keychain — macOS Keychain on macOS, Linux Secret Service (D-Bus) on Linux.

```yaml
security:
  encryptCredentials: true
```

Credentials are decrypted in memory on demand and never written to disk in plaintext. The encryption parameters are enforced at runtime: minimum 100,000 PBKDF2 iterations, minimum 32-byte keys, AES-256-GCM with 12-byte IV and 16-byte authentication tag.

---

## Session Encryption

Encrypts session transcript files (`.jsonl`) at rest using AES-256-GCM with the same key store as credential encryption.

```yaml
security:
  encryptSessions: true
```

Encrypted transcripts are stored at `~/.omp/agents/<session-id>.jsonl` with `0o600` permissions. Without the OS keychain master key, the transcripts cannot be decrypted.

---

## Audit Logging

Records security-relevant events to a structured JSONL log with a SHA-256 hash chain for tamper detection.

```yaml
security:
  auditEnabled: true
```

### Event types

| Event | When emitted |
|---|---|
| `TOOL_EXECUTION` | A tool or shell command was executed |
| `TOOL_BLOCKED` | A tool or command was rejected by execution policy or sandbox |
| `AUTH_FAILURE` | A provider authentication attempt failed |
| `CONFIG_CHANGE` | A security-relevant setting was modified |
| `PERMISSION_DENIED` | A file path or resource was denied by sandbox or policy |
| `INTEGRITY_VIOLATION` | Config integrity check failed, self-test failed, or sandbox error |

### Log file

Logs are written to `~/.omp/logs/audit.YYYY-MM-DD.log` with `0o600` permissions. Each entry is a JSON object on a single line containing a UUID, ISO 8601 timestamp, event type, actor, resource, outcome, and the SHA-256 hash of the previous entry.

The genesis entry uses the seed string `omp-audit-genesis-v1`.

### Verification

Verify an audit log's integrity offline:

```typescript
import { verifyAuditLog } from "@oh-my-pi/pi-utils";
const result = await verifyAuditLog("~/.omp/logs/audit.2026-05-12.log");
// result.valid: boolean, result.brokenAt: number | null
```

Any insertion, deletion, or modification of entries breaks the hash chain and is detected by `verifyAuditLog()`.

---

## TLS Enforcement

All outbound connections to LLM providers require TLS 1.2 or higher. TLS 1.0 and 1.1 are rejected.

```yaml
security:
  tlsRejectUnauthorized: true  # default
```

Set to `false` only when operating behind a corporate TLS-intercepting proxy that presents a private CA certificate. Disabling this setting allows MITM attacks on provider traffic and should be combined with explicit proxy CA certificate configuration.

---

## Auth Failure Tracking

Locks out a provider after N consecutive authentication failures to limit credential-stuffing and misconfiguration loops.

```yaml
security:
  maxAuthFailures: 3  # default
```

Each failure emits an `AUTH_FAILURE` audit event. After the threshold is reached, further requests to that provider are blocked until the session is restarted or the failure count is reset. Set to `0` to disable lockout.

---

## Startup Self-Test

On session initialization, four checks run automatically and their results are recorded in the audit log:

| Check | What it verifies |
|---|---|
| `audit-logger-write` | Audit logger can write a probe event successfully |
| `crypto-functions-available` | `crypto.randomBytes` and AES-256-GCM are functional |
| `config-integrity-check` | Current config matches the stored SHA-256 baseline hash |
| `genesis-hash-constant` | Audit log genesis seed constant has not been tampered with |

If any check fails, an `INTEGRITY_VIOLATION` event is emitted. The session continues (fail-safe per SC-24), but the failure is surfaced in the TUI and logged. A broken config integrity check indicates the config was modified outside of oh-my-pi; a broken genesis hash indicates potential tampering with the audit subsystem.

The config baseline hash is updated automatically when settings are changed through the TUI or API. Direct edits to `config.yml` will trigger an integrity warning on next startup.

---

## Key Files

| Feature | Source |
|---|---|
| Process sandbox (profiles, caps, proxy) | `packages/coding-agent/src/security/sandbox.ts` |
| In-process sandbox enforcement | `packages/coding-agent/src/security/sandbox.ts` → `enforceSandboxAccess()` |
| Execution policy | `packages/coding-agent/src/security/execution-policy.ts` |
| Credential encryption | `packages/ai/src/credential-encryption.ts` |
| Session encryption | `packages/coding-agent/src/security/session-encryption.ts` |
| Audit logging | `packages/utils/src/security-audit.ts` |
| Audit log integrity / verification | `packages/utils/src/audit-integrity.ts` |
| TLS policy | `packages/ai/src/tls-policy.ts` |
| Auth failure tracking | `packages/ai/src/auth-failure-tracker.ts` |
| Config integrity | `packages/coding-agent/src/security/config-integrity.ts` |
| Startup self-test | `packages/coding-agent/src/security/self-test.ts` |
| Crypto parameters and prohibited algorithms | `packages/ai/src/crypto-policy.ts` |
| Settings schema | `packages/coding-agent/src/config/settings-schema.ts` |
| Native sandbox bindings (nono/Landlock/Seatbelt) | `@oh-my-pi/pi-natives` |
