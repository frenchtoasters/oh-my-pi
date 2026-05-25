# Plan: Strip to LiteLLM-Only Provider Access

## Objective

Remove all LLM providers except those needed for LiteLLM-exclusive access. Keep only three API types that `inferLitellmApi()` returns: `anthropic-messages`, `google-generative-ai`, and `openai-completions`. Remove all other providers, OpenAI-compat services, and their associated infrastructure.

## Traced LiteLLM Message Flow (PRESERVE THIS ENTIRE PATH)

**Entry:** `streamSimple()` (stream.ts:267) is the primary caller-facing function.

1. **Key resolution:** `getEnvApiKey("litellm")` → reads `LITELLM_API_KEY` from `serviceProviderMap` (line 148)
2. **Pre-dispatch predicates:** `isGitLabDuoModel()`, `isKimiModel()`, `isSyntheticModel()` — none match LiteLLM models → falls through to `mapOptionsForApi()`
3. **Option mapping:** `mapOptionsForApi()` (line 429) switches on `model.api`:
   - `"anthropic-messages"` → builds thinking params (budget/adaptive/interleaved)
   - `"google-generative-ai"` → builds thinking params (level or budget)
   - `"openai-completions"` → builds reasoning effort + tool choice
4. **Stream dispatch:** `stream()` (line 179) switches on `model.api`:
   - `"anthropic-messages"` → `streamAnthropic()` (lazy-loaded from register-builtins)
   - `"google-generative-ai"` → `streamGoogle()` (lazy-loaded)
   - `"openai-completions"` → `streamOpenAICompletions()` (lazy-loaded)

**LiteLLM model registration (provider-models/openai-compat.ts:1482):**
- `litellmModelManagerOptions()` calls `fetchOpenAICompatibleModels()` (from `utils/discovery/openai-compatible.ts`) against LiteLLM's `/models` endpoint
- For each model, `inferLitellmApi()` (line 1436) checks the model ID:
  - `anthropic/`, `claude` → `"anthropic-messages"`
  - `google/`, `vertex_ai/`, `gemini` → `"google-generative-ai"`
  - Everything else → `"openai-completions"`
- `deriveLitellmBaseUrl()` rewrites the base URL:
  - Anthropic: `http://localhost:4000/v1` → `http://localhost:4000/anthropic`
  - Google: `http://localhost:4000/v1` → `http://localhost:4000/gemini`
  - OpenAI: keeps `http://localhost:4000/v1`
- `stripLitellmModelPrefix()` removes routing prefixes (`anthropic/`, `google/`, `bedrock/`, `vertex_ai/`) from model IDs
- Dependencies: `createBundledReferenceMap` from `./bundled-references`, `mapWithBundledReference` (local helper in openai-compat.ts), `LITELLM_PROVIDER_PREFIXES` (local constant)

**Critical: openai-completions-compat.ts detects model behavior by MODEL ID, not provider:**
- When LiteLLM routes `deepseek/deepseek-chat`, the model ID contains "deepseek" → `isDeepseekFamily = true`
- When LiteLLM routes Claude-pattern models via openai-completions, `isAnthropicModel = true`
- When LiteLLM routes Qwen models, `isQwen = true`
- Compat flags control: `requiresReasoningContentForToolCalls`, `disableReasoningOnToolChoice`, `maxTokensField`, `thinkingFormat`, etc.
- **The compat detection logic MUST be preserved mostly intact** — it ensures correct behavior for models routed through LiteLLM's openai-completions path

**openai-completions.ts — REMOVE (provider-specific auth only):**
- Lines 812-825: `model.provider === "github-copilot"` → copilot auth, headers, base URL — REMOVE
- `copilotPremiumRequests` tracking throughout — REMOVE
- `callWithCopilotModelRetry` wrapper — REMOVE (replace with direct call)
- `rewriteCopilotError` — REMOVE
- Imports to remove: `parseGitHubCopilotApiKey`, `callWithCopilotModelRetry`, `buildCopilotDynamicHeaders`, `resolveGitHubCopilotBaseUrl`, `hasCopilotVisionInput`, `rewriteCopilotError`
- `github-copilot-headers.ts` file — DELETE

