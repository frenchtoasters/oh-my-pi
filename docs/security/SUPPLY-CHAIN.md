# Supply Chain Risk Management

## Overview

oh-my-pi manages supply chain risk through dependency tracking, integrity verification, and automated vulnerability monitoring.

## Dependency Management

- All dependencies tracked in `package.json` and `bun.lock` with integrity checksums
- SBOM generated in CycloneDX format (`sbom.cdx.json`) via `scripts/generate-sbom.ts`
- Lockfile ensures reproducible builds with verified checksums

## Vulnerability Monitoring

- `bun audit` for known vulnerability scanning
- GitHub Dependabot for automated dependency update PRs
- GitHub Security Advisories for disclosure

## Integrity Verification

- npm registry packages verified by registry checksums in bun.lock
- No unsigned or unverified packages permitted
- License compliance tracked in SBOM

## Risk Acceptance

- Full cryptographic provenance verification deferred (SR-4 partial)
- Independent artifact signing verification not implemented (SR-11 partial)
- Compensating: npm registry integrity + lockfile checksums provide baseline assurance

## Rust Dependencies

- Managed via Cargo.toml/Cargo.lock with checksum verification
- `cargo audit` available for vulnerability scanning
