# Plan: Close NIST 800-53 HIGH Baseline Compliance Gaps

## Objective

Achieve full NIST 800-53 HIGH baseline coverage in the ai-dev compliance system by:
1. Implementing the most impactful technical controls (audit, access, integrity, crypto)
2. Classifying all non-applicable organizational/physical controls with documented rationale
3. Recording all decisions for deferred controls with compensating measures
4. **Target**: `check_compliance` returns 0 unchecked controls — every control is either `satisfied`, `not-applicable`, or `partial` with documented compensating measures

## ai-dev MCP Plan

**Plan ID**: `PLAN-2026-2540` (already exists in `.plans/PLAN-2026-2540.yaml`)
**Binary**: `/Users/tfrench/.nmc/ai-dev/target/release/ai-dev`
**Invocation**: Interact via JSON-RPC on stdio (`ai-dev serve`) or validate via `ai-dev validate .plans/`

## Critical Implementation Detail: Control ID Format

The ai-dev validator requires control IDs in format `XX-<digits>` (e.g., `AC-2`). Enhancement IDs use **dot notation**: `AC-2.1`, `IA-5.1` — NOT parentheses `AC-2(1)`.

The existing `PLAN-2026-2540` has 12 validation errors from parenthesized IDs in decisions' `controls_affected`. Fix by editing the YAML directly with dot-notation IDs.

## Current State

**Already implemented (20 controls):**
- IA-5.1, AU-2, AU-3, AU-9, AU-10, AC-3, AC-6, AC-7, CM-3, CM-6, CM-8, SC-8, SC-12, SC-13, SC-28, SI-7, SA-3, SA-8, SI-2, CM-3.2

**Existing implementation files:**
- `packages/ai/src/crypto-policy.ts` — SC-12, SC-13
- `packages/ai/src/credential-encryption.ts` — IA-5.1
- `packages/ai/src/auth-failure-tracker.ts` — AC-7
- `packages/ai/src/tls-policy.ts` — SC-8
- `packages/utils/src/security-audit.ts` — AU-2, AU-3
- `packages/utils/src/audit-integrity.ts` — AU-9, AU-10
- `packages/coding-agent/src/security/execution-policy.ts` — AC-3, AC-6
- `packages/coding-agent/src/security/config-integrity.ts` — CM-3, CM-6
- `packages/coding-agent/src/security/session-encryption.ts` — SC-28
- `packages/coding-agent/src/security/audit-instrumentation.ts` — AU-2 helpers
- `scripts/generate-sbom.ts` — CM-8, SI-7
- `docs/security/ARCHITECTURE.md` — SA-8
- `docs/security/SDLC.md` — SA-3

**Deferred (5):** AC-11, AC-12, SR-3, SR-4, SR-11

**Unchecked:** 359 controls (in plan YAML)

## Approach

### Strategy: Code + Documentation

1. **Implement ~25 high-priority technical controls** with new code and tests
2. **Document ~160 organizational controls as not-applicable** with rationale
3. **Map ~50 controls to existing implementations** as `satisfied`
4. **Record ~30 controls as `partial` or deferred** with compensating measures

### Control Family Disposition (HIGH baseline: 370 total)

| Family | Controls | Disposition |
|--------|----------|-------------|
| AC (46) | ~8 implemented, ~15 not-applicable (wireless/mobile/external), ~15 implement, ~8 partial |
| AU (25) | ~5 implemented, ~10 implement, ~5 document, ~5 partial |
| CM (32) | ~3 implemented, ~15 implement/document, ~14 partial/NA |
| IA (26) | ~2 implemented, ~15 not-applicable (PIV/MFA/identity proofing), ~9 implement/document |
| SC (30) | ~5 implemented, ~10 not-applicable (DNS/wireless/PKI), ~10 implement, ~5 partial |
| SI (28) | ~2 implemented, ~10 not-applicable (spam/wireless/malware), ~10 implement, ~6 partial |
| SA (21) | ~2 implemented, ~5 implement/document, ~14 partial/NA |
| SR (14) | ~1 implemented, ~5 not-applicable (physical), ~8 partial/document |
| PE (24) | All not-applicable — no physical facility |
| MP (10) | All not-applicable — no removable media |
| MA (12) | All not-applicable — no hardware maintenance |
| CP (34) | All not-applicable — no hosted service |
| AT (6) | All not-applicable — no personnel training |
| PS (9) | All not-applicable — no personnel management |
| IR (18) | All not-applicable — no SOC/CSIRT |
| PL (7) | All not-applicable — organizational process |
| RA (11) | ~1 partial (RA-5 via bun audit), rest not-applicable |

## Phases

### Phase 1: Fix Plan YAML & Bulk Classification (~30 min)

