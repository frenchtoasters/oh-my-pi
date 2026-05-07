import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { emitSecurityEvent, getConfigRootDir, isEnoent, SecurityEventType } from "@oh-my-pi/pi-utils";

export interface ConfigBaseline {
	hash: string;
	timestamp: string;
	version: number;
}

export interface ConfigIntegrityResult {
	status: "match" | "changed" | "no_baseline";
	currentHash: string;
	baselineHash?: string;
	baselineTimestamp?: string;
}

export function computeConfigHash(configData: Record<string, unknown>): string {
	const sorted = JSON.stringify(configData, Object.keys(configData).sort());
	return crypto.createHash("sha256").update(sorted, "utf8").digest("hex");
}

export async function getBaselinePath(): Promise<string> {
	return path.join(getConfigRootDir(), "config-baseline.json");
}

export async function loadBaseline(): Promise<ConfigBaseline | null> {
	const baselinePath = await getBaselinePath();
	try {
		const content = await fs.readFile(baselinePath, "utf8");
		return JSON.parse(content) as ConfigBaseline;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

export async function saveBaseline(hash: string): Promise<void> {
	const baseline: ConfigBaseline = {
		hash,
		timestamp: new Date().toISOString(),
		version: 1,
	};
	const baselinePath = await getBaselinePath();
	await Bun.write(baselinePath, JSON.stringify(baseline, null, 2));
	emitSecurityEvent(SecurityEventType.CONFIG_CHANGE, baselinePath, "success", { newHash: hash });
}

export async function verifyConfigIntegrity(currentConfig: Record<string, unknown>): Promise<ConfigIntegrityResult> {
	const currentHash = computeConfigHash(currentConfig);
	const baseline = await loadBaseline();

	if (baseline === null) {
		return { status: "no_baseline", currentHash };
	}

	const { hash: baselineHash, timestamp: baselineTimestamp } = baseline;

	if (currentHash === baselineHash) {
		return { status: "match", currentHash, baselineHash, baselineTimestamp };
	}

	emitSecurityEvent(SecurityEventType.CONFIG_CHANGE, await getBaselinePath(), "failure", {
		oldHash: baselineHash,
		newHash: currentHash,
	});

	return { status: "changed", currentHash, baselineHash, baselineTimestamp };
}