**openai-completions.ts — KEEP + REFACTOR to model-ID detection (provider="litellm" for all LiteLLM models):**
- Lines 806-808: `model.provider === "kimi-code"` → REFACTOR to `model.id.includes("moonshotai/kimi") || /^kimi[-.]/i.test(model.id)` (matches LiteLLM IDs like "kimi/kimi-k2")
- Line 902: `model.provider === "fireworks"` → REFACTOR to `model.id.startsWith("fireworks/") || model.id.includes("accounts/fireworks/")` (LiteLLM preserves prefix in openai-completions model IDs)
- Line 433: `model.provider === "minimax-code"` → REFACTOR to `/minimax/i.test(model.id)` (matches LiteLLM IDs like "minimax/...")
- Line 437: `model.provider === "nvidia" && /deepseek/i.test(model.id)` → REFACTOR to just `/deepseek/i.test(model.id)` (DeepSeek token stripping should apply regardless of host)
- Line 894: `model.provider !== "github-copilot"` → simplify to `true` (always supports reasoning)
- Line 826-830: Azure OpenAI `/deployments/` URL rewriting — KEEP as-is (baseUrl-based, works for any routing)
- Line 899: `model.id.includes("moonshotai/kimi")` max_tokens — KEEP as-is (already model-ID-based)
- Line 966-972: Qwen thinking format handling — KEEP as-is (already driven by compat.thinkingFormat which is model-ID-based)
**What stays in openai-completions-compat.ts:**
- The entire `detectOpenAICompat()` function — fires on model ID patterns, not provider. Many compat behaviors affect LiteLLM-routed models (DeepSeek, Qwen, Anthropic-pattern, Mistral-pattern IDs)
- Can clean up provider-name-only checks that will never fire (e.g. `provider === "github-copilot"`, `provider === "together"`) but this is low priority and low risk to leave

## Decisions

| Decision | Rationale |
|----------|-----------|
| Keep 3 APIs only: anthropic-messages, google-generative-ai, openai-completions | `inferLitellmApi()` only returns these three. `google-gemini-cli` is never returned. |
| Remove google-gemini-cli provider | Only used by direct Gemini CLI and Antigravity access — not via LiteLLM |
| Remove google-antigravity entirely | Not accessed through LiteLLM |
| Remove GitHub Copilot support | Not accessed through LiteLLM |
| Remove ALL non-LiteLLM OpenAI-compat providers | Groq, Cerebras, xAI, Fireworks, OpenRouter, DeepSeek, Mistral, etc. — not accessed directly |
| Keep compat detection logic | Model-ID-based detection fires for LiteLLM-routed DeepSeek/Qwen/etc. |
| Remove ALL usage tracking providers | Require direct provider OAuth/API credentials, incompatible with LiteLLM-only |
| Remove ALL provider OAuth/login except LiteLLM | No direct login to Anthropic, Google, Kimi, etc. — LiteLLM is the sole auth entry point |
| Refactor provider-based model detection to model-ID-based | All LiteLLM models have provider="litellm", so provider-name checks are dead code |
| Extract kimi headers to standalone util | Model-compat behavior (not login) needed for Kimi models via LiteLLM |

## Files to DELETE

### packages/ai/src/providers/
- `amazon-bedrock.ts`
- `cursor.ts`
- `cursor/` (entire directory)
- `google-vertex.ts`
- `azure-openai-responses.ts`
- `openai-responses.ts`
- `openai-responses-shared.ts`
- `openai-codex-responses.ts`
- `openai-codex/` (entire directory)
- `ollama.ts`
- `gitlab-duo.ts`
- `kimi.ts`
- `synthetic.ts`
- `github-copilot-headers.ts`
- `grammar.ts`
- `google-gemini-cli.ts`
- `google-gemini-headers.ts`

