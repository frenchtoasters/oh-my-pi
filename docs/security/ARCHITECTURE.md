# Security Architecture

**Control**: SA-8 (Security and Privacy Engineering Principles)

---

## Trust Boundaries

```
  [ User ]
      |  stdin / TUI
  [ Agent Process ]
      |                           |
  [ LLM Provider ]         [ Filesystem ]
  (TLS 1.2+ required)      (~/.omp/ — owned by user)
      |                           |
  [ Network ]              [ Session Transcripts ]
                           (encrypted JSONL at rest)
```

Principals and trust levels:

| Principal | Trust Level | Notes |
|---|---|---|
| User (local process owner) | High | Runs as own UID; credentials stored in OS keychain |
| Agent process | Derived | Inherits user's UID; no elevated privileges |
| LLM provider | External/Untrusted | All traffic over TLS; API keys never logged |
| Filesystem | Trusted storage | Audit logs 0o600; session transcripts encrypted |
| Network | Untrusted | TLS enforced via `packages/ai/src/tls-policy.ts` |

---

## Data Flows

### Credentials

```
OS keychain
  -> CredentialEncryption.load()        (AES-256-GCM decrypt, key from keychain)
  -> plaintext credential in memory     (never written to disk in plaintext)
  -> HTTP Authorization header          (TLS 1.2+ to provider)
  -> [provider processes request]
```

On write: plaintext -> PBKDF2 key derivation (210k iterations, SHA-256) -> AES-256-GCM encrypt -> OS keychain storage.

### Prompts and Tool Outputs

```
User input (stdin/TUI)
  -> Agent session (memory only)
  -> LLM provider (TLS)
  -> Tool execution (execution-policy check first)
  -> Tool output -> Agent session (memory)
  -> Session transcript (AES-256-GCM encrypted JSONL -> disk)
```

### Audit Events

```
emitSecurityEvent()
  -> SecurityAuditLogger (append-only JSONL)
  -> SHA-256 hash chain (each entry hashes previous line)
  -> ~/.omp/logs/audit.YYYY-MM-DD.log (0o600)
```

Audit log integrity is verifiable offline via `verifyAuditLog()` in `packages/utils/src/audit-integrity.ts`.

### Session Data

```
Agent session state (in-process memory)
  -> SessionEncryption.encrypt()        (AES-256-GCM, key from OS keychain)
  -> encrypted JSONL
  -> ~/.omp/agents/<session-id>.jsonl   (0o600)
```

---

## Threat Model (STRIDE)

### Spoofing

**Threats**: Credential theft, session replay, API key interception.

**Mitigations**:
- API keys stored exclusively in the OS keychain (`packages/ai/src/credential-encryption.ts`); never written to disk in plaintext.
- TLS 1.2+ enforced for all outbound provider connections (`packages/ai/src/tls-policy.ts`).
- Auth failure tracking locks out repeated failed attempts (`packages/ai/src/auth-failure-tracker.ts`).

### Tampering

**Threats**: Modification of config files, audit log manipulation.

**Mitigations**:
- Config baseline hash stored separately; `verifyConfigIntegrity()` detects divergence (`packages/coding-agent/src/security/config-integrity.ts`).
- Audit log SHA-256 hash chain makes retrospective insertion detectable.
- Execution policy enforces an allowlist; arbitrary command execution is blocked (`packages/coding-agent/src/security/execution-policy.ts`).

### Repudiation

**Threats**: Denial of having executed a tool or changed a configuration.

**Mitigations**:
- Every security-relevant action emits a `SecurityEvent` with a UUID, ISO 8601 timestamp, actor, resource, and outcome.
- Hash-chained audit logs prevent undetected deletion or insertion of records.

### Information Disclosure

**Threats**: Credential leakage, session content leakage, log scraping.

**Mitigations**:
- Credentials encrypted at rest (AES-256-GCM) and in transit (TLS).
- Session transcripts encrypted at rest (`session-encryption.ts`).
- Audit logs at 0o600; logs do not contain plaintext credential values.
- Prohibited algorithms (MD5, SHA-1) enforced by `packages/ai/src/crypto-policy.ts`.

### Denial of Service

**Threats**: Runaway tool execution, unbounded output accumulation.

**Mitigations**:
- Execution policy enforces command and file-path allowlists; unknown commands are blocked.
- Bash executor applies a configurable timeout.
- Output size limits on tool responses prevent unbounded memory growth.

### Elevation of Privilege

**Threats**: Agent escaping its execution sandbox, unauthorized tool invocation.

**Mitigations**:
- `ExecutionPolicy` with strict mode: commands and file paths must pass allowlist checks before execution.
- Agent process runs as the invoking user's UID; no privilege escalation paths.
- `TOOL_BLOCKED` and `PERMISSION_DENIED` events are emitted and audited on rejection.

---

## Cryptographic Inventory

Source of truth: `packages/ai/src/crypto-policy.ts`

| Purpose | Algorithm | Parameters |
|---|---|---|
| Credential encryption at rest | AES-256-GCM | key=32B, IV=12B, tag=16B |
| Session encryption at rest | AES-256-GCM | key=32B, IV=12B, tag=16B |
| Key derivation (passwords) | PBKDF2-SHA-256 | 210,000 iterations, salt=32B |
| Audit log hash chain | SHA-256 | Genesis seed: `omp-audit-genesis-v1` |
| Master key storage | OS keychain | macOS Keychain / Linux Secret Service |
| Transport security | TLS 1.2+ | Enforced; TLS 1.0/1.1 rejected |

Prohibited algorithms: MD5, SHA-1 (runtime enforcement via `isProhibitedAlgorithm()`).

Minimum PBKDF2 iterations: 100,000 (asserted at runtime; default 210,000).

---

## Control-to-Code Mapping

| Control | Description | Implementation |
|---|---|---|
| IA-5 | Authenticator Management | `packages/ai/src/credential-encryption.ts` |
| AU-2 | Audit Events | `packages/utils/src/security-audit.ts` |
| AU-9 | Protection of Audit Info | `packages/utils/src/audit-integrity.ts` |
| AC-3 | Access Enforcement | `packages/coding-agent/src/security/execution-policy.ts` |
| CM-3 | Configuration Change Control | `packages/coding-agent/src/security/config-integrity.ts` |
| SC-8 | Transmission Confidentiality | `packages/ai/src/tls-policy.ts` |
| SC-12 | Crypto Key Management | `packages/ai/src/crypto-policy.ts` |
| SC-13 | Cryptographic Protection | `packages/ai/src/crypto-policy.ts`, `CryptoParams` |
| SC-28 | Data at Rest | `session-encryption.ts`, `packages/ai/src/credential-encryption.ts` |
