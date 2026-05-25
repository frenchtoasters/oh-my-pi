import type { Api, Model, Provider, ProviderSessionState } from "./types";

export interface ProviderDetailField {
	label: string;
	value: string;
}

export interface ProviderDetails {
	provider: Provider;
	api: Api;
	fields: ProviderDetailField[];
}

export interface ProviderDetailsContext {
	model: Model<Api>;
	sessionId?: string;
	authMode?: string;
	preferWebsockets?: boolean;
	providerSessionState?: Map<string, ProviderSessionState>;
}

export function getProviderDetails(context: ProviderDetailsContext): ProviderDetails {
	const endpoint = formatEndpoint(context.model.baseUrl);
	const fields: ProviderDetailField[] = [
		{ label: "Model", value: context.model.id },
		{ label: "API", value: context.model.api },
		{ label: "Auth", value: context.authMode ?? "auto" },
		{ label: "Endpoint", value: endpoint },
	];

	return {
		provider: context.model.provider,
		api: context.model.api,
		fields,
	};
}

function formatEndpoint(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		const path = parsed.pathname.replace(/\/$/, "");
		return `${parsed.origin}${path || "/"}`;
	} catch {
		return baseUrl;
	}
}