**Goal**: Fix validation errors and classify all organizational controls.

1. Edit `.plans/PLAN-2026-2540.yaml` directly:
   - Fix parenthesized IDs to dot notation in decisions' `controls_affected`
   - Add `controls_checked` entries for ALL 370 controls with appropriate status
2. Mark organizational families (PE, MP, MA, CP, AT, PS, IR, PL, RA) as `not-applicable`
3. Mark existing implementations as `satisfied` with evidence narratives
4. Mark technical controls to implement as `gap` (temporarily)
5. Run `ai-dev validate .plans/` — must pass with 0 errors

### Phase 2: Audit Enhancements (AU family)

**New controls**: AU-3.1, AU-4, AU-5, AU-5.1, AU-5.2, AU-6, AU-6.1, AU-7, AU-7.1, AU-8, AU-9.3, AU-9.4, AU-11, AU-12, AU-12.1, AU-12.3

**Files to create/modify:**
| File | Purpose |
|------|---------|
| `packages/utils/src/audit-capacity.ts` | AU-4, AU-5, AU-5.1: log capacity monitor, failure response |
| `packages/utils/src/audit-report.ts` | AU-7, AU-7.1: record reduction, report generation |
| `packages/utils/src/security-audit.ts` | AU-3.1: additional audit info (session ID, source), AU-8: UTC timestamps, AU-12.1: correlation IDs |
| `packages/utils/src/audit-integrity.ts` | AU-9.3: add HMAC option |
| `packages/utils/test/audit-capacity.test.ts` | Tests for AU-4, AU-5 |
| `packages/utils/test/audit-report.test.ts` | Tests for AU-7 |

**Implementation:**
- `AuditCapacityMonitor`: check log dir size on write, emit warning at 80%, fail-safe at 95%
- `AuditReportGenerator`: filter/reduce/export audit records by date/type/actor
- Add `sessionId` field to `SecurityEvent` for cross-session correlation (AU-12.1)
- HMAC-SHA256 option for audit entries using OS keychain key (AU-9.3)
- Retention policy: auto-rotate logs older than configurable days (AU-11)

### Phase 3: Access Control Enhancements (AC family)

**New controls**: AC-2, AC-4, AC-6.1, AC-6.9, AC-8, AC-10, AC-14, AC-17, AC-17.1, AC-17.2

**Files to create/modify:**
| File | Purpose |
|------|---------|
| `packages/coding-agent/src/security/system-banner.ts` | AC-8: system use notification |
| `packages/coding-agent/src/security/session-management.ts` | AC-10: concurrent session control |
| `packages/coding-agent/src/security/execution-policy.ts` | AC-6.1, AC-6.9: privileged function access/logging |
| `packages/coding-agent/test/security/session-management.test.ts` | Tests |
| `packages/coding-agent/test/security/system-banner.test.ts` | Tests |

**Implementation:**
- **AC-8**: Configurable security banner on session start (setting: `security.banner`)
- **AC-10**: PID file + advisory lock in `~/.omp/agent.pid`; warn if another instance running
- **AC-6.1/AC-6.9**: Log when security settings are modified; audit event for privileged operations
- **AC-14**: Document what actions are permitted without auth (local file read, etc.)
- **AC-17.2**: Document that all remote access (to LLM providers) uses TLS encryption

### Phase 4: System Integrity & Input Validation (SI family)

**New controls**: SI-4, SI-6, SI-7.1, SI-7.2, SI-10, SI-11, SI-12

**Files to create/modify:**
| File | Purpose |
|------|---------|
| `packages/coding-agent/src/security/self-test.ts` | SI-6: security function verification on startup |
| `packages/coding-agent/src/security/input-validation.ts` | SI-10: input validation rules |
| `packages/coding-agent/src/security/resource-limits.ts` | SI-4(partial): monitoring, SC-5: DoS protection |
| `packages/coding-agent/test/security/self-test.test.ts` | Tests |
| `packages/coding-agent/test/security/input-validation.test.ts` | Tests |
| `packages/coding-agent/test/security/resource-limits.test.ts` | Tests |

**Implementation:**
- **SI-6**: On startup, verify audit logger writes, config integrity check runs, crypto functions available
- **SI-7.1**: Periodic config integrity check (not just startup)
- **SI-7.2**: Emit notification (audit event) when integrity violation detected
- **SI-10**: Validate tool arguments against schema before execution; reject path traversal
- **SI-11**: Review all error handlers — ensure no credential/key material in error messages
- **SI-12**: Document data retention (sessions, logs) and implement configurable retention

### Phase 5: Configuration & Communications (CM + SC families)

**New controls**: CM-2, CM-3.1, CM-4, CM-5, CM-5.1, CM-7, CM-7.2, SC-4, SC-5, SC-7, SC-7.5, SC-7.18, SC-23, SC-24, SC-28.1, SC-39

