# FLIGHT PLAN: LiteLLM Native Provider Routing

## MISSION OVERVIEW

> **Mission Type**: Type-B Flight Operations
> **Classification**: Internal Enhancement
> **Flight Director**: User-authorized
> **T-Minus**: 2026-04-28

---

## EXECUTIVE SUMMARY

### Mission Objective
> **Primary Objective**: Rework the LiteLLM provider so that discovered models are routed through their native provider implementations (Anthropic, Google) via LiteLLM's passthrough endpoints, instead of forcing everything through the OpenAI-compatible layer. This eliminates duplicated logic (e.g., the cache_control hack) and unlocks full native provider features.
>
> **Success Criteria**:
> - Claude models discovered via LiteLLM get `api: "anthropic-messages"` and stream through `streamAnthropic` with full `applyPromptCaching()`, thinking, and Anthropic-native features
> - Gemini models discovered via LiteLLM get `api: "google-generative-ai"` and stream through `streamGoogle` with native thinking config
> - All other LiteLLM models continue using `api: "openai-completions"` with zero behavioral change
> - `bun check` passes, no regressions for existing providers

### Deliverables
- Modified `packages/ai/src/provider-models/openai-compat.ts` — `litellmModelManagerOptions()` with API type detection and passthrough URL routing
- Modified `packages/ai/src/providers/openai-completions.ts` — scoped cache hack cleanup
- New/updated tests validating the routing logic

### Mission Profile
- **Estimated Duration**: Medium
- **Parallel Execution**: YES — 2 waves
- **Flight Phases**: Phase 1 (Requirements) → Phase 2 (Hazard Analysis) → Phase 3 (Implementation) → Phase 4 (V&V)

---

## PHASE 1: REQUIREMENTS DEFINITION

> **Objective**: Establish mission parameters, success criteria, and constraints.

### Mission Requirements & Bi-Directional Traceability

| Req ID | Requirement Description | Design Component | Implementation | Test/Verification | Status |
|--------|------------------------|------------------|----------------|-------------------|--------|
| REQ-001 | Claude models via LiteLLM route through native Anthropic provider | `inferLitellmApi()` detection + `mapModel` | `openai-compat.ts` | Unit test: Claude model gets `api: "anthropic-messages"` | Open |
| REQ-002 | Gemini models via LiteLLM route through native Google provider | `inferLitellmApi()` detection + `mapModel` | `openai-compat.ts` | Unit test: Gemini model gets `api: "google-generative-ai"` | Open |
| REQ-003 | LiteLLM passthrough base URLs derived correctly | `deriveLitellmPassthroughUrl()` | `openai-compat.ts` | Unit test: URL derivation for Anthropic/Google/default | Open |
| REQ-004 | Model ID prefix stripping for Anthropic-routed models | `mapModel` callback | `openai-compat.ts` | Unit test: `anthropic/claude-sonnet-4` → `claude-sonnet-4` | Open |
| REQ-005 | Non-Claude/non-Gemini models remain `openai-completions` | Default fallback in `inferLitellmApi()` | `openai-compat.ts` | Unit test: GPT/Mistral/Llama models unchanged | Open |
| REQ-006 | `LITELLM_API_KEY` resolves for all models regardless of API type | `provider: "litellm"` preserved | `openai-compat.ts` | Verify `serviceProviderMap` lookup | Open |
| REQ-007 | Remove duplicated cache logic dependency on LiteLLM | Scoped cleanup of `maybeAddAnthropicCacheControl` | `openai-completions.ts` | Verify Claude via LiteLLM no longer triggers hack | Open |
| REQ-008 | Type signature broadened to `ModelManagerOptions<Api>` | Generic type param change | `openai-compat.ts` | `bun check` passes | Open |

### Constraints & Boundaries
- **MUST HAVE**: Anthropic and Google native routing; default fallback to openai-completions; backwards-compatible auth
- **MUST NOT HAVE**: Changes to `stream.ts` dispatch; changes to Anthropic/Google provider internals; changes to other providers (ZenMux, Copilot, OpenRouter)
- **ASSUMPTIONS**: LiteLLM passthrough endpoints accept `Authorization: Bearer <LITELLM_KEY>` and forward to upstream providers; LiteLLM passthrough handles model ID prefix stripping for forwarded requests (with local prefix stripping as safety net)

