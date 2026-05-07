# NIST 800-53 HIGH Compliance Matrix

**Baseline**: NIST SP 800-53 Rev 5 HIGH Impact

Last updated: 2026-05-07

## Summary

| Status | Count |
|---|---|
| Satisfied | ~120 |
| Not-applicable | ~230 |
| Partial (with compensating) | ~20 |
| **Total (HIGH baseline)** | **370** |

---

## Implemented Controls

| Control ID | Control Name | Status | Implementation | Test Coverage |
|---|---|---|---|---|
| IA-5.1 | Authenticator Management | Implemented | `packages/ai/src/credential-encryption.ts` | `packages/ai/test/security/` |
| AU-2 | Audit Events | Implemented | `packages/utils/src/security-audit.ts` | `packages/utils/test/security-audit.test.ts` |
| AU-3 | Content of Audit Records | Implemented | `SecurityEvent` interface with full record fields | `packages/utils/test/security-audit.test.ts` |
| AU-3.1 | Additional Audit Information | Implemented | sessionId correlation, PID in metadata | `packages/utils/test/security-audit.test.ts` |
| AU-4 | Audit Log Storage Capacity | Implemented | `packages/utils/src/audit-capacity.ts` | `packages/utils/test/audit-capacity.test.ts` |
| AU-5 | Response to Audit Failures | Implemented | `AuditCapacityMonitor.ensureCapacity()` fail-safe | `packages/utils/test/audit-capacity.test.ts` |
| AU-5.1 | Storage Capacity Warning | Implemented | Configurable threshold (80% default) | `packages/utils/test/audit-capacity.test.ts` |
| AU-7 | Audit Reduction and Report | Implemented | `packages/utils/src/audit-report.ts` | `packages/utils/test/audit-report.test.ts` |
| AU-9 | Protection of Audit Information | Implemented | SHA-256 hash chain, 0o600 permissions | `packages/utils/test/audit-integrity.test.ts` |
| AU-9.3 | Cryptographic Protection | Implemented | HMAC-SHA256 record authentication | `packages/utils/test/audit-integrity.test.ts` |
| AU-10 | Non-Repudiation | Implemented | Hash chain linking entries | `packages/utils/test/audit-integrity.test.ts` |
| AU-12.1 | System-Wide Audit Trail | Implemented | sessionId correlation across components | `packages/utils/test/security-audit.test.ts` |
| AC-3 | Access Enforcement | Implemented | `execution-policy.ts` allow/deny lists | `packages/coding-agent/test/security/` |
| AC-6 | Least Privilege | Implemented | Strict mode: only allowed commands execute | `packages/coding-agent/test/security/` |
| AC-6.9 | Log Privileged Functions | Implemented | TOOL_EXECUTION/CONFIG_CHANGE audit events | `packages/coding-agent/test/security/` |
| AC-7 | Unsuccessful Logon Attempts | Implemented | `auth-failure-tracker.ts` lockout | `packages/ai/test/security/` |
| AC-8 | System Use Notification | Implemented | `packages/coding-agent/src/security/system-banner.ts` | `packages/coding-agent/test/security/access-control.test.ts` |
| AC-10 | Concurrent Session Control | Partial | `session-management.ts` PID file check (advisory, non-atomic) | `packages/coding-agent/test/security/access-control.test.ts` |
| CM-3 | Configuration Change Control | Implemented | `config-integrity.ts` SHA-256 baseline | `packages/coding-agent/test/security/` |
| CM-6 | Configuration Settings | Implemented | Typed config with validation | `packages/coding-agent/test/security/` |
| CM-7.2 | Prevent Program Execution | Implemented | Deny list in execution-policy.ts | `packages/coding-agent/test/security/` |
| CM-8 | System Component Inventory | Implemented | CycloneDX SBOM generation | `sbom.cdx.json` |
| SC-4 | Information in Shared Resources | Implemented | `CredentialEncryption.dispose()` zeroes buffers | `packages/coding-agent/test/security/fail-safe.test.ts` |
| SC-5 | Denial of Service Protection | Implemented | `packages/coding-agent/src/security/resource-limits.ts` | `packages/coding-agent/test/security/integrity.test.ts` |
| SC-7.18 | Fail Secure | Implemented | `fail-safe.ts` degraded mode | `packages/coding-agent/test/security/fail-safe.test.ts` |
| SC-8 | Transmission Confidentiality | Implemented | TLS 1.2+ via `tls-policy.ts` | `packages/ai/test/security/` |
| SC-12 | Cryptographic Key Establishment | Implemented | `crypto-policy.ts` PBKDF2/AES-256-GCM | `packages/ai/test/security/` |
| SC-13 | Cryptographic Protection | Implemented | Approved algorithms enforced | `packages/ai/test/security/` |
| SC-24 | Fail in Known State | Implemented | `packages/coding-agent/src/security/fail-safe.ts` | `packages/coding-agent/test/security/fail-safe.test.ts` |
| SC-28 | Protection of Information at Rest | Implemented | `session-encryption.ts` AES-256-GCM | `packages/coding-agent/test/security/` |
| SI-2 | Flaw Remediation | Implemented | bun audit + Dependabot | SBOM |
| SI-6 | Security Function Verification | Implemented | `packages/coding-agent/src/security/self-test.ts` | `packages/coding-agent/test/security/integrity.test.ts` |
| SI-7 | Software Integrity | Implemented | SBOM + config baseline hash | `scripts/generate-sbom.ts` |
| SI-7.1 | Integrity Checks | Implemented | Startup + configurable interval checks | `packages/coding-agent/test/security/integrity.test.ts` |
| SI-7.2 | Integrity Violation Notifications | Implemented | INTEGRITY_VIOLATION audit events | `packages/coding-agent/test/security/integrity.test.ts` |
| SI-10 | Information Input Validation | Implemented | `packages/coding-agent/src/security/input-validation.ts` | `packages/coding-agent/test/security/integrity.test.ts` |
| SI-11 | Error Handling | Implemented | Sanitized errors, no credential leakage | Code review |
| SA-3 | SDLC | Documented | `docs/security/SDLC.md` | N/A |
| SA-8 | Security Engineering Principles | Documented | `docs/security/ARCHITECTURE.md` | N/A |
| SA-9 | External System Services | Documented | `docs/security/EXTERNAL-SERVICES.md` | N/A |
| SR-2 | Supply Chain Risk Management | Documented | `docs/security/SUPPLY-CHAIN.md` | N/A |

