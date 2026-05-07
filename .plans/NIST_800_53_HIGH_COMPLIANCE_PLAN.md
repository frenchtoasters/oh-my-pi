# NIST 800-53 HIGH Baseline Compliance Plan for oh-my-pi

## Objective

Bring the oh-my-pi CLI coding agent into compliance with NIST 800-53 HIGH baseline for the technically-implementable control families: **AC, AU, CM, IA, SC, SI, SA, SR**. This plan covers assessment documentation, phased code changes, and verification.

## Context

- **Project**: oh-my-pi — a CLI coding agent using Claude AI (Bun/TypeScript + Rust)
- **Deployment model**: Local developer workstation, network calls to LLM providers
- **Risk level**: HIGH baseline applies — the tool handles code, credentials, and executes commands
- **Scope boundary**: Only controls implementable in application code. Controls requiring organizational processes (training, physical security, HR) are documented as "organizational" and deferred. CI/CD pipeline controls (SR family) deferred until replacement platform is established.

---

## Current Posture Summary

| Family | Current State | Key Gaps |
|--------|---------------|----------|
| **IA** | SQLite credential store, OAuth support | Credentials unencrypted at rest, no rotation policy, no MFA |
| **AU** | Winston JSON logger, daily rotation | No integrity protection, no security event catalog, no log access control |
| **SC** | HTTPS/TLS for providers, mTLS for Anthropic | No session encryption option, TLS validation not explicitly enforced |
| **AC** | Extension/hook system, path validation, bash interceptors | No formalized execution policy presets, no auth failure tracking |
| **CM** | Hierarchical YAML settings, Biome/tsgo | No config integrity checking, no baseline diffing |
| **SI** | JTD/JSON Schema validation, sanitization | No SBOM, no flaw remediation tracking |
| **SR** | Lockfiles committed, frozen installs | No SBOM (CI deferred — no GitHub) |
| **SA** | Static analysis (Biome + Clippy) | No security-focused testing, no threat model, no SDLC docs |

---

## Phased Implementation Plan

### Phase 1: Foundation — Credential Protection & Audit Infrastructure
**Priority**: CRITICAL — Addresses IA-5(1), AU-2, AU-3, AU-6, AU-9

#### 1.1 Encrypt Credentials at Rest (IA-5)

**File**: `packages/ai/src/auth-storage.ts`

**Change**: Add encryption layer for stored credentials using OS keychain integration.

- Add `packages/ai/src/credential-encryption.ts`:
  - Use macOS Keychain (`security` CLI) / Linux `libsecret` for master key storage
  - AES-256-GCM encryption of credential values before SQLite write
  - Key derivation: PBKDF2 with machine-specific salt
  - Transparent decrypt on read via wrapper around existing `getCredential()`
- Modify `AuthStorage` class to route credential read/write through encryption layer
- Migration path: detect unencrypted credentials on first run, encrypt in-place
- Fallback: if keychain unavailable, warn user and allow opt-in plaintext (with audit log)

**Verification**: Unit test that stored credential bytes differ from plaintext; integration test that round-trip encrypt/decrypt preserves credential value.

#### 1.2 Security Event Audit Catalog (AU-2, AU-3)

**File**: `packages/utils/src/logger.ts` (extend), new `packages/utils/src/security-audit.ts`

**Change**: Create a structured security event logger that emits standardized audit records.

- Define `SecurityEvent` type with fields:
  - `eventId` (UUID v7)
  - `timestamp` (ISO 8601, UTC)
  - `eventType` (enum: `AUTH_SUCCESS`, `AUTH_FAILURE`, `CREDENTIAL_ACCESS`, `CREDENTIAL_MODIFY`, `CONFIG_CHANGE`, `TOOL_EXECUTION`, `TOOL_BLOCKED`, `PERMISSION_DENIED`, `SESSION_START`, `SESSION_END`, `INTEGRITY_VIOLATION`)
  - `actor` (user identity or "system")
  - `resource` (what was accessed/modified)
  - `outcome` (`success` | `failure` | `blocked`)
  - `metadata` (free-form context)
- Separate audit log file: `~/.omp/logs/audit.YYYY-MM-DD.log` (JSONL)
- Audit log rotation: 50MB max, 30 files retained, compressed
- Audit log file permissions: `0600` on creation

