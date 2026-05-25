#!/usr/bin/env bun

import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";
import { AuthCredentialStore } from "../src/auth-storage";
import { createModelManager } from "../src/model-manager";
import { applyGeneratedModelPolicies, linkOpenAIPromotionTargets } from "../src/model-thinking";
import prevModelsJson from "../src/models.json" with { type: "json" };
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogDiscoveryConfig,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
	PROVIDER_DESCRIPTORS,
} from "../src/provider-models/descriptors";
import type { Model } from "../src/types";
import { getOAuthApiKey } from "../src/utils/oauth";

const packageRoot = path.join(import.meta.dir, "..");

async function resolveProviderApiKey(providerId: string, catalog: CatalogDiscoveryConfig): Promise<string | undefined> {
	for (const envVar of catalog.envVars) {
		const value = $env[envVar as keyof typeof $env];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	try {
		const storage = await AuthCredentialStore.open();
		try {
			const storedApiKey = storage.getApiKey(providerId);
			if (storedApiKey) {
				return storedApiKey;
			}
			if (catalog.oauthProvider) {
				const storedOAuth = storage.getOAuth(catalog.oauthProvider);
				if (storedOAuth) {
					const result = await getOAuthApiKey(catalog.oauthProvider, { [catalog.oauthProvider]: storedOAuth });
					if (result) {
						storage.saveOAuth(catalog.oauthProvider, result.newCredentials);
						return result.apiKey;
					}
				}
			}
		} finally {
			storage.close();
		}
	} catch {
		// Ignore missing/unreadable auth storage.
	}

	return undefined;
}

async function fetchProviderModelsFromCatalog(descriptor: CatalogProviderDescriptor): Promise<Model[]> {
	const apiKey = await resolveProviderApiKey(descriptor.providerId, descriptor.catalogDiscovery);

	if (!apiKey && !allowsUnauthenticatedCatalogDiscovery(descriptor)) {
		console.log(`No ${descriptor.catalogDiscovery.label} credentials found (env or agent.db), using fallback models`);
		return [];
	}

	try {
		console.log(`Fetching models from ${descriptor.catalogDiscovery.label} model manager...`);
		const manager = createModelManager(descriptor.createModelManagerOptions({ apiKey }));
		const result = await manager.refresh("online");
		const models = result.models.filter(model => model.provider === descriptor.providerId);
		if (models.length === 0) {
			console.warn(`${descriptor.catalogDiscovery.label} discovery returned no models, using fallback models`);
			return [];
		}
		console.log(`Fetched ${models.length} models from ${descriptor.catalogDiscovery.label} model manager`);
		return models;
	} catch (error) {
		console.error(`Failed to fetch ${descriptor.catalogDiscovery.label} models:`, error);
		return [];
	}
}

async function generateModels() {
	// Fetch models from litellm (only remaining provider)
	const catalogProviderModels = (
		await Promise.all(
			PROVIDER_DESCRIPTORS.filter(isCatalogDescriptor).map(descriptor => fetchProviderModelsFromCatalog(descriptor)),
		)
	).flat();

	const allModels = [...catalogProviderModels];

	// Merge previous models.json entries as fallback for any provider/model
	// not fetched dynamically. This replaces all hardcoded fallback lists —
	// static-only providers (vertex, gemini-cli), auth-gated providers when
	// credentials are unavailable, and ad-hoc model additions all persist
	// through the existing models.json seed.
	// Discovery-only providers (local inference servers) — never bundle static models.
	const discoveryOnlyProviders = new Set(["ollama", "vllm"]);
	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	for (const models of Object.values(prevModelsJson as Record<string, Record<string, Model>>)) {
		for (const model of Object.values(models)) {
			if (!fetchedKeys.has(`${model.provider}/${model.id}`) && !discoveryOnlyProviders.has(model.provider)) {
				allModels.push(model);
			}
		}
	}

	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);

	// Group by provider and sort each provider's models
	const providers: Record<string, Record<string, Model>> = {};
	for (const model of allModels) {
		if (discoveryOnlyProviders.has(model.provider)) continue;
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to automatically deduplicate
		// Only add if not already present (litellm discovery takes priority)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// Sort providers alphabetically and models within each provider by ID
	const sortObj = <V>(o: Record<string, V>): Record<string, V> => {
		return Object.fromEntries(
			Object.entries(o)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, model]) => [id, model]),
		);
	};

	const MODELS: Record<string, Record<string, Model>> = sortObj(providers);
	for (const key in MODELS) {
		MODELS[key] = sortObj(MODELS[key]);
	}

	// Generate JSON file
	await Bun.write(path.join(packageRoot, "src/models.json"), JSON.stringify(MODELS, null, "\t"));
	console.log("Generated src/models.json");

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`
Model Statistics:`);
	console.log(`  Total models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(MODELS)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// Run the generator
generateModels().catch(console.error);
