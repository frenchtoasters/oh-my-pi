import { $env } from "@oh-my-pi/pi-utils";
import type { CacheRetention } from "./types";

export { isRecord } from "@oh-my-pi/pi-utils";
export function normalizeSystemPrompts(systemPrompt: readonly string[] | undefined): string[] {
	return systemPrompt?.map(prompt => prompt.toWellFormed()).filter(prompt => prompt.length > 0) ?? [];
}

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function toPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return value;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

/**
 * Resolve cache retention preference.
 * Defaults to "long" (1-hour TTL). Use PI_CACHE_RETENTION env var to opt down to "short" or "none".
 */
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) return cacheRetention;
	if ($env.PI_CACHE_RETENTION === "none") return "none";
	if ($env.PI_CACHE_RETENTION === "short") return "short";
	return "long";
}

export function isAnthropicOAuthToken(key: string): boolean {
	return key.includes("sk-ant-oat");
}