---

## Deferred and Compensating Controls

| Control ID | Control Name | Disposition | Rationale / Compensating Measure |
|---|---|---|---|
| AC-11 | Device Lock | Deferred | OS-level screen lock (macOS auto-lock). CLI is interactive terminal. |
| AC-12 | Session Termination | Deferred | CLI exits on completion/interrupt. OS screen lock compensates. |
| AU-6 | Audit Review | Partial | JSONL logs for manual review. Automated analysis deferred to external tooling. |
| SR-3 | Supply Chain Controls | Partial | SBOM, checksums, license tracking. Formal vendor assessment deferred. |
| SR-4 | Provenance | Partial | SBOM tracking. Full cryptographic provenance deferred. |
| SR-11 | Component Authenticity | Partial | npm checksums in bun.lock. Independent signing deferred. |
| RA-5 | Vulnerability Scanning | Partial | bun audit for deps. Full DAST/SAST deferred to CI. |
| AC-10 | Concurrent Session Control | Partial | PID file check is non-atomic (TOCTOU). Acceptable for single-user CLI; advisory flock deferred. |

---

## Not-Applicable Control Families

| Family | Controls | Rationale |
|---|---|---|
| PE (Physical) | 25 | No physical facility. CLI runs on user workstations. |
| MP (Media) | 10 | No removable media. Data on local filesystem. |
| MA (Maintenance) | 12 | Software via npm. No hardware maintenance. |
| CP (Contingency) | 35 | Stateless CLI. No hosted service or BCP. |
| AT (Training) | 6 | Single-developer tool. No training system. |
| PS (Personnel) | 10 | OSS project. No employees. |
| IR (Incident) | 19 | No SOC. GitHub Security Advisories. |
| PL (Planning) | 7 | Organizational planning not applicable. |
| RA (Risk) | 7 | Organizational risk assessment not applicable. |
| CA (Assessment) | 14 | Formal security assessment not applicable to CLI. |

---

## Authentication Surface Reduction

**Date**: 2026-05-07
**Change**: Provider login restricted to LiteLLM only

Interactive login now only permits authentication with the LiteLLM provider. All other model providers are accessed exclusively through the LiteLLM proxy.

**Impact on controls:**
- **IA-5.1**: Reduced credential storage surface.
- **AC-7**: Lockout scope reduced to single provider.
- **SC-8/SC-12**: All model traffic funnels through LiteLLM proxy.

---

## Notes

- "Test Coverage" paths indicate test files or directories.
- Controls marked "Implemented" have source files and automated tests.
- Controls marked "Documented" are satisfied by policy/architecture documentation.
- This matrix reflects the state as of the last-updated date.
- Full control-by-control status is in `.plans/PLAN-2026-2540.yaml` (370 controls).
