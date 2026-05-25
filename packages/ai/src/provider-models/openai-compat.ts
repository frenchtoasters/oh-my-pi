import type { ModelManagerOptions } from "../model-manager";
import type { Api, Model } from "../types";
import { toPositiveNumber } from "../utils";
import { fetchOpenAICompatibleModels, type OpenAICompatibleModelRecord } from "../utils/discovery/openai-compatible";
import { createBundledReferenceMap } from "./bundled-references";

export interface ModelsDevModel {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
	status?: string;
	provider?: { npm?: string };
}

export const UNK_CONTEXT_WINDOW = 222_222;
export const UNK_MAX_TOKENS = 8_888;

function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: Model<TApi>,
	reference: Model<TApi> | undefined,
): Model<TApi> {
	const name = toModelName(entry.name, reference?.name ?? defaults.name);
	if (!reference) {
		return {
			...defaults,
			name,
		};
	}
	return {
		...reference,
		id: defaults.id,
		name,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

// ---------------------------------------------------------------------------
// 21. LiteLLM
// ---------------------------------------------------------------------------

export const LITELLM_PROVIDER_PREFIXES = [
	"bedrock/anthropic.", // Must precede "bedrock/" — strips "bedrock/anthropic.claude-v2" → "claude-v2"
	"anthropic/",
	"google/",
	"vertex_ai/",
	"bedrock/",
] as const;

export function inferLitellmApi(modelId: string, entry: OpenAICompatibleModelRecord): Api {
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

export function stripLitellmModelPrefix(modelId: string): string {
	for (const prefix of LITELLM_PROVIDER_PREFIXES) {
		if (modelId.startsWith(prefix)) {
			return modelId.slice(prefix.length);
		}
	}
	return modelId;
}

export function deriveLitellmBaseUrl(baseUrl: string, api: Api): string {
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

export interface LiteLLMModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function litellmModelManagerOptions(config?: LiteLLMModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "http://localhost:4000/v1";
	const references = createBundledReferenceMap<Api>("litellm");
	return {
		providerId: "litellm",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels<Api>({
				api: "openai-completions",
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