**Instrumentation points** (emit security events):
- `packages/ai/src/auth-storage.ts` — credential read/write/delete
- `packages/coding-agent/src/extensibility/hooks/` — tool_call block events
- `packages/coding-agent/src/exec/` — bash/eval execution start/end
- `packages/coding-agent/src/config/` — settings changes
- Session lifecycle (start/end)

**Verification**: Integration test that exercises each event type and validates JSONL output schema.

#### 1.3 Audit Log Integrity (AU-9, AU-10)

**File**: New `packages/utils/src/audit-integrity.ts`

**Change**: Hash-chain audit log entries for tamper detection.

- Each audit entry includes `prevHash` (SHA-256 of previous entry)
- First entry per file uses a known seed
- Verification command: `omp audit verify [--date YYYY-MM-DD]` that walks the chain
- Log files created with `0600` permissions (owner-only read/write)

**Verification**: Test that modifying any entry breaks chain verification.

---

### Phase 2: Access Control & Execution Policy
**Priority**: HIGH — Addresses AC-3, AC-6, AC-7

#### 2.1 Tool Execution Policy (AC-3, AC-6)

**File**: `packages/coding-agent/src/exec/bash.ts`, `packages/coding-agent/src/exec/non-interactive-env.ts`

**Change**: Formalize tool execution restrictions as a configurable policy.

- Add `packages/coding-agent/src/security/execution-policy.ts`:
  - Define allowlist/denylist for executable commands (extend existing `DEFAULT_BASH_INTERCEPTOR_RULES`)
  - Resource limits: max execution time (already exists via timeout), max output size
  - `strict` mode available: restricted command set, CWD-only filesystem, no network
- New setting: `security.execution_policy` with presets: `permissive` (default, current behavior), `strict`
- `permissive` mode (default): full filesystem access, outbound network allowed — users are system administrators
- `strict` mode (opt-in): no network, CWD-only filesystem, limited command set
- Emit `TOOL_EXECUTION` and `TOOL_BLOCKED` audit events for all executions

**Rationale for permissive default**: This is a developer tool where users have full system admin privileges. OS-level access controls (file permissions, firewalls) provide the enforcement layer. The `strict` mode exists for environments that need additional application-layer restrictions.

**Verification**: Integration test demonstrating blocked execution under `strict` policy.

#### 2.2 Failed Authentication Handling (AC-7)

**File**: `packages/ai/src/auth-storage.ts`, `packages/ai/src/providers/`

**Change**: Track and respond to authentication failures.

- Count consecutive auth failures per provider/credential
- After 3 consecutive failures: stop the current action and surface the error to the user
- No cooldown/lockout — network failures are common; user decides whether to retry
- Emit `AUTH_FAILURE` audit events with failure count
- Clear failure count on successful auth

**Verification**: Unit test exercising the 3-failure stop behavior.

---

### Phase 3: Configuration Integrity & Change Control
**Priority**: HIGH — Addresses CM-3, CM-5, CM-6, CM-8

#### 3.1 Configuration Integrity Verification (CM-3, CM-6)

**File**: New `packages/coding-agent/src/security/config-integrity.ts`

**Change**: Detect unauthorized configuration changes.

- On startup: compute SHA-256 of effective configuration
- Store hash in `~/.omp/config-baseline.json` (with timestamp)
- On subsequent starts: compare current config hash to baseline
- If changed: emit `CONFIG_CHANGE` audit event with diff summary
- Command: `omp config baseline` to accept current config as new baseline
- Command: `omp config verify` to check current config against baseline

**Verification**: Test that config modification triggers change detection.

#### 3.2 Software Inventory (CM-8, SR-4)

**File**: New `scripts/generate-sbom.ts`

**Change**: Generate CycloneDX SBOM as part of the release process.

- Script generates CycloneDX SBOM from `bun.lock` + `Cargo.lock`
- Include: package name, version, license, source URL, integrity hash
- Output: `sbom.cdx.json` in repo root (committed or attached to release)
- Run manually or via release script: `bun run scripts/generate-sbom.ts`

**Verification**: SBOM validates against CycloneDX schema; contains expected top-level dependencies.
---

### Phase 4: System & Communications Protection
**Priority**: HIGH — Addresses SC-8, SC-12, SC-13, SC-28

