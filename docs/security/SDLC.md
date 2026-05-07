# Secure Development Lifecycle

**Controls**: SA-3 (System Development Life Cycle), SA-15 (Development Process, Standards, and Tools)

---

## Security Review Requirements

Pull requests that touch the following areas require review from a contributor familiar with the relevant security domain before merge:

- **Authentication / credential handling**: any file under `packages/ai/src/` that accesses or modifies stored credentials, OAuth flows, or key derivation.
- **Execution policy**: `packages/coding-agent/src/security/execution-policy.ts` and any caller that invokes `checkCommand` or `checkFilePath`.
- **Network / TLS configuration**: `packages/ai/src/tls-policy.ts`, provider clients, or any code that constructs outbound HTTPS connections.
- **Audit infrastructure**: `packages/utils/src/security-audit.ts`, `packages/utils/src/audit-integrity.ts`, and any caller of `emitSecurityEvent`.
- **Cryptographic parameters**: `packages/ai/src/crypto-policy.ts` and any direct use of `node:crypto`.

Reviewers must verify:
1. No plaintext credential appears in logs, audit events, or session transcripts.
2. Algorithm selections match `CryptoParams` and `APPROVED_*` constants.
3. Error paths emit the appropriate `SecurityEventType` (e.g., `AUTH_FAILURE`, `PERMISSION_DENIED`).
4. New execution paths that bypass `ExecutionPolicy` are explicitly justified.

---

## Dependency Policy

- **Lockfiles committed**: `bun.lock` is committed and must not diverge from `package.json` manifests.
- **Monthly review**: dependencies are reviewed monthly for known CVEs using `bun audit` (or equivalent).
- **CRITICAL CVEs**: updated within 48 hours of public disclosure; a security event is logged in the project changelog.
- **New dependencies**: must be justified in the PR description; transitive dependency count is considered.
- **Pinned versions**: production dependencies use exact versions or narrow ranges; floating `latest` is prohibited in `package.json`.

---

## Security Testing

Before every release, run the security test suite:

```
bun test packages/ai/test/security/ packages/coding-agent/test/security/ packages/utils/test/
```

These tests cover:
- `auth-failure-tracker.test.ts`: lockout behavior on repeated auth failures (AC-7)
- `tls-policy.test.ts`: TLS version enforcement (SC-8)
- `packages/coding-agent/test/security/`: execution policy, config integrity, session encryption

All tests must pass with zero failures. Test suppression (`.skip`, `.todo`) on security tests is prohibited without a linked issue.

---

## Static Analysis

**TypeScript**: Biome is the project linter (`bun run lint:ts`). Security-relevant rules enforced:
- No `any` type annotations in security modules (enforced in AGENTS.md).
- No `// @ts-ignore` in `packages/ai/src/` or `packages/utils/src/security-*.ts`.

**Rust** (native addon): Clippy runs via `bun run lint:rs`. `unsafe` blocks require a comment justifying necessity.

Static analysis must pass (`bun run check`) before a release tag is created.

---

## Vulnerability Disclosure

See `.github/SECURITY.md` for the coordinated disclosure policy, contact information, and embargo timelines.

---

## Release Checklist

Before tagging a release:

1. **Tests pass**: `bun run test` — zero failures, including security suite.
2. **Static analysis**: `bun run check` — zero errors.
3. **SBOM generated**: `bun run scripts/generate-sbom.ts` — output committed or attached to release.
4. **Audit log verification**: `verifyAuditLog()` confirms no integrity violations in the development audit log.
5. **Config baseline**: confirm `saveBaseline()` reflects the intended shipped config; document any intentional changes.
6. **Dependency audit**: `bun audit` — no unresolved HIGH or CRITICAL findings.
7. **Lockfile consistency**: `bun install --frozen-lockfile` succeeds (no unintended lockfile drift).