---

## PHASE 2: HAZARD ANALYSIS & ARCHITECTURE

> **Objective**: Identify hazards, establish abort criteria, define architecture.

### Hazard Analysis & Software Risk Management

| ID | Hazard Description | Severity | Probability | Mitigation Strategy | Abort Trigger | Recovery Path |
|----|-------------------|----------|-------------|---------------------|---------------|---------------|
| H1 | Model ID prefix (`anthropic/claude-*`) rejected by Anthropic API via passthrough | P2-Major | Medium | Strip known prefixes (`anthropic/`, `vertex_ai/`, `bedrock/`) during discovery in `mapModel` | N/A — mitigated by design | Fall back to `openai-completions` if stripping fails |
| H2 | Google GenAI SDK URL construction incompatible with LiteLLM `/gemini/*` passthrough | P2-Major | Medium | Phase Google routing as separate task; validate URL construction independently | If Google streaming fails end-to-end | Keep Google models on `openai-completions` |
| H3 | LiteLLM passthrough auth format differs from standard Bearer token | P1-Critical | Low | Verified in LiteLLM docs: passthrough uses same `Authorization: Bearer` auth | Auth failures on passthrough endpoints | Revert to `openai-completions` for all models |
| H4 | Regression for non-Claude/non-Gemini models through LiteLLM | P1-Critical | Low | Default fallback in detection function preserves existing behavior | Any non-Claude/Gemini model fails | Revert `mapModel` changes |
| H5 | `owned_by` field unreliable in LiteLLM model discovery | P3-Minor | High | Use model ID pattern matching as primary signal, `owned_by` as secondary | N/A — mitigated by design | Pattern matching alone sufficient |

### Abort & Adaptation Strategy

> **NOTE: MISSION RESILIENCE**
> Do not abort on the first failure. We expect to encounter errors, learn from them, and adapt.
> Only abort the mission if there are SIGNIFICANT DEVIATIONS from the plan required to solve the issue.

**Adaptation & Non-conformance Protocol**:
- **Test Failures**: Re-evaluate detection heuristics, fix the code, do not abort
- **Type Errors**: Resolve generic type broadening issues incrementally
- **LiteLLM passthrough incompatibilities**: Fall back to `openai-completions` for affected provider type; document limitation

