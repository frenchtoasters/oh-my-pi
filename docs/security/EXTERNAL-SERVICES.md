# External Services Trust Model

## Overview

oh-my-pi communicates with external LLM provider APIs. This document defines the trust model and security controls for these connections.

## LLM Provider Connections

### Transport Security

- All connections use TLS 1.2+ (enforced by `packages/ai/src/tls-policy.ts`)
- Certificate validation enabled by default (`security.tlsRejectUnauthorized`)
- No plaintext HTTP connections permitted for API calls

### Authentication

- API keys stored encrypted at rest (AES-256-GCM via OS keychain)
- Keys never logged, displayed, or included in error messages
- Per-provider credential isolation

### Supported Providers

- OpenAI, Anthropic, Google (Gemini/Vertex), and OpenAI-compatible endpoints
- LiteLLM proxy support for centralized credential management
- Each provider endpoint explicitly configured; no automatic discovery

### Data Handling

- Prompts and responses transmitted over encrypted channels only
- Session transcripts optionally encrypted at rest (SC-28)
- No provider has access to local filesystem or execution environment

## Trust Boundaries

1. **Application boundary**: CLI process on user workstation
2. **Network boundary**: TLS-encrypted HTTPS to configured endpoints only
3. **Provider boundary**: API keys authenticate; provider processes requests in their infrastructure

## Risk Acceptance

- Provider-side data handling governed by provider ToS/DPA
- No independent verification of provider security posture
- Compensating: TLS encryption in transit + credential encryption at rest