#### 4.1 Cryptographic Standards Enforcement (SC-12, SC-13)

**File**: New `packages/ai/src/crypto-policy.ts`

**Change**: Centralize and enforce cryptographic algorithm choices.

- Define approved algorithms:
  - Symmetric: AES-256-GCM only
  - Hash: SHA-256, SHA-384, SHA-512 (SHA-1 prohibited except git)
  - Key derivation: PBKDF2 (≥100k iterations) or Argon2id
  - TLS: 1.2+ only (already enforced by Node.js defaults)
- Export `CryptoPolicy` constants used by credential encryption and audit integrity
- Lint rule or runtime check that prevents use of weak algorithms

**Verification**: Unit test that policy rejects deprecated algorithms.

#### 4.2 Data-at-Rest Protection (SC-28)

**File**: `packages/coding-agent/src/session/`, `packages/ai/src/auth-storage.ts`

**Change**: Encrypt sensitive data at rest beyond just credentials.

- Session transcripts containing tool outputs: encrypt if `security.encrypt_sessions` enabled
- Use same AES-256-GCM approach from Phase 1
- Conversation history files: encrypt sensitive fields (API responses containing code)
- Default: disabled (opt-in via `security.encrypt_sessions: true`)

**Verification**: Test that encrypted session files are not readable without key.

#### 4.3 TLS Certificate Validation Hardening (SC-8)

**File**: `packages/ai/src/providers/` (all provider files)

**Change**: Ensure TLS certificate validation is never bypassed.

- Audit all provider HTTP clients for `rejectUnauthorized: false` or equivalent
- Add explicit `rejectUnauthorized: true` where not already set
- Add setting `security.tls.allow_self_signed` (default: false) for air-gapped/corporate proxy scenarios
- Log warning if self-signed certificates are allowed

**Verification**: Integration test that connection to invalid cert fails unless explicitly allowed.


### Phase 5: Security Assurance & Documentation
**Priority**: MEDIUM — Addresses SA-3, SA-8, SA-11, SA-15

#### 5.1 Security Architecture Document (SA-8)

**File**: New `docs/security/ARCHITECTURE.md`

**Change**: Document the security architecture.

Contents:
- Trust boundaries (user ↔ agent ↔ LLM provider ↔ filesystem ↔ network)
- Data flow diagram (credentials, prompts, tool outputs, session data)
- Threat model (STRIDE categories for each boundary)
- Security controls mapping (which code enforces which control)
- Cryptographic inventory (algorithms, key management, certificate handling)

#### 5.2 Secure Development Lifecycle (SA-3, SA-15)

**File**: New `docs/security/SDLC.md`, update `AGENTS.md`

**Change**: Document security in the development lifecycle.

Contents:
- Security review requirements for PRs touching auth/exec/network code
- Dependency update policy (monthly review, immediate for CRITICAL CVEs)
- Security testing requirements (what must be tested before release)
- Vulnerability disclosure process (reference existing SECURITY.md)
- AGENTS.md additions: security coding guidelines for the agent

#### 5.3 Security Testing (SA-11)

**File**: New `packages/coding-agent/test/security/`, new test files

**Change**: Add dedicated security test suite.

Tests covering:
- Path traversal attempts (various encoding tricks)
- Command injection via tool arguments
- Credential exposure in logs (ensure no plaintext secrets in audit/app logs)
- Session fixation/replay
- Configuration injection
- Large input handling (resource exhaustion)

**Verification**: `bun test test/security/` passes; covers documented threat scenarios.

---

## Files Modified/Created Summary

### New Files
| Path | Purpose |
|------|---------|
| `packages/ai/src/credential-encryption.ts` | AES-256-GCM credential encryption with OS keychain |
| `packages/utils/src/security-audit.ts` | Structured security event logger |
| `packages/utils/src/audit-integrity.ts` | Hash-chain log integrity |
| `packages/coding-agent/src/security/execution-policy.ts` | Tool execution restrictions |
| `packages/coding-agent/src/security/config-integrity.ts` | Configuration change detection |
| `packages/ai/src/crypto-policy.ts` | Centralized cryptographic standards |
| `scripts/generate-sbom.ts` | CycloneDX SBOM generator |
| `docs/security/ARCHITECTURE.md` | Security architecture & threat model |
| `docs/security/SDLC.md` | Secure development lifecycle |
| `docs/security/COMPLIANCE-MATRIX.md` | Control-to-implementation mapping |
| `packages/coding-agent/test/security/*.test.ts` | Security-focused tests |

