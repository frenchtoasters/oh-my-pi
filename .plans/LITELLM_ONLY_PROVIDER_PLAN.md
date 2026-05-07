# Plan: Validate HIGH Compliance + Restrict Provider Login to LiteLLM Only

## Objective

Two-part plan:
1. **Validate compliance** against NIST 800-53 HIGH baseline using existing artifacts
2. **Restrict provider login to LiteLLM only** — surgically remove the ability to `/login` to any provider other than LiteLLM, while preserving ALL provider-specific model interaction logic (caching, thinking, streaming, cost, formatting)

## Key Principle: Surgical Removal

This is NOT a wholesale provider removal. LiteLLM proxies to many backends (Anthropic, OpenAI, Google, etc.). The tool MUST retain all provider-specific behavior for interacting with models hosted behind LiteLLM. We are ONLY removing the user-facing ability to authenticate directly with providers.

**Keep everything that affects model interaction:**
- Provider descriptors and model manager options
- `KnownProvider` type union (models still have provider identifiers)
- All `packages/ai/src/providers/` streaming implementations
- `models.json` and all model metadata
- Model-specific thinking/caching/cost logic
- Auth-storage infrastructure (simplified, but still resolves API keys)
- Provider-specific message transformation
- Usage tracking per model/provider

**Remove only user-facing auth connectivity:**
- `/login` command for non-litellm providers
- `/logout` command for non-litellm providers
- OAuth login flows (the login dialog, browser-open, token-paste)
- Provider selection UI in the OAuth selector
- The standalone `bunx @oh-my-pi/pi-ai login` CLI for non-litellm

---

## Context

### Current Compliance Posture
Already at HIGH baseline (`.plans/NIST_800_53_HIGH_COMPLIANCE_PLAN.md`):
- **Implemented controls**: IA-5(1), AU-2, AU-3, AU-9, AU-10, AC-3, AC-6, AC-7, CM-3, CM-6, CM-8, SC-8, SC-12, SC-13, SC-28, SI-7, SA-8, SA-3
- **Deferred controls**: AC-11, AC-12, SR-3, SR-4, SR-11 (with compensating measures)
- **84 passing security tests** across all packages
- Compliance matrix: `docs/security/COMPLIANCE-MATRIX.md`

### Current Provider Login Architecture
- **OAuth login flows** (`packages/ai/src/cli.ts`): 20+ providers with browser-based OAuth, API key paste
- **Slash command** `/login` (`packages/coding-agent/src/slash-commands/builtin-registry.ts`): Opens OAuth selector, handles provider-specific flows
- **OAuth selector UI** (`packages/coding-agent/src/modes/components/oauth-selector.ts`): Lists all providers for user selection
- **Login dialog UI** (`packages/coding-agent/src/modes/components/login-dialog.ts`): Browser URL display + token input
- **OAuth utilities** (`packages/ai/src/utils/oauth/`): Per-provider login modules

### What Stays Intact
- `packages/ai/src/providers/` — ALL streaming/API format implementations
- `packages/ai/src/provider-models/descriptors.ts` — ALL provider descriptors
- `packages/ai/src/provider-models/openai-compat.ts` — ALL model manager options
- `packages/ai/src/types.ts` — `KnownProvider` type unchanged
- `packages/ai/src/auth-storage.ts` — Credential store stays (might still need it for env-var based keys per provider routed through LiteLLM)
- `packages/ai/src/model-thinking.ts` — Thinking logic
- `packages/ai/src/model-cache.ts` — Model caching
- `packages/ai/src/models.json` — Full model catalog
- `packages/ai/src/usage/` — All usage tracking
- `packages/ai/src/stream.ts` — Streaming
- `packages/ai/src/providers/register-builtins.ts` — Provider registration
- `packages/coding-agent/src/config/model-registry.ts` — Model registry unchanged (still loads all providers)
- `packages/coding-agent/src/config/settings-schema.ts` — Provider settings unchanged

---

## Part 1: HIGH Baseline Compliance Validation

### Assessment
The existing compliance matrix targets HIGH baseline. Current posture:

| Status | Count | Detail |
|--------|-------|--------|
| Implemented | 17 controls | With source code and tests |
| Deferred | 5 controls | With compensating measures |
| Not-applicable | Organizational families | PE, MP, MA, CP, AT, PS, PL, RA, CA, IR |

### Additional HIGH Controls Check
- **AU-6(1)** (Automated audit review): Compensated by integrity-protected logs. Acceptable for CLI.
- **SC-3** (Security function isolation): Already isolated in separate modules.
- **SI-4** (System monitoring): Security events emitted and logged. Acceptable for CLI.
- **SA-10** (Developer configuration management): Git + lockfiles. Satisfied.

### Post-Change: Update Compliance Matrix
Document that restricting login to LiteLLM-only reduces the authentication attack surface (fewer credential storage paths, simplified IA-5 scope).

---

## Part 2: Restrict Login to LiteLLM Only

### Phase 1: Restrict `/login` Slash Command

**File**: `packages/coding-agent/src/slash-commands/builtin-registry.ts`

**Change**: Modify the `/login` command handler to only allow `litellm` as a provider argument. If no argument is given or any other provider is specified, show a message that only LiteLLM login is supported.