### packages/ai/src/provider-models/
- `special.ts`
- `ollama.ts`

### packages/ai/src/utils/discovery/
- `cursor.ts`
- `codex.ts`
- `antigravity.ts`

### packages/ai/src/utils/oauth/
DELETE ALL provider-specific OAuth/login files. Keep only LiteLLM login + generic infrastructure: `index.ts`, `types.ts`, `callback-server.ts`, `pkce.ts`, `api-key-login.ts`, `api-key-validation.ts`, `oauth.html`, `litellm.ts`

Specifically DELETE:
- `kimi.ts`, `github-copilot.ts`, `cursor.ts`, `openai-codex.ts`, `synthetic.ts`, `gitlab-duo.ts`
- `ollama.ts`, `ollama-cloud.ts`, `vllm.ts`, `lm-studio.ts`, `nvidia.ts`, `nanogpt.ts`
- `moonshot.ts`, `fireworks.ts`, `cerebras.ts`, `together.ts`, `venice.ts`, `xiaomi.ts`
- `zenmux.ts`, `huggingface.ts`, `cloudflare-ai-gateway.ts`, `qianfan.ts`, `qwen-portal.ts`
- `kilo.ts`, `kagi.ts`, `minimax-code.ts`, `zai.ts`, `vercel-ai-gateway.ts`
- `alibaba-coding-plan.ts`, `opencode.ts`, `parallel.ts`, `perplexity.ts`, `tavily.ts`
- `google-gemini-cli.ts`, `google-antigravity.ts`, `anthropic.ts`, `google-oauth-shared.ts`

### NEW FILE: packages/ai/src/utils/kimi-headers.ts
Extract `getKimiCommonHeaders` + its deps (`getDeviceId`, `getDeviceModel`, `formatDeviceModel`) from `utils/oauth/kimi.ts` into this new file. This is model-compat behavior (Kimi API requires device identification headers), NOT login. Update import in `providers/openai-completions.ts` from `"../utils/oauth/kimi"` to `"../utils/kimi-headers"`.

### packages/ai/src/usage/
DELETE ALL provider-specific usage files (require direct provider OAuth/API credentials, incompatible with LiteLLM-only):
- `github-copilot.ts`
- `openai-codex.ts`
- `kimi.ts`
- `zai.ts`
- `minimax-code.ts`
- `google-antigravity.ts`
- `gemini.ts` (requires Google Cloud OAuth + calls cloudcode-pa.googleapis.com)
- `claude.ts` (requires Anthropic OAuth + calls api.anthropic.com/api/oauth)

Also update `auth-storage.ts` to remove all usage provider registrations from `USAGE_PROVIDERS` array.
The usage framework (`usage/index.ts`, types) can stay — it just won't have any registered providers.

### packages/coding-agent/src/
- `cursor.ts`

## Files to MODIFY

### packages/ai/src/stream.ts
- Remove imports: `BedrockOptions`, `CursorOptions`, `isGitLabDuoModel/streamGitLabDuo`, `GoogleGeminiCliOptions`, `GoogleVertexOptions`, `isKimiModel/streamKimi`, `OllamaChatOptions`, `isSyntheticModel/streamSynthetic`, `isFoundryEnabled`
- From register-builtins imports: keep only `streamAnthropic`, `streamGoogle`, `streamOpenAICompletions`
- Remove from `serviceProviderMap`: ALL entries except `litellm` (no usage tracking, no direct provider login)
- In `stream()`: remove all switch cases except `anthropic-messages`, `openai-completions`, `google-generative-ai`; remove GitLab/Vertex/Bedrock pre-dispatch blocks
- In `streamSimple()`: remove `isGitLabDuoModel`, `isKimiModel`, `isSyntheticModel` predicates and their blocks; remove Vertex/Bedrock pre-dispatch
- In `mapOptionsForApi()`: remove all switch cases except `anthropic-messages`, `openai-completions`, `google-generative-ai`; remove bedrock, google-vertex, google-gemini-cli, ollama-chat, cursor-agent, openai-responses, openai-codex-responses, azure-openai-responses
- **Fix line 614:** Change `castApi<"google-gemini-cli">` to `castApi<"google-generative-ai">` — GoogleOptions already has `budgetTokens?: number` so the shape is compatible
- Remove `BEDROCK_CLAUDE_THINKING`, `resolveBedrockThinkingBudget`; remove `GOOGLE_THINKING` (only used by deleted google-gemini-cli case at line 648)
- Keep `getGoogleBudget` (used at line 618 in the google-generative-ai case)
- Remove `cachedVertexAdcCredentialsExists`, `hasVertexAdcCredentials()`