**Files to create/modify:**
| File | Purpose |
|------|---------|
| `packages/coding-agent/src/security/fail-safe.ts` | SC-24: fail in known state |
| `packages/coding-agent/src/security/resource-limits.ts` | SC-5: resource caps |
| `packages/ai/src/credential-encryption.ts` | SC-4: memory cleanup |
| `packages/coding-agent/src/security/execution-policy.ts` | CM-7.2: prevent program execution |
| `packages/coding-agent/test/security/fail-safe.test.ts` | Tests |

**Implementation:**
- **SC-4**: Zero-fill credential buffers after use (TypedArray for sensitive data)
- **SC-5**: Configurable limits: max output size, max concurrent tool calls, max session size
- **SC-24**: On security function failure (e.g., audit write fails), enter degraded mode — refuse tool execution until resolved
- **SC-7.5**: Execution policy default-deny for strict mode (deny unless explicitly allowed)
- **CM-7.2**: Extend execution policy block list
- **SC-28.1**: Document that SC-28 (data at rest) uses AES-256-GCM (already implemented)

### Phase 6: Supply Chain & Assurance Documentation (SA + SR families)

**New/modified docs:**
| File | Purpose |
|------|---------|
| `docs/security/SUPPLY-CHAIN.md` | SR-2, SR-5, SR-6, SR-8: supply chain risk management |
| `docs/security/EXTERNAL-SERVICES.md` | SA-9, SA-9.2: external system services trust model |
| `docs/security/SDLC.md` | SA-11, SA-15, SA-15.3: extend developer testing and process docs |
| `docs/security/ARCHITECTURE.md` | SA-17: extend with security architecture rationale |

### Phase 7: Finalize Plan & Verify

1. Update all `gap` controls in plan YAML to `satisfied` or `not-applicable` with narratives
2. Record any new decisions made during implementation
3. Run verification:
   - `ai-dev validate .plans/` → 0 errors
   - `check_compliance PLAN-2026-2540 high` → 0 unchecked, 0 gaps
   - `bun test packages/ai/test/security/ packages/coding-agent/test/security/ packages/utils/test/` → all pass
   - `bun check:ts` on security modules → clean
   - `bun lint:ts` on security modules → clean
4. Update `docs/security/COMPLIANCE-MATRIX.md` with all new controls
5. Regenerate SBOM if dependencies changed

## Verification Criteria

| Check | Command | Expected |
|-------|---------|----------|
| Plan validation | `ai-dev validate .plans/` | 0 errors |
| Compliance check | MCP `check_compliance` HIGH baseline | 0 unchecked, 0 gaps |
| Security tests | `bun test packages/*/test/security/` + utils audit tests | All pass, 120+ tests |
| Type check | `bun check:ts` (security files) | Clean |
| Lint | `bun lint:ts` (security files) | Clean |
| SBOM | `sbom.cdx.json` valid CycloneDX | 1000+ components |

## Key Decisions (Pre-recorded)

1. **PLAN-2026-2540-DEC-001**: PE/MP/MA/CP/AT/PS/IR/PL/RA families classified as not-applicable (CLI tool, no infrastructure)
2. **PLAN-2026-2540-DEC-002**: MFA/PIV deferred to provider layer (compensating: LiteLLM proxy auth)
3. **PLAN-2026-2540-DEC-003**: Wireless/mobile/external controls not-applicable (no infrastructure)

## Not-Applicable Control Rationale Summary

| Family | Rationale |
|--------|-----------|
| PE (24) | No physical facility; CLI runs on user's workstation |
| MP (10) | No removable media handling; all data is digital filesystem |
| MA (12) | No hardware to maintain; software updates via package manager |
| CP (34) | No hosted service; no business continuity requirement for a CLI |
| AT (6) | Single-developer tool; no personnel training system |
| PS (9) | No employees/contractors to manage; open-source project |
| IR (18) | No SOC/CSIRT; incidents handled via GitHub security advisory |
| PL (7) | Organizational security planning; not applicable to CLI tool |
| RA (11) | Organizational risk assessment (except RA-5 partially via `bun audit`) |
| AC-18/19/20 | No wireless radio, no MDM, no external system connection management |
| IA-2.1/2.2/2.5/2.8/2.12 | Single-user CLI; MFA at provider level |
| IA-3/12 | No device auth or identity proofing; delegated to OS |
| SC-15/17/18/20/21/22 | No collaborative computing, PKI, mobile code, or DNS infrastructure |
| SI-3/8 | No malware scanner or spam protection; delegated to OS |
| SR-9/10/11.1/11.2/12 | Physical supply chain controls; software-only distribution |