- Keep the `/login` command itself (it still works for `litellm`)
- When user types `/login` with no args: directly invoke LiteLLM login (no provider selector)
- When user types `/login litellm`: invoke LiteLLM login
- When user types `/login <anything-else>`: show error "Only LiteLLM provider login is supported. Configure other providers via LITELLM_BASE_URL."

### Phase 2: Restrict OAuth Selector

**File**: `packages/coding-agent/src/modes/components/oauth-selector.ts`

**Change**: Filter the provider list to only show `litellm`. Alternatively, bypass the selector entirely and go straight to LiteLLM login flow when `/login` is invoked.

**File**: `packages/coding-agent/src/modes/controllers/selector-controller.ts`

**Change**: When `showOAuthSelector` is called for "login" mode, skip the selector and directly start LiteLLM login.

### Phase 3: Restrict Standalone CLI

**File**: `packages/ai/src/cli.ts`

**Change**: In the `login` command handler:
- Remove all provider cases except `litellm`
- When no provider arg is given: default to `litellm` (no interactive selection)
- When a non-litellm provider is specified: show error message
- Keep `status` command (still useful to see if litellm key is stored)
- Keep `logout` for litellm only

The `login()` function's giant switch statement (lines 68-337) gets reduced to just the litellm case.

### Phase 4: Restrict `getOAuthProviders()` List

**File**: `packages/ai/src/utils/oauth/index.ts`

**Change**: Filter `builtInOAuthProviders` to only return litellm in the `getOAuthProviders()` function. This controls what appears in any UI listing.

Alternative (preferred): Add a filter that marks all non-litellm providers as `available: false`, so they still exist for type safety but cannot be selected for login.

### Phase 5: Update `/logout` Command

**File**: `packages/coding-agent/src/slash-commands/builtin-registry.ts`

**Change**: Similar to `/login` — restrict to litellm only.

---

## Files to Modify (Complete List)

| Path | Change |
|------|--------|
| `packages/ai/src/cli.ts` | Restrict `login`/`logout` to litellm only; remove interactive provider selection for login |
| `packages/ai/src/utils/oauth/index.ts` | Filter `getOAuthProviders()` to only return litellm as available for login |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | Restrict `/login` and `/logout` to litellm only |
| `packages/coding-agent/src/modes/controllers/selector-controller.ts` | Skip OAuth selector for login, go directly to litellm |
| `docs/security/COMPLIANCE-MATRIX.md` | Add note about reduced auth surface |

## Files NOT Modified

| Path | Reason to Keep |
|------|---------------|
| `packages/ai/src/providers/*` | Model interaction logic needed for LiteLLM-proxied requests |
| `packages/ai/src/provider-models/*` | Model metadata and discovery still needed |
| `packages/ai/src/types.ts` | `KnownProvider` union still used for model resolution |
| `packages/ai/src/auth-storage.ts` | Still stores litellm API key; env var resolution |
| `packages/ai/src/utils/oauth/*.ts` (individual modules) | Token refresh logic might still be needed if LiteLLM returns OAuth tokens |
| `packages/ai/src/models.json` | Full catalog needed for any model LiteLLM routes to |
| `packages/ai/src/model-thinking.ts` | Per-model thinking config |
| `packages/ai/src/model-cache.ts` | Model metadata caching |
| `packages/ai/src/usage/*` | Usage tracking per model |
| `packages/coding-agent/src/config/model-registry.ts` | Loads all providers for model resolution |
| `packages/coding-agent/src/config/settings-schema.ts` | Provider settings still relevant |
| `packages/coding-agent/src/modes/components/login-dialog.ts` | Still used for litellm login flow |
| `packages/coding-agent/src/modes/components/oauth-selector.ts` | Still exists but filtered to litellm only |

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Keep ALL provider-specific model logic | LiteLLM routes to any backend; tool needs correct behavior for each model regardless of how it's accessed |
| Keep `KnownProvider` type unchanged | Provider identifiers are used throughout model resolution, not just auth |
| Keep `models.json` full catalog | Any model could be behind LiteLLM |
| Keep auth-storage infrastructure | Still manages litellm API key; may need OAuth refresh for litellm-issued tokens |
| Keep individual OAuth modules on disk | Token refresh might still be invoked if litellm returns refreshable tokens; dead code removal can be a follow-up |
| Only restrict user-facing login entry points | Minimal blast radius; provider plumbing stays for model interaction |
| Keep provider descriptors + model managers | Model discovery and capability metadata still needed |

---

## Verification

1. `bun check:ts` — type checking passes
2. `bun lint:ts` — no new lint violations
3. Run security test suite: `bun test packages/*/test/security/`
4. Verify `/login` with no args → triggers LiteLLM login only
5. Verify `/login anthropic` → shows "only LiteLLM supported" error
6. Verify `/login litellm` → works as before
7. Verify `bunx @oh-my-pi/pi-ai login` → defaults to litellm, no provider menu
8. Verify `bunx @oh-my-pi/pi-ai login anthropic` → error message
9. Verify model selection still works for all model types
10. Verify prompt caching, thinking budgets, cost tracking still functional
11. Verify web search still works via env-var API keys (unchanged)