### packages/ai/src/types.ts
- Reduce `KnownApi` to: `"openai-completions"` | `"anthropic-messages"` | `"google-generative-ai"`
- Reduce `KnownProvider` to: `"litellm"` (sole provider; other code may reference provider strings for compat detection but won't be in the type union)
- Remove `ApiOptionsMap` entries for all deleted APIs
- Remove type imports for deleted provider option types
- Update exhaustiveness check (will need to match)

### packages/ai/src/providers/register-builtins.ts
- Keep only: `streamAnthropic`, `streamGoogle`, `streamOpenAICompletions`
- Remove all other lazy loaders

### packages/ai/src/providers/openai-completions.ts
- Remove GitHub Copilot code (lines 812-825 + imports + premium request tracking)
- Remove `copilotPremiumRequests` from function signatures, usage tracking, and `parseChunkUsage`
- Remove `callWithCopilotModelRetry` wrapper (line 401) — replace with direct `createCompletionsStream()` call
- Remove `rewriteCopilotError` (line 751) — just keep the raw error message
- Remove imports: `parseGitHubCopilotApiKey`, `callWithCopilotModelRetry`, `buildCopilotDynamicHeaders`, `resolveGitHubCopilotBaseUrl`, `hasCopilotVisionInput`, `rewriteCopilotError`
- Remove `github-copilot-headers.ts` file (only used by Copilot code path)
- **REFACTOR** Kimi header injection (line 806-808): change `model.provider === "kimi-code"` to `model.id.includes("moonshotai/kimi") || /^kimi[-.]/i.test(model.id)`. Update import to `"../utils/kimi-headers"`
- **REFACTOR** Fireworks model ID transformation (line 902): change `model.provider === "fireworks"` to `model.id.startsWith("fireworks/") || model.id.includes("accounts/fireworks/")`
- **REFACTOR** DeepSeek token stripping (line 437): change `model.provider === "nvidia" && /deepseek/i.test(model.id)` to just `/deepseek/i.test(model.id)`
- **REFACTOR** MiniMax think tag parsing (line 433): change `model.provider === "minimax-code"` to `/minimax/i.test(model.id)`
- **KEEP** Qwen/Kimi/DeepSeek reasoning logic in `buildParams` — already driven by model-ID-based compat flags
- Simplify `supportsReasoningParams` (line 894) — remove copilot guard (always true now)

### packages/ai/src/providers/openai-completions-compat.ts
- **KEEP + REFACTOR** — all detection must stay, but add model-ID fallbacks for provider-only checks:
  - `provider === "xai"` → add `|| /\bgrok\b/i.test(model.id)` 
  - `provider === "mistral"` → add `|| /\bmistral\b/i.test(model.id)`
  - `provider === "cerebras"` → add `|| /\bcerebras\b/i.test(model.id)` (already has baseUrl check)
  - Remove `provider === "opencode-zen"`, `provider === "opencode-go"` (deleted providers, no model-ID equivalent)
  - Remove `provider === "github-copilot"` from `detectStrictModeSupport` (deleted provider)
- All baseUrl-based checks stay as-is (LiteLLM could in theory proxy to any URL via custom routing)
- All model-ID-based checks already work for LiteLLM-routed models

### packages/ai/src/provider-models/descriptors.ts
- Remove ALL provider descriptor entries except LiteLLM
- Remove `googleAntigravityModelManagerOptions` from google.ts
- Simplify imports

### packages/ai/src/provider-models/openai-compat.ts
- Remove ALL model manager functions except `litellmModelManagerOptions` and its helper functions (`inferLitellmApi`, `deriveLitellmBaseUrl`, `stripLitellmModelPrefix`, `LITELLM_PROVIDER_PREFIXES`)
- Keep shared infrastructure: `fetchOpenAICompatibleModels` (in discovery/openai-compatible.ts), `createBundledReferenceMap` (in bundled-references.ts), `mapWithBundledReference` (local helper)
- Remove all imports that are only used by deleted functions

### packages/ai/src/provider-models/google.ts
- Remove `googleAntigravityModelManagerOptions`
- Keep `googleModelManagerOptions` (used for Gemini discovery which powers usage tracking)

### packages/ai/src/providers/google.ts
- Line 23 imports `type { GoogleThinkingLevel } from "./google-gemini-cli"` — move this type inline into google.ts: `type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`
- Line 24-31 imports from `./google-shared` — KEEP (google-shared.ts stays)
- No other dependencies on deleted files

### packages/ai/src/utils/oauth/index.ts
- Remove ALL provider entries except `litellm`
- Remove all refresh token cases except `litellm`
- Simplify `OAUTH_PROVIDERS` list to just LiteLLM

### packages/ai/src/utils/discovery/index.ts
- Remove re-exports for `antigravity`, `codex`, `cursor`
- Keep `gemini` and `openai-compatible`

### packages/ai/src/auth-storage.ts
- Remove ALL imports for usage providers (all deleted)
- Remove ALL login cases except `litellm` in the `login()` method switch
- Remove `USAGE_PROVIDERS` array contents (keep empty array)
- Remove `claudeRankingStrategy` import and usage
- Remove `serviceProviderMap.anthropic` entry from foundry/usage tracking (if only used for usage)
- Keep credential store infrastructure (still needed for LiteLLM API key storage)

### packages/ai/src/index.ts
- Remove re-exports for deleted modules

### packages/ai/package.json
- Remove: `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/credential-provider-node`, `@smithy/node-http-handler`, `@bufbuild/protobuf`

### Root package.json
- Remove same from catalog
- Remove `@bufbuild/protoc-gen-es` from devDependencies


### packages/ai/src/model-thinking.ts
- Remove case branches for `bedrock-converse-stream`, `google-gemini-cli`, `google-vertex`, `openai-responses`, `openai-codex-responses`
- Line 342: remove `model.provider === "amazon-bedrock"` special case
- Line 357-362: remove `openai-responses` and `openai-codex-responses` freeform checks
- Line 376: remove codex GPT-5.4 priority logic
- Line 463: change `model.api === "anthropic-messages" || model.api === "bedrock-converse-stream"` to just `model.api === "anthropic-messages"`
- Line 478-480: remove bedrock standalone case
- Line 489-491: remove openai-responses / openai-codex-responses case
- Line 501-502: remove `google-gemini-cli` and `google-vertex` from google thinking mode detection (keep `google-generative-ai`)
- Line 520-527: remove bedrock adaptive thinking mode detection
### packages/ai/src/usage/ (remaining)
- Keep `claude.ts` and `gemini.ts`
- `gemini.ts` imports from `google-gemini-cli.ts` provider (line 1: `getGeminiCliHeaders`) — this will need to be inlined or refactored since we're deleting google-gemini-cli.ts

## Critical Dependency Chain Issues (RESOLVED)

1. **`usage/gemini.ts`** imports `getGeminiCliHeaders` from `../providers/google-gemini-cli` and `refreshGoogleCloudToken` from `../utils/oauth/google-gemini-cli`. Resolution:
   - Keep `utils/oauth/google-gemini-cli.ts` (Google auth refresh for usage tracking)
   - Inline `getGeminiCliHeaders` into `usage/gemini.ts` (it's just a few header fields — user-agent + content-type)

2. **`providers/google.ts`** imports `GoogleThinkingLevel` type from `./google-gemini-cli`. Resolution:
   - Inline the type: `type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`
   - No other deps on deleted files (imports from `./google-shared` which we keep)

3. **`model-thinking.ts`** references deleted APIs. Resolution:
   - Remove dead case branches (see modification list above)

4. **`stream.ts` line 614** casts to `"google-gemini-cli"` options type within the `"google-generative-ai"` case. Resolution:
   - Change to `castApi<"google-generative-ai">` — `GoogleOptions` already has `budgetTokens?: number`

5. **`isFoundryEnabled`** in `serviceProviderMap.anthropic`. Resolution:
   - Remove entire `anthropic` entry from serviceProviderMap (no direct Anthropic login)
   - Keep `utils/foundry.ts` (still used by `anthropic-auth.ts` for web search feature)

## Approach (Execution Phases)

### Phase 1: Delete provider files with heavy external deps
- Delete `providers/amazon-bedrock.ts`, `providers/cursor.ts`, `providers/cursor/`
- Delete all OAuth modules for deleted providers (entire list in Files to DELETE)
- Delete all usage provider files
- This is safe — no kept file imports these heavy deps

### Phase 2: Delete remaining provider + infrastructure files
- Delete all other provider files listed above (ollama, gitlab-duo, kimi, synthetic, responses, codex, etc.)
- Delete discovery files, model-manager files
- Delete `google-gemini-cli.ts`, `google-gemini-headers.ts`, `google-vertex.ts`, `github-copilot-headers.ts`

### Phase 3: Create kimi-headers.ts utility
- Extract `getKimiCommonHeaders` + deps from `utils/oauth/kimi.ts` → `utils/kimi-headers.ts`
- ~40 lines: `getDeviceId`, `getDeviceModel`, `formatDeviceModel`, `getKimiCommonHeaders`

### Phase 4: Fix import breakage from deletions
- `providers/google.ts`: inline `GoogleThinkingLevel` type (remove import from deleted google-gemini-cli)
- `stream.ts` line 614: change `castApi<"google-gemini-cli">` → `castApi<"google-generative-ai">`
- `model-thinking.ts`: remove dead case branches for deleted APIs
- `auth-storage.ts`: remove all usage provider imports, login cases, ranking strategies
- `utils/oauth/index.ts`: strip to LiteLLM-only
- `index.ts`: remove re-exports for deleted modules

### Phase 5: Simplify stream.ts
- Remove `serviceProviderMap` entries (keep only `litellm`)
- Remove pre-dispatch predicates (`isGitLabDuoModel`, `isKimiModel`, `isSyntheticModel`)
- Remove Vertex/Bedrock no-key dispatch blocks
- Remove all `stream()` switch cases except the three kept APIs
- Remove all `mapOptionsForApi()` cases except the three kept APIs
- Remove `BEDROCK_CLAUDE_THINKING`, `resolveBedrockThinkingBudget`, `GOOGLE_THINKING`
- Remove `cachedVertexAdcCredentialsExists`, `hasVertexAdcCredentials()`
- Strip register-builtins imports to only: `streamAnthropic`, `streamGoogle`, `streamOpenAICompletions`

### Phase 6: Simplify types.ts
- Reduce `KnownApi` to: `"openai-completions" | "anthropic-messages" | "google-generative-ai"`
- Reduce `KnownProvider` to: `"litellm"` (or keep broader if other code references provider strings)
- Remove `ApiOptionsMap` entries for deleted APIs
- Remove unused type imports

### Phase 7: Refactor openai-completions.ts
- Remove GitHub Copilot code (auth, headers, retry, error rewriting, premium tracking)
- Refactor provider-based checks to model-ID detection (Kimi, Fireworks, MiniMax, DeepSeek)
- Update import: `getKimiCommonHeaders` from `"../utils/kimi-headers"`
- Simplify `supportsReasoningParams` to always `true`

### Phase 8: Refactor openai-completions-compat.ts
- Add model-ID fallbacks for provider-only checks (xai→grok, mistral, cerebras)
- Remove dead provider references (opencode-zen, opencode-go, github-copilot)

### Phase 9: Simplify provider-models
- Strip `openai-compat.ts` to just `litellmModelManagerOptions` + shared helpers
- Strip `descriptors.ts` to just LiteLLM entry
- Remove `googleAntigravityModelManagerOptions` from `google.ts`
- Strip `register-builtins.ts` to only three lazy loaders

### Phase 10: Clean package.json dependencies + verify
- Remove from `packages/ai/package.json`: `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/credential-provider-node`, `@smithy/node-http-handler`, `@bufbuild/protobuf`
- Remove from root `package.json` catalog + dev deps: `@bufbuild/protoc-gen-es`
- Run `bun install` to update lockfile
- Run `bun check:ts` — no type errors
- Run `bun lint:ts` — no lint errors

## Verification

1. `bun check:ts` — no type errors
2. `bun lint:ts` — no lint errors  
3. `bun --cwd=packages/ai run generate-models` — regenerates successfully with LiteLLM-only descriptors
4. LiteLLM models can still stream through all three API paths (anthropic-messages, google-generative-ai, openai-completions)
5. Model-ID-based compat detection works (DeepSeek, Qwen, Kimi, Fireworks, MiniMax patterns)

## Usage Tracking Regression Analysis

Two distinct "usage" systems exist — only the first is affected:

### 1. Provider usage tracking (REMOVED — graceful degradation)
- `packages/ai/src/usage/*.ts` — fetches quotas from upstream APIs (Anthropic OAuth, Google Cloud, GitHub Copilot, etc.)
- Requires direct provider credentials (OAuth tokens, provider API keys) — incompatible with LiteLLM-only
- **After removal:** `DEFAULT_USAGE_PROVIDERS` array becomes empty → `fetchUsageReports()` returns `[]` → `/usage` command shows "No usage data available" (existing graceful path at `command-controller.ts:514-516`)
- No crash, no regression — just no data to show

### 2. Session/token usage statistics (UNTOUCHED — no regression)
- `UsageStatistics` in `session-manager.ts` — sums tokens/cost from each assistant message's `Usage` object
- Status line token counts, cost display, context % — all read from accumulated local session data
- `getUsageStatistics()`, `getContextUsage()` — purely local, never call external APIs
- `omp stats` CLI — reads from local SQLite/session data
- **No change needed** — works identically with LiteLLM-only provider

### Keeping functional:
- `fetchUsageReports()` method stays in auth-storage.ts (returns `[]` with empty provider list)
- `handleUsageCommand()` in command-controller.ts stays (handles empty reports gracefully)
- `UsageReport`, `UsageProvider`, `UsageLimit` types in `usage.ts` stay (framework types, no implementation)
- `Usage` type on `AssistantMessage` stays (per-message token accounting from LLM responses)

## Dependencies Removed (Summary)

| Package | Approx size |
|---------|-------------|
| `@aws-sdk/client-bedrock-runtime` | ~15MB |
| `@aws-sdk/credential-provider-node` | ~8MB |
| `@smithy/node-http-handler` | ~2MB |
| `@bufbuild/protobuf` | ~3MB |
| `@bufbuild/protoc-gen-es` (dev) | ~2MB |
| **Total** | **~30MB** node_modules reduction |

## Out of Scope

- Removing non-AI packages (stats, swarm-extension, etc.)
- Changing how `openai-completions.ts` compat detection fundamentally works
- Removing the generate-models infrastructure
- Removing `@anthropic-ai/sdk`, `@google/genai`, or `openai` packages (still needed by kept providers)
- Simplifying TUI, native bindings, or other non-AI subsystems