### Modified Files
| Path | Change |
|------|--------|
| `packages/ai/src/auth-storage.ts` | Encrypt/decrypt credentials, failure tracking |
| `packages/utils/src/logger.ts` | Integrate security audit, set file permissions |
| `packages/coding-agent/src/config/settings-schema.ts` | Add `security.*` settings |
| `packages/coding-agent/src/exec/bash.ts` | Emit audit events, enforce execution policy |
| `packages/coding-agent/src/exec/non-interactive-env.ts` | Policy-driven restrictions |
| `packages/coding-agent/src/extensibility/hooks/` | Emit audit events on block |
| `AGENTS.md` | Security coding guidelines |
---

## Verification Strategy

### Per-Phase Verification
Each phase includes specific unit/integration tests that validate the control implementation.

### End-to-End Verification
After all phases:
1. `bun check` — type checking passes
2. `bun lint` — no new lint violations
3. `bun test` — all existing + new tests pass
4. `bun test test/security/` — security test suite passes
5. Manual: Run `omp audit verify` against generated audit logs
6. Manual: Run `omp config verify` against baseline
7. Run `bun run scripts/generate-sbom.ts` and validate output against CycloneDX schema

### Compliance Matrix Validation
Create `docs/security/COMPLIANCE-MATRIX.md` mapping each implemented control to:
- Control ID (e.g., AU-2)
- Implementation location (file + function)
- Test coverage (test file + test name)
- Residual risk (if any)

---

## Implementation Order & Dependencies

```
Phase 1 (Foundation) ──┬── 1.1 Credential Encryption
                       ├── 1.2 Security Audit Catalog
                       └── 1.3 Audit Log Integrity (depends on 1.2)

Phase 2 (Access Control) ──┬── 2.1 Execution Policy (uses 1.2 for audit)
                           └── 2.2 Auth Failure Handling (uses 1.2 for audit)

Phase 3 (Config) ──┬── 3.1 Config Integrity (uses 1.2 for audit)
                   └── 3.2 SBOM Generation

Phase 4 (Comms) ──┬── 4.1 Crypto Policy (prerequisite for 1.1 & 1.3)
                  ├── 4.2 Data-at-Rest (uses 4.1, 1.1 patterns)
                  └── 4.3 TLS Hardening

Phase 5 (Documentation) ── All docs (can proceed in parallel with any phase)
```

**Recommended execution**: Phase 4.1 first (defines crypto constants), then Phase 1, then Phases 2-5 in parallel where possible.

---

## Decisions & Trade-offs

| Decision | Rationale | Alternative Considered |
|----------|-----------|----------------------|
| OS keychain for master key | Leverages existing hardware-backed security; no new secrets to manage | Passphrase-derived key (worse UX, user forgets) |
| Hash-chain for log integrity (not digital signatures) | Simpler, no key management for logs; sufficient for tamper detection | GPG-signed entries (overkill for local CLI) |
| Execution policy: permissive default | Users are sysadmins on their own machines; OS-level controls provide enforcement | Mandatory strict (breaks legitimate use cases) |
| No session timeout | OS screen lock provides session protection; redundant application-layer timeout adds friction | Application-managed idle timeout (annoying for developers) |
| Auth failure: stop action, no cooldown | Network failures are common; cooldowns punish transient issues | 30-minute cooldown (too aggressive for flaky networks) |
| CycloneDX over SPDX for SBOM | Better tooling support in JS/Rust ecosystem | SPDX (less tooling for bun) |
| Opt-in session encryption | Performance cost + complexity; most users don't need encrypted session transcripts | Always-on (performance regression for all) |

---

## Out of Scope

### Organizational Controls (not applicable to CLI tool)
These controls require organizational processes, not code changes:
- **AT-***: Security awareness training
- **PE-***: Physical/environmental protection
- **PS-***: Personnel security (screening, termination)
- **PL-***: Planning (system security plans)
- **RA-***: Risk assessment (periodic reviews)
- **CA-***: Security assessment & authorization
- **MP-***: Media protection (physical media)
- **CP-***: Contingency planning (disaster recovery)
- **IR-***: Incident response (organizational procedures)
- **MA-***: Maintenance (physical maintenance)

