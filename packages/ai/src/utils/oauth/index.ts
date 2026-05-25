// ============================================================================
// High-level API
// ============================================================================
import type {
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./types";

const builtInOAuthProviders: OAuthProviderInfo[] = [
	{
		id: "litellm",
		name: "LiteLLM",
		available: true,
	},
];

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/**
 * Register a custom OAuth provider.
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
}

/**
 * Get a custom OAuth provider by ID.
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

/**
 * Remove all custom OAuth providers registered by a source.
 */
export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customOAuthProviders.delete(id);
		}
	}
}

/**
 * Refresh token for any OAuth provider.
 * Saves the new credentials and returns the new access token.
 */
export async function refreshOAuthToken(
	provider: OAuthProvider,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	// LiteLLM and most providers use static API keys that don't expire
	if (provider === "litellm") {
		return credentials;
	}

	// Custom providers can handle their own refresh logic
	const customProvider = getOAuthProvider(provider);
	if (customProvider?.refreshToken) {
		return await customProvider.refreshToken(credentials);
	}

	throw new Error(`Unknown OAuth provider: ${provider}`);
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * For providers that need credential metadata at request time, returns JSON-encoded credentials
 * plus refresh/expiry metadata for proactive refresh support.
 * @returns API key string, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	provider: OAuthProvider,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	let creds = credentials[provider];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		try {
			creds = await refreshOAuthToken(provider, creds);
		} catch (refreshError) {
			const reason = refreshError instanceof Error ? refreshError.message : String(refreshError);
			throw new Error(`Failed to refresh OAuth token for ${provider}: ${reason}`);
		}
	}

	// LiteLLM returns plain access token
	const apiKey = creds.access;
	return { newCredentials: creds, apiKey };
}

/**
 * Get list of OAuth providers.
 */
export function getOAuthProviders(): OAuthProviderInfo[] {
	const customProviders = Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
	}));
	return [...builtInOAuthProviders, ...customProviders];
}
