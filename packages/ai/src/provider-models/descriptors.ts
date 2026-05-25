/**
 * Unified provider descriptors — single source of truth for provider metadata
 * used by both runtime model discovery (model-registry.ts) and catalog
 * generation (generate-models.ts).
 */
import type { ModelManagerOptions } from "../model-manager";
import type { Api, KnownProvider } from "../types";
import type { OAuthProvider } from "../utils/oauth/types";
import { litellmModelManagerOptions } from "./openai-compat";

/** Catalog discovery configuration for providers that support endpoint-based model listing. */
export interface CatalogDiscoveryConfig {
	/** Human-readable name for log messages. */
	label: string;
	/** Environment variables to check for API keys during catalog generation. */
	envVars: string[];
	/** OAuth provider for credential refresh during catalog generation. */
	oauthProvider?: OAuthProvider;
	/** When true, catalog discovery proceeds even without credentials. */
	allowUnauthenticated?: boolean;
}

/** Unified provider descriptor used by both runtime discovery and catalog generation. */
export interface ProviderDescriptor {
	providerId: KnownProvider;
	createModelManagerOptions(config: { apiKey?: string; baseUrl?: string }): ModelManagerOptions<Api>;
	/** Preferred model ID when no explicit selection is made. */
	defaultModel: string;
	/** When true, the runtime creates a model manager even without a valid API key (e.g. ollama). */
	allowUnauthenticated?: boolean;
	/** Catalog discovery configuration. Only providers with this field participate in generate-models.ts. */
	catalogDiscovery?: CatalogDiscoveryConfig;
}

/** A provider descriptor that has catalog discovery configured. */
export type CatalogProviderDescriptor = ProviderDescriptor & { catalogDiscovery: CatalogDiscoveryConfig };

/** Type guard for descriptors with catalog discovery. */
export function isCatalogDescriptor(d: ProviderDescriptor): d is CatalogProviderDescriptor {
	return d.catalogDiscovery != null;
}

/** Whether catalog discovery may run without provider credentials. */
export function allowsUnauthenticatedCatalogDiscovery(descriptor: CatalogProviderDescriptor): boolean {
	return descriptor.catalogDiscovery.allowUnauthenticated ?? descriptor.allowUnauthenticated ?? false;
}

function descriptor(
	providerId: KnownProvider,
	defaultModel: string,
	createModelManagerOptions: ProviderDescriptor["createModelManagerOptions"],
	options: Pick<ProviderDescriptor, "allowUnauthenticated"> = {},
): ProviderDescriptor {
	return {
		providerId,
		defaultModel,
		createModelManagerOptions,
		...options,
	};
}

function catalog(
	label: string,
	envVars: string[],
	options: Pick<CatalogDiscoveryConfig, "oauthProvider" | "allowUnauthenticated"> = {},
): CatalogDiscoveryConfig {
	return {
		label,
		envVars,
		...options,
	};
}

function catalogDescriptor(
	providerId: KnownProvider,
	defaultModel: string,
	createModelManagerOptions: ProviderDescriptor["createModelManagerOptions"],
	catalogDiscovery: CatalogDiscoveryConfig,
	options: Pick<ProviderDescriptor, "allowUnauthenticated"> = {},
): ProviderDescriptor {
	return {
		...descriptor(providerId, defaultModel, createModelManagerOptions, options),
		catalogDiscovery,
	};
}

/**
 * All standard providers registered with the catalog discovery system.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
	catalogDescriptor(
		"litellm",
		"claude-opus-4-6",
		config => litellmModelManagerOptions(config),
		catalog("LiteLLM", ["LITELLM_API_KEY"], { allowUnauthenticated: true }),
	),
] as const;

/** Default model IDs for all known providers, built from descriptors + special providers. */
export const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string> = {
	litellm: "claude-opus-4-6",
} as Record<KnownProvider, string>;