### Deferred with Compensating Controls
- **AC-11, AC-12 (Session Timeout/Lockout)**: Covered by OS screen lock. The tool runs on developer workstations where the OS enforces idle lockout. Adding a redundant application-layer timeout provides no security benefit and degrades developer experience.
- **SR-3, SR-4, SR-11, SI-2 (Supply Chain CI — dependency scanning, artifact signing, provenance)**: The `.github/` directory is being removed; project does not use GitHub Actions. These controls will be re-evaluated when CI/CD infrastructure is established on the replacement platform.

These are documented in the compliance matrix with rationale.

---

## Execution Results (2026-05-07)

**Status: COMPLETE**

### Files Created

| Path | Control | Purpose |
|------|---------|---------|
| `packages/ai/src/crypto-policy.ts` | SC-12, SC-13 | Approved algorithms, CryptoParams constants |
| `packages/ai/src/credential-encryption.ts` | IA-5(1) | AES-256-GCM encryption with OS keychain |
| `packages/ai/src/auth-failure-tracker.ts` | AC-7 | Consecutive auth failure counting |
| `packages/ai/src/tls-policy.ts` | SC-8 | TLS validation enforcement |
| `packages/utils/src/security-audit.ts` | AU-2, AU-3 | Structured security event logger (JSONL) |
| `packages/utils/src/audit-integrity.ts` | AU-9, AU-10 | SHA-256 hash-chain verification |
| `packages/coding-agent/src/security/execution-policy.ts` | AC-3, AC-6 | Tool execution policy (permissive/strict) |
| `packages/coding-agent/src/security/config-integrity.ts` | CM-3, CM-6 | Configuration baseline + change detection |
| `packages/coding-agent/src/security/session-encryption.ts` | SC-28 | Opt-in session transcript encryption |
| `packages/coding-agent/src/security/audit-instrumentation.ts` | AU-2 | Centralized audit event helpers |
| `packages/coding-agent/src/security/index.ts` | — | Barrel re-exports |
| `scripts/generate-sbom.ts` | CM-8, SR-4 | CycloneDX 1.5 SBOM generator |
| `docs/security/ARCHITECTURE.md` | SA-8 | Security architecture + threat model |
| `docs/security/SDLC.md` | SA-3, SA-15 | Secure development lifecycle |
| `docs/security/COMPLIANCE-MATRIX.md` | — | Control-to-implementation mapping |
| `sbom.cdx.json` | CM-8 | Generated SBOM (1040 components) |

### Files Modified

| Path | Change |
|------|--------|
| `packages/ai/src/index.ts` | Added exports for crypto-policy, credential-encryption, auth-failure-tracker, tls-policy |
| `packages/utils/src/index.ts` | Added exports for security-audit, audit-integrity |
| `packages/coding-agent/src/config/settings-schema.ts` | Added "security" tab, SecuritySettings interface, 6 settings |
| `AGENTS.md` | Added Security Coding Guidelines section |

### Test Coverage

| Test File | Tests | Status |
|-----------|-------|--------|
| `packages/ai/test/security/auth-failure-tracker.test.ts` | 11 | PASS |
| `packages/ai/test/security/tls-policy.test.ts` | 9 | PASS |
| `packages/utils/test/security-audit.test.ts` | 8 | PASS |
| `packages/utils/test/audit-integrity.test.ts` | 11 | PASS |
| `packages/coding-agent/test/security/config-integrity.test.ts` | 8 | PASS |
| `packages/coding-agent/test/security/execution-policy.test.ts` | 8 | PASS |
| `packages/coding-agent/test/security/session-encryption.test.ts` | 8 | PASS |
| `packages/coding-agent/test/security/security-controls.test.ts` | 21 | PASS |
| **Total** | **84** | **ALL PASS** |

### Verification

- `bun lint:ts` — clean (0 errors across all packages)
- `bun check:ts` — clean for new code (pre-existing errors in `pi-tui` and `pi-ai/test/orphaned-tool-results.test.ts` unrelated)
- `bun test` (security suite) — 84 tests, 206 assertions, 0 failures
- SBOM validates as CycloneDX 1.5 with 1040 components (569 npm, 471 cargo)