# NIST 800-53 HIGH Compliance Matrix

**Baseline**: NIST SP 800-53 Rev 5 HIGH Impact

Last updated: 2026-05-07

---

## Implemented Controls

| Control ID | Control Name | Status | Implementation | Test Coverage |
|---|---|---|---|---|
| IA-5(1) | Authenticator Management — Password-Based | Implemented | `packages/ai/src/credential-encryption.ts` | `packages/ai/test/security/` |
| AU-2 | Audit Events | Implemented | `packages/utils/src/security-audit.ts` — `SecurityAuditLogger`, `emitSecurityEvent` | `packages/utils/test/` |
| AU-3 | Content of Audit Records | Implemented | `SecurityEvent` interface: eventId, timestamp, actor, resource, outcome, metadata, prevHash | `packages/utils/test/` |
| AU-9 | Protection of Audit Information | Implemented | `packages/utils/src/audit-integrity.ts` — SHA-256 hash chain, 0o600 log permissions, `verifyAuditLog()` | `packages/utils/test/` |
| AU-10 | Non-Repudiation | Implemented | Hash-chained audit log (each entry commits to previous line's SHA-256) | `packages/utils/test/` |
| AC-3 | Access Enforcement | Implemented | `packages/coding-agent/src/security/execution-policy.ts` — `ExecutionPolicy.checkCommand`, `checkFilePath` | `packages/coding-agent/test/security/` |
| AC-6 | Least Privilege | Implemented | `ExecutionPolicy` strict mode; agent runs as invoking user UID; no privilege escalation | `packages/coding-agent/test/security/` |
| AC-7 | Unsuccessful Logon Attempts | Implemented | `packages/ai/src/auth-failure-tracker.ts` — consecutive failure tracking, lockout | `packages/ai/test/security/auth-failure-tracker.test.ts` |
| CM-3 | Configuration Change Control | Implemented | `packages/coding-agent/src/security/config-integrity.ts` — `computeConfigHash`, `saveBaseline`, `verifyConfigIntegrity`; `CONFIG_CHANGE` event emitted on deviation | `packages/coding-agent/test/security/` |
| CM-6 | Configuration Settings | Implemented | Config baseline verification via `verifyConfigIntegrity()`; divergence triggers `INTEGRITY_VIOLATION` audit event | `packages/coding-agent/test/security/` |
| CM-8 | System Component Inventory | Implemented | `scripts/generate-sbom.ts` — generates SBOM at release time | SBOM validation (release checklist) |
| SC-8 | Transmission Confidentiality and Integrity | Implemented | `packages/ai/src/tls-policy.ts` — minimum TLS 1.2 enforced on all provider connections | `packages/ai/test/security/tls-policy.test.ts` |
| SC-12 | Cryptographic Key Establishment and Management | Implemented | `packages/ai/src/crypto-policy.ts` — `CryptoParams`, approved algorithm lists, `assertMinPbkdf2Iterations`; master keys in OS keychain | `packages/ai/test/security/` |
| SC-13 | Cryptographic Protection | Implemented | `CryptoParams.aes256gcm` (AES-256-GCM) for encryption; `APPROVED_SYMMETRIC_ALGORITHMS` enforced at runtime; SHA-256 for hash chains | `packages/ai/test/security/` |
| SC-28 | Protection of Information at Rest | Implemented | `packages/coding-agent/src/security/session-encryption.ts` (session transcripts); `packages/ai/src/credential-encryption.ts` (credentials) | `packages/coding-agent/test/security/` |
| SI-7 | Software, Firmware, and Information Integrity | Implemented | SBOM via `scripts/generate-sbom.ts`; committed lockfiles (`bun.lock`); config baseline hash verification | `scripts/generate-sbom.ts`, release checklist |
| SA-8 | Security and Privacy Engineering Principles | Documented | `docs/security/ARCHITECTURE.md` — trust boundaries, data flows, STRIDE threat model, cryptographic inventory | N/A |
| SA-3 | System Development Life Cycle | Documented | `docs/security/SDLC.md` — security review gates, dependency policy, security testing, static analysis, release checklist | N/A |

---

## Deferred and Compensating Controls

| Control ID | Control Name | Disposition | Rationale / Compensating Measure |
|---|---|---|---|
| AC-11 | Device Lock | Deferred | No in-process session timeout implemented. Compensating control: OS-level screen lock (macOS auto-lock) protects an unattended workstation. Residual risk accepted for local single-user deployment. |
| AC-12 | Session Termination | Deferred | Explicit session timeout deferred. Sessions terminated by user action or process exit. Compensating control: OS screen lock. |
| SR-3 | Supply Chain Controls — Acquisition Strategies | Deferred | No formal CI pipeline or automated supply-chain tooling deployed. Partially mitigated by committed lockfiles and monthly manual dependency review (see SDLC.md). |
| SR-4 | Provenance | Deferred | Artifact provenance attestation (e.g., SLSA) not yet implemented. Mitigated by SBOM generation at release time. |
| SR-11 | Component Authenticity | Deferred | No automated CI-based dependency signature verification. Mitigated by `bun.lock` integrity and manual audit process. |

---

## Notes

- "Test Coverage" paths indicate test directories, not individual test files, unless a specific file is the primary coverage vehicle.
- Controls marked "Implemented" have corresponding source files and at minimum one automated test exercising the control behavior.
- Controls marked "Documented" are satisfied by policy/architecture documentation rather than runtime code.
- This matrix reflects the state of the codebase as of the last-updated date above. It must be updated when controls are added, removed, or the implementation file changes.
