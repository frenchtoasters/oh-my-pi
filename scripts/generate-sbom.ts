#!/usr/bin/env bun

/**
 * Generates a CycloneDX 1.5 SBOM from bun.lock and Cargo.lock.
 */

import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CycloneDXComponent {
	type: "library";
	name: string;
	version: string;
	purl: string;
	scope: "required" | "optional";
}

interface CycloneDXDocument {
	bomFormat: "CycloneDX";
	specVersion: "1.5";
	version: 1;
	metadata: {
		timestamp: string;
		tools: Array<{ vendor: string; name: string; version: string }>;
		component: {
			type: "application";
			name: string;
			version: string;
		};
	};
	components: CycloneDXComponent[];
}

// Structure of a bun.lock v1 workspace entry
interface BunWorkspace {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

// bun.lock package entry: [resolvedNameAtVersion, registry, metadata, checksum]
type BunPackageEntry = [string, string, Record<string, unknown>, string];

interface BunLock {
	lockfileVersion: number;
	workspaces?: Record<string, BunWorkspace>;
	packages?: Record<string, BunPackageEntry>;
}

interface RootPackageJson {
	name: string;
	version?: string;
	description?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripJsoncTrailingCommas(text: string): string {
	// Remove single-line comments then trailing commas before } or ]
	return text
		.replace(/\/\/[^\n]*/g, "")
		.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse bun.lock (JSONC with trailing commas).
 * Falls back to Bun.JSON5 if available, otherwise strips commas manually.
 */
async function parseBunLock(lockPath: string): Promise<BunLock> {
	const text = await Bun.file(lockPath).text();

	// Prefer Bun.JSON5 (available in Bun ≥ 1.x)
	if (typeof Bun.JSON5?.parse === "function") {
		return Bun.JSON5.parse(text) as BunLock;
	}

	// Fallback: strip trailing commas and parse as regular JSON
	return JSON.parse(stripJsoncTrailingCommas(text)) as BunLock;
}

/**
 * Parse Cargo.lock (TOML v4) by extracting [[package]] sections with regex.
 * Only extracts name, version, and source — sufficient for SBOM purposes.
 */
function parseCargoLock(text: string): Array<{ name: string; version: string; source?: string }> {
	const packages: Array<{ name: string; version: string; source?: string }> = [];

	// Split on [[package]] boundaries
	const sections = text.split(/^\s*\[\[package\]\]\s*$/m);

	for (const section of sections) {
		const nameMatch = section.match(/^name\s*=\s*"([^"]+)"/m);
		const versionMatch = section.match(/^version\s*=\s*"([^"]+)"/m);
		if (!nameMatch || !versionMatch) continue;

		const sourceMatch = section.match(/^source\s*=\s*"([^"]+)"/m);
		packages.push({
			name: nameMatch[1],
			version: versionMatch[1],
			source: sourceMatch?.[1],
		});
	}

	return packages;
}

/**
 * Collect all optional dependency names across all workspaces.
 */
function collectOptionalDeps(lock: BunLock): Set<string> {
	const optional = new Set<string>();
	for (const workspace of Object.values(lock.workspaces ?? {})) {
		for (const name of Object.keys(workspace.optionalDependencies ?? {})) {
			optional.add(name);
		}
	}
	return optional;
}

/**
 * Encode a purl component (percent-encode special chars).
 * npm scopes use the form pkg:npm/%40scope/name@version.
 */
function encodePurlName(name: string): string {
	// Percent-encode @ in scoped npm package names
	return name.replace(/^@/, "%40");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dir, "..");
const bunLockPath = path.join(repoRoot, "bun.lock");
const cargoLockPath = path.join(repoRoot, "Cargo.lock");
const outputPath = path.join(repoRoot, "sbom.cdx.json");
const rootPkgJsonPath = path.join(repoRoot, "package.json");

// Read inputs in parallel
const [bunLock, cargoLockText, rootPkgJson] = await Promise.all([
	parseBunLock(bunLockPath),
	Bun.file(cargoLockPath).text(),
	Bun.file(rootPkgJsonPath).json<RootPackageJson>(),
]);

const components: CycloneDXComponent[] = [];

// --- npm/bun packages ---
const optionalNpm = collectOptionalDeps(bunLock);
const bunPackages = bunLock.packages ?? {};

for (const [, entry] of Object.entries(bunPackages)) {
	// entry[0] is "name@version"
	const resolvedId = entry[0];
	// Split on last @ to handle scoped packages like @scope/pkg@1.0.0
	const atIdx = resolvedId.lastIndexOf("@");
	if (atIdx <= 0) continue; // malformed or root package

	const name = resolvedId.slice(0, atIdx);
	const version = resolvedId.slice(atIdx + 1);
	if (!name || !version) continue;

	const encodedName = encodePurlName(name);
	const purl = `pkg:npm/${encodedName}@${version}`;

	components.push({
		type: "library",
		name,
		version,
		purl,
		scope: optionalNpm.has(name) ? "optional" : "required",
	});
}

// --- Cargo packages ---
const cargoPkgs = parseCargoLock(cargoLockText);

for (const pkg of cargoPkgs) {
	// Skip packages without a registry source (workspace-local crates)
	if (!pkg.source) continue;

	const purl = `pkg:cargo/${pkg.name}@${pkg.version}`;

	components.push({
		type: "library",
		name: pkg.name,
		version: pkg.version,
		purl,
		scope: "required",
	});
}

// --- Assemble document ---
const sbom: CycloneDXDocument = {
	bomFormat: "CycloneDX",
	specVersion: "1.5",
	version: 1,
	metadata: {
		timestamp: new Date().toISOString(),
		tools: [
			{
				vendor: "oh-my-pi",
				name: "generate-sbom",
				version: "1.0.0",
			},
		],
		component: {
			type: "application",
			name: rootPkgJson.name,
			version: rootPkgJson.version ?? "0.0.0",
		},
	},
	components,
};

await Bun.write(outputPath, JSON.stringify(sbom, null, 2));

const npmCount = components.filter((c) => c.purl.startsWith("pkg:npm/")).length;
const cargoCount = components.filter((c) => c.purl.startsWith("pkg:cargo/")).length;

process.stdout.write(
	`SBOM generated: ${components.length} components (${npmCount} npm, ${cargoCount} cargo)\n`,
);
process.stdout.write(`Output: ${outputPath}\n`);