**Deviation Thresholds**:
- [ ] ABORT if the Anthropic provider fundamentally cannot work with non-Anthropic base URLs (verified it can — `resolveAnthropicBaseUrl` returns `model.baseUrl` for non-anthropic providers)
- [ ] ABORT if `stream.ts` dispatch requires modification (it doesn't — already handles all API types)
- [ ] ABORT if `LITELLM_API_KEY` resolution breaks for routed models (verified — `provider: "litellm"` is preserved)

### Architecture Decisions

**Pattern**: Follow ZenMux/Copilot precedent — detect model type during discovery, set appropriate `api` and `baseUrl` per model, return `ModelManagerOptions<Api>`.

**Key Difference from ZenMux**: ZenMux has two fixed base URLs (OpenAI + Anthropic). LiteLLM derives passthrough URLs from a single base URL with path prefixes (`/anthropic`, `/gemini`). The `mapModel` callback computes the correct passthrough URL per model.

**Authentication Flow** (verified compatible):
1. `stream.ts` → `getEnvApiKey("litellm")` → `LITELLM_API_KEY`
2. → `streamAnthropic(model, context, { apiKey: LITELLM_KEY })`
3. → `resolveAnthropicBaseUrl(model)` → returns `model.baseUrl` (LiteLLM `/anthropic` passthrough)
4. → `buildAnthropicHeaders({ baseUrl, apiKey })` → detects non-Anthropic URL → `Authorization: Bearer <LITELLM_KEY>`
5. → Request sent to `http://localhost:4000/anthropic/v1/messages` with LiteLLM auth
6. → LiteLLM proxy validates key, injects real Anthropic credentials, forwards native request

---

## PHASE 3: IMPLEMENTATION (Flight Operations)

> **Objective**: Execute mission operations following established parameters.

### Mission Timeline

| Task | Description | Dependencies | Parallel | Est |
|------|-------------|--------------|----------|-----|
| 3.1 | Add `inferLitellmApi()` detection function | None | Wave 1 | S |
| 3.2 | Add `deriveLitellmPassthroughUrl()` helper | None | Wave 1 | S |
| 3.3 | Add `stripLitellmModelPrefix()` helper | None | Wave 1 | S |
| 3.4 | Rework `litellmModelManagerOptions()` with routing | 3.1, 3.2, 3.3 | Wave 2 | M |
| 3.5 | Scope `maybeAddAnthropicCacheControl` cleanup | 3.4 | Wave 2 | S |
| 3.6 | Add unit tests for routing logic | 3.4 | Wave 2 | M |
| 3.7 | Type check and lint verification | 3.4, 3.5, 3.6 | Final | S |

### Implementation Detail

> **CRITICAL — PARALLEL EXECUTION PROTOCOL**: Tasks 3.1–3.3 can execute in parallel (Wave 1). Tasks 3.4–3.6 depend on Wave 1 and can execute in parallel (Wave 2). Task 3.7 is the final verification gate.

---

## TODOs

- [ ] 1. Add `inferLitellmApi()` model type detection function

  **File**: `packages/ai/src/provider-models/openai-compat.ts`

  **What to do**:
  Create a function `inferLitellmApi(modelId: string, entry: OpenAICompatibleModelRecord): Api` that determines the native API type for a LiteLLM-discovered model. Follow the hybrid pattern from ZenMux (`isZenMuxAnthropicModel`) and Copilot (`inferCopilotApi`):

  ```typescript
  function inferLitellmApi(modelId: string, entry: OpenAICompatibleModelRecord): Api {
    const id = modelId.toLowerCase();
    const ownedBy = typeof entry.owned_by === "string" ? entry.owned_by.toLowerCase() : "";

    // Anthropic detection: prefix, owned_by, or model name pattern
    if (id.startsWith("anthropic/") || ownedBy === "anthropic" || /\bclaude\b/.test(id)) {
      return "anthropic-messages";
    }

    // Google detection: prefix, owned_by, or model name pattern
    if (id.startsWith("google/") || id.startsWith("vertex_ai/") || ownedBy === "google" || /\bgemini\b/.test(id)) {
      return "google-generative-ai";
    }

    // Default: OpenAI-compatible (existing behavior)
    return "openai-completions";
  }
  ```

  Place this near `isZenMuxAnthropicModel()` and `inferCopilotApi()` for consistency.

  **QA Scenarios**:
  - `inferLitellmApi("anthropic/claude-sonnet-4-20250514", {})` → `"anthropic-messages"`
  - `inferLitellmApi("claude-sonnet-4-20250514", { owned_by: "anthropic" })` → `"anthropic-messages"`
  - `inferLitellmApi("claude-3-haiku", {})` → `"anthropic-messages"`
  - `inferLitellmApi("vertex_ai/gemini-2.5-pro", {})` → `"google-generative-ai"`
  - `inferLitellmApi("gemini-2.5-flash", { owned_by: "google" })` → `"google-generative-ai"`
  - `inferLitellmApi("gpt-4o", { owned_by: "openai" })` → `"openai-completions"`
  - `inferLitellmApi("mistral-large", {})` → `"openai-completions"`
  - `inferLitellmApi("my-custom-alias", {})` → `"openai-completions"` (graceful fallback)
  - `inferLitellmApi("bedrock/anthropic.claude-v2", {})` → `"anthropic-messages"` (contains "claude")

- [ ] 2. Add `stripLitellmModelPrefix()` helper for model ID normalization

  **File**: `packages/ai/src/provider-models/openai-compat.ts`

  **What to do**:
  Create a function that strips known LiteLLM provider prefixes from model IDs before they are sent to native provider APIs. The Anthropic API expects `claude-sonnet-4-20250514`, not `anthropic/claude-sonnet-4-20250514`. The Google API expects `gemini-2.5-pro`, not `google/gemini-2.5-pro`.

  ```typescript
  const LITELLM_PROVIDER_PREFIXES = [
    "anthropic/",
    "google/",
    "vertex_ai/",
    "bedrock/",
    "bedrock/anthropic.",  // bedrock/anthropic.claude-v2 → claude-v2
  ] as const;

  function stripLitellmModelPrefix(modelId: string): string {
    for (const prefix of LITELLM_PROVIDER_PREFIXES) {
      if (modelId.startsWith(prefix)) {
        return modelId.slice(prefix.length);
      }
    }
    return modelId;
  }
  ```

  Note: Order matters — `bedrock/anthropic.` must be checked before generic prefixes. Also handle the `vertex_ai/claude-sonnet-4@20250514` format (the `@` version suffix should be preserved as it's part of the Vertex model ID scheme, but stripping `vertex_ai/` is the important part).

  **QA Scenarios**:
  - `stripLitellmModelPrefix("anthropic/claude-sonnet-4-20250514")` → `"claude-sonnet-4-20250514"`
  - `stripLitellmModelPrefix("google/gemini-2.5-pro")` → `"gemini-2.5-pro"`
  - `stripLitellmModelPrefix("vertex_ai/gemini-2.5-pro")` → `"gemini-2.5-pro"`
  - `stripLitellmModelPrefix("bedrock/anthropic.claude-v2")` → `"claude-v2"`
  - `stripLitellmModelPrefix("claude-sonnet-4-20250514")` → `"claude-sonnet-4-20250514"` (no prefix, unchanged)
  - `stripLitellmModelPrefix("gpt-4o")` → `"gpt-4o"` (not a known prefix)

- [ ] 3. Add passthrough URL derivation logic

  **File**: `packages/ai/src/provider-models/openai-compat.ts`

  **What to do**:
  Create a helper that derives the correct LiteLLM passthrough URL based on detected API type. LiteLLM exposes native provider endpoints at path prefixes off the proxy root:
  - Anthropic: `http://<proxy>/anthropic` (SDK appends `/v1/messages`)
  - Google: `http://<proxy>/gemini` (SDK appends `/models/{id}:streamGenerateContent`)
  - Default: `http://<proxy>/v1` (existing OpenAI-compat endpoint)

  ```typescript
  function deriveLitellmBaseUrl(baseUrl: string, api: Api): string {
    // baseUrl is typically "http://localhost:4000/v1" — strip /v1 suffix to get proxy root
    const proxyRoot = baseUrl.replace(/\/v1\/?$/, "");

    switch (api) {
      case "anthropic-messages":
        return `${proxyRoot}/anthropic`;
      case "google-generative-ai":
        return `${proxyRoot}/gemini`;
      default:
        return baseUrl; // Keep original /v1 URL for OpenAI-compat
    }
  }
  ```

  **QA Scenarios**:
  - `deriveLitellmBaseUrl("http://localhost:4000/v1", "anthropic-messages")` → `"http://localhost:4000/anthropic"`
  - `deriveLitellmBaseUrl("http://localhost:4000/v1", "google-generative-ai")` → `"http://localhost:4000/gemini"`
  - `deriveLitellmBaseUrl("http://localhost:4000/v1", "openai-completions")` → `"http://localhost:4000/v1"`
  - `deriveLitellmBaseUrl("https://my-proxy.example.com/v1", "anthropic-messages")` → `"https://my-proxy.example.com/anthropic"`
  - `deriveLitellmBaseUrl("http://localhost:4000", "anthropic-messages")` → `"http://localhost:4000/anthropic"` (no /v1 suffix)
  - `deriveLitellmBaseUrl("http://localhost:4000/v1/", "anthropic-messages")` → `"http://localhost:4000/anthropic"` (trailing slash)

- [ ] 4. Rework `litellmModelManagerOptions()` with native provider routing

  **File**: `packages/ai/src/provider-models/openai-compat.ts`

  **What to do**:
  Modify the existing `litellmModelManagerOptions()` function to use the new detection and routing helpers. This is the core change. Follow the ZenMux pattern:

  1. Change return type from `ModelManagerOptions<"openai-completions">` to `ModelManagerOptions<Api>`
  2. Change `createBundledReferenceMap<"openai-completions">("litellm")` to `createBundledReferenceMap<Api>("litellm")`
  3. Change `fetchOpenAICompatibleModels({...})` to `fetchOpenAICompatibleModels<Api>({...})`
  4. Update `mapModel` callback to:
     a. Call `inferLitellmApi(defaults.id, entry)` to detect model type
     b. Call `stripLitellmModelPrefix(defaults.id)` to normalize model ID for native API types
     c. Call `deriveLitellmBaseUrl(baseUrl, api)` to get the correct passthrough URL
     d. Apply the detected `api` and derived `baseUrl` to the model
     e. Preserve `provider: "litellm"` for all models (auth resolution)
     f. Still call `mapWithBundledReference()` for metadata enrichment

  The updated function should look structurally like:

  ```typescript
  export function litellmModelManagerOptions(
    config?: LiteLLMModelManagerConfig,
  ): ModelManagerOptions<Api> {
    const apiKey = config?.apiKey;
    const baseUrl = config?.baseUrl ?? "http://localhost:4000/v1";
    const references = createBundledReferenceMap<Api>("litellm");
    return {
      providerId: "litellm",
      fetchDynamicModels: () =>
        fetchOpenAICompatibleModels<Api>({
          api: "openai-completions",  // Default API for discovery request itself
          provider: "litellm",
          baseUrl,
          apiKey,
          mapModel: (entry, defaults) => {
            const api = inferLitellmApi(defaults.id, entry);
            const reference = references.get(defaults.id);
            const mapped = mapWithBundledReference(entry, defaults, reference);
            const isNativelyRouted = api !== "openai-completions";
            return {
              ...mapped,
              api,
              baseUrl: deriveLitellmBaseUrl(baseUrl, api),
              provider: "litellm",
              ...(isNativelyRouted ? { id: stripLitellmModelPrefix(mapped.id) } : {}),
            };
          },
        }),
    };
  }
  ```

  **Important**: Only strip the model ID prefix for natively-routed models. OpenAI-compat models keep their original LiteLLM IDs since those are passed to LiteLLM's `/v1/chat/completions` which expects them.

  **QA Scenarios**:
  - Discovery of `{ id: "anthropic/claude-sonnet-4-20250514", owned_by: "anthropic" }` → Model with `api: "anthropic-messages"`, `baseUrl: "http://localhost:4000/anthropic"`, `id: "claude-sonnet-4-20250514"`, `provider: "litellm"`
  - Discovery of `{ id: "gemini-2.5-pro", owned_by: "google" }` → Model with `api: "google-generative-ai"`, `baseUrl: "http://localhost:4000/gemini"`, `id: "gemini-2.5-pro"`, `provider: "litellm"`
  - Discovery of `{ id: "gpt-4o", owned_by: "openai" }` → Model with `api: "openai-completions"`, `baseUrl: "http://localhost:4000/v1"`, `id: "gpt-4o"`, `provider: "litellm"`
  - Discovery of `{ id: "mistral-large-latest" }` → Model with `api: "openai-completions"` (no change from current behavior)
  - Bundled reference data (from `models.json`) still applied correctly for known models
  - Return type is `ModelManagerOptions<Api>`, not `ModelManagerOptions<"openai-completions">`

- [ ] 5. Scope `maybeAddAnthropicCacheControl` cleanup in openai-completions.ts

  **File**: `packages/ai/src/providers/openai-completions.ts`

  **What to do**:
  Now that LiteLLM Claude models route through `streamAnthropic` (which has the real `applyPromptCaching()`), the `maybeAddAnthropicCacheControl()` hack in `openai-completions.ts` no longer needs to catch LiteLLM models. However, it still serves OpenRouter and potentially other proxies.

  In `isAnthropicModelViaCacheableProvider()` (around line 997-1005):
  - **Keep** the OpenRouter check: `model.provider === "openrouter" && model.id.startsWith("anthropic/")`
  - **Keep** the broad `model.id.toLowerCase().includes("claude")` check as a safety net for unknown proxies
  - **Add a comment** explaining that LiteLLM Claude models are now routed natively and no longer reach this code path:

  ```typescript
  function isAnthropicModelViaCacheableProvider(model: Model<"openai-completions">): boolean {
    // OpenRouter with explicit anthropic/ prefix
    if (model.provider === "openrouter" && model.id.startsWith("anthropic/")) return true;
    // Safety net for proxies routing Claude via OpenAI-compat format.
    // LiteLLM Claude models are natively routed to anthropic-messages and
    // no longer reach this code path — they get full applyPromptCaching() instead.
    if (model.id.toLowerCase().includes("claude")) return true;
    return false;
  }
  ```

  This is a minimal, safe change. The comment documents the architectural improvement without removing the safety net for other proxies.

  **QA Scenarios**:
  - LiteLLM Claude model: Has `api: "anthropic-messages"` → goes through `streamAnthropic` → never reaches `maybeAddAnthropicCacheControl` → gets full `applyPromptCaching()` instead
  - OpenRouter Claude model: Has `api: "openai-completions"`, `provider: "openrouter"`, `id: "anthropic/claude-sonnet-4"` → still triggers `isAnthropicModelViaCacheableProvider` → still gets cache hack
  - Unknown proxy Claude model: Has `api: "openai-completions"`, `id: "claude-3-haiku"` → still triggers via `includes("claude")` → still gets cache hack as safety net
  - Non-Claude model: Not affected by any change

- [ ] 6. Add unit tests for LiteLLM routing logic

  **File**: `packages/ai/test/litellm-routing.test.ts` (new file)

  **What to do**:
  Create a focused test file that validates the routing logic. Test the three new helper functions and the overall `litellmModelManagerOptions` integration. Follow the testing guidance in AGENTS.md: test the contract, not implementation details. Each test should defend one concrete externally observable contract.

  **Tests to include**:

  1. **`inferLitellmApi` — Anthropic detection by prefix**: Input `"anthropic/claude-sonnet-4"` → expect `"anthropic-messages"`
  2. **`inferLitellmApi` — Anthropic detection by name pattern**: Input `"claude-3-haiku"` → expect `"anthropic-messages"`
  3. **`inferLitellmApi` — Anthropic detection by owned_by**: Input `"some-model"`, `{ owned_by: "anthropic" }` → expect `"anthropic-messages"`
  4. **`inferLitellmApi` — Google detection by prefix**: Input `"google/gemini-2.5-pro"` → expect `"google-generative-ai"`
  5. **`inferLitellmApi` — Google detection by name pattern**: Input `"gemini-2.5-flash"` → expect `"google-generative-ai"`
  6. **`inferLitellmApi` — Default fallback**: Input `"gpt-4o"` → expect `"openai-completions"`
  7. **`stripLitellmModelPrefix` — strips anthropic/ prefix**: Input `"anthropic/claude-sonnet-4"` → expect `"claude-sonnet-4"`
  8. **`stripLitellmModelPrefix` — strips bedrock/anthropic. prefix**: Input `"bedrock/anthropic.claude-v2"` → expect `"claude-v2"`
  9. **`stripLitellmModelPrefix` — no-op for unprefixed IDs**: Input `"claude-sonnet-4"` → expect `"claude-sonnet-4"`
  10. **`deriveLitellmBaseUrl` — Anthropic passthrough**: Input `("http://localhost:4000/v1", "anthropic-messages")` → expect `"http://localhost:4000/anthropic"`
  11. **`deriveLitellmBaseUrl` — Google passthrough**: Input `("http://localhost:4000/v1", "google-generative-ai")` → expect `"http://localhost:4000/gemini"`
  12. **`deriveLitellmBaseUrl` — Default passthrough**: Input `("http://localhost:4000/v1", "openai-completions")` → expect `"http://localhost:4000/v1"`

  Note: The helper functions need to be exported (or the tests structured to test through the public `litellmModelManagerOptions` API). If exporting internals feels wrong, test through integration: mock `fetchOpenAICompatibleModels` to return test model entries and verify the mapped output models have correct `api`, `baseUrl`, and `id` fields.

  **QA Scenarios**:
  - All 12 test cases above pass
  - `bun test packages/ai/test/litellm-routing.test.ts` exits 0
  - Tests follow AGENTS.md: each defends one concrete contract, no placeholders, no tautologies

- [ ] 7. Run `bun check` and `bun lint` — fix any type or lint errors

  **What to do**:
  Run the full type check and lint suite to catch any issues from the generic type broadening (`ModelManagerOptions<Api>`) or other changes.

  ```bash
  bun check
  bun lint
  ```

  Common issues to expect:
  - `createBundledReferenceMap<Api>("litellm")` may need the bundled models in `models.json` to have API-appropriate types. If `models.json` entries for litellm are typed as `openai-completions`, the `as Model<TApi>` cast in `createBundledReferenceMap` should handle it (it already uses a cast).
  - `mapWithBundledReference` returns based on `defaults` type — verify the spread `{ ...mapped, api, baseUrl }` is type-safe with the broadened generic.

  **QA Scenarios**:
  - `bun check` exits 0 with zero errors
  - `bun lint` exits 0 with zero warnings/errors
  - No changes needed to `stream.ts`, `anthropic.ts`, or `google.ts`

---

## Final Verification Wave

- [ ] Run `bun check` — must pass with zero errors
- [ ] Run `bun lint` — must pass
- [ ] Verify no changes to `packages/ai/src/stream.ts`
- [ ] Verify no changes to `packages/ai/src/providers/anthropic.ts`
- [ ] Verify no changes to `packages/ai/src/providers/google.ts`
- [ ] Verify no changes to ZenMux, Copilot, or OpenRouter model manager options

---

## PHASE 4: VERIFICATION & VALIDATION (V&V)

### Verification Matrix

| Verification Type | Method | Acceptance Criteria | Status |
|-------------------|--------|---------------------|--------|
| Type Safety | `bun check` | Zero errors | Pending |
| Lint | `bun lint` | Zero errors | Pending |
| Unit Tests | `bun test packages/ai/test/litellm-routing.test.ts` | All pass | Pending |
| Regression | Existing test suite | No failures | Pending |
| Functional | Manual: Claude model ID detection | Returns `anthropic-messages` | Pending |
| Functional | Manual: Gemini model ID detection | Returns `google-generative-ai` | Pending |
| Functional | Manual: GPT model ID detection | Returns `openai-completions` | Pending |

### V&V Protocols

#### Protocol 4.1: Routing Correctness
```
Test: inferLitellmApi() returns correct API type for known model patterns
Command: bun test packages/ai/test/litellm-routing.test.ts
Expected: All test cases pass
```

#### Protocol 4.2: Type Safety
```
Check: Full TypeScript compilation with broadened generics
Command: bun check
Expected: Zero errors
```

#### Protocol 4.3: Regression
```
Check: Existing provider tests still pass
Command: bun test packages/ai/test/
Expected: No new failures
```

---

## Commit Strategy

Single commit: `feat(ai): route LiteLLM models through native providers via passthrough endpoints`

If the change is large, split into:
1. `feat(ai): add LiteLLM model type detection and passthrough URL derivation`
2. `feat(ai): rework litellmModelManagerOptions to use native provider routing`
3. `refactor(ai): scope maybeAddAnthropicCacheControl after LiteLLM routing`

---

## Success Criteria

- [ ] Claude models via LiteLLM discovery get `api: "anthropic-messages"` + passthrough baseUrl
- [ ] Gemini models via LiteLLM discovery get `api: "google-generative-ai"` + passthrough baseUrl
- [ ] Non-Claude/Gemini models remain `api: "openai-completions"` unchanged
- [ ] `LITELLM_API_KEY` resolves for all models regardless of API type
- [ ] `maybeAddAnthropicCacheControl` no longer triggers for LiteLLM Claude models
- [ ] `bun check` and `bun lint` pass
- [ ] No regressions for existing providers

---

## APPENDICES

### Rollback
```bash
git revert HEAD  # If single commit
# or
git revert HEAD~2..HEAD  # If split commits
```
Verification: `bun check && bun test packages/ai/test/`

### References
- ZenMux routing pattern: `packages/ai/src/provider-models/openai-compat.ts` (zenmuxModelManagerOptions)
- Copilot routing pattern: `packages/ai/src/provider-models/openai-compat.ts` (inferCopilotApi)
- LiteLLM passthrough docs: https://docs.litellm.ai/docs/pass_through/anthropic_completion
- LiteLLM Gemini passthrough: https://docs.litellm.ai/docs/pass_through/google_ai_studio
- Anthropic base URL resolution: `packages/ai/src/providers/anthropic.ts` (resolveAnthropicBaseUrl)
- Anthropic header building: `packages/ai/src/providers/anthropic.ts` (buildAnthropicHeaders)
- Google client creation: `packages/ai/src/providers/google.ts` (createClient)
