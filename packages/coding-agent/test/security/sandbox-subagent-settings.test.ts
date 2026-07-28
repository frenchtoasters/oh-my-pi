import { beforeAll, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxAccessMode, SandboxCaps } from "@oh-my-pi/pi-natives";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { BUILTIN_PROFILES, type SandboxMode, buildSandboxCaps, enforceSandboxAccess } from "../../src/security/sandbox";

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

let testDir: string;
let testSubDir: string;

beforeAll(async () => {
	const raw = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-subagent-"));
	testDir = fsSync.realpathSync(raw);
	testSubDir = path.join(testDir, "subdir");
	await fs.mkdir(testSubDir, { recursive: true });
	await fs.writeFile(path.join(testSubDir, "file.ts"), "export const x = 1;\n");
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings path collision: "security.sandbox" vs "security.sandbox.profileOverrides"
//
// When flattening settings to a dot-key record and rebuilding via setByPath,
// a child key (security.sandbox.profileOverrides) would overwrite the parent
// scalar (security.sandbox = "enforce") by converting it to an intermediate object.
// ═══════════════════════════════════════════════════════════════════════════

describe("Settings.isolated path collision (known limitation)", () => {
	// Settings.isolated uses setByPath which can't handle a key that is both
	// a scalar leaf AND a namespace prefix. The child key's setByPath call
	// replaces the scalar with an intermediate object. This is a known schema
	// design issue — createSubagentSettings works around it by removing
	// conflicting child keys before passing to Settings.isolated.

	it("sandbox mode and profile overrides no longer collide (separate keys)", () => {
		const settings = Settings.isolated({
			"security.sandbox": "enforce",
			"security.sandboxProfiles": {},
		});

		// security.sandbox stays a scalar; sandboxProfiles is a sibling key.
		expect(settings.get("security.sandbox")).toBe("enforce");
		expect(settings.get("security.sandboxProfiles")).toEqual({});
	});

	it("same collision affects todo.reminders", () => {
		const settings = Settings.isolated({
			"todo.reminders": true,
			"todo.reminders.max": 5,
		} as Record<SettingPath, unknown>);

		const value = settings.get("todo.reminders" as SettingPath);
		expect(typeof value).toBe("object"); // documents the bug
		expect(value).not.toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// createSubagentSettings integration: ensure sandbox mode survives cloning
//
// Reproduces the bug where subagents would get sandbox mode as an object
// instead of the expected string, causing enforcement to fall through to
// the warn branch instead of blocking.
// ═══════════════════════════════════════════════════════════════════════════

describe("createSubagentSettings sandbox mode propagation", () => {
	/**
	 * Simulate what createSubagentSettings does: read all settings from parent,
	 * pass them as overrides to Settings.isolated.
	 */
	function simulateSubagentSettings(parentSettings: Settings): Settings {
		const snapshot: Partial<Record<SettingPath, unknown>> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			snapshot[key] = parentSettings.get(key);
		}

		// Apply the fix: remove sub-path keys that conflict with scalar parents
		const keys = Object.keys(snapshot) as SettingPath[];
		for (const key of keys) {
			const value = snapshot[key];
			if (value !== null && value !== undefined && typeof value !== "object") {
				const prefix = `${key}.`;
				for (const other of keys) {
					if (other.startsWith(prefix)) {
						delete snapshot[other];
					}
				}
			}
		}

		return Settings.isolated({
			...snapshot,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
		});
	}

	it("subagent inherits enforce mode from parent", () => {
		const parent = Settings.isolated({ "security.sandbox": "enforce" });
		const child = simulateSubagentSettings(parent);

		expect(child.get("security.sandbox")).toBe("enforce");
	});

	it("subagent inherits warn mode from parent", () => {
		const parent = Settings.isolated({ "security.sandbox": "warn" });
		const child = simulateSubagentSettings(parent);

		expect(child.get("security.sandbox")).toBe("warn");
	});

	it("subagent sandbox enforcement actually blocks in enforce mode", () => {
		const parent = Settings.isolated({ "security.sandbox": "enforce" });
		const child = simulateSubagentSettings(parent);
		const caps = buildSandboxCaps(BUILTIN_PROFILES.explore, testDir);

		const session = {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: child,
			sandboxCaps: caps,
		} as unknown as ToolSession;

		// Path outside CWD should be blocked
		expect(() => enforceSandboxAccess(session, "/root/.ssh/id_rsa", "read")).toThrow(ToolError);

		// Path inside CWD should be allowed
		expect(() => enforceSandboxAccess(session, path.join(testSubDir, "file.ts"), "read")).not.toThrow();
	});

	it("sandbox mode survives alongside profile overrides (no collision)", () => {
		const rawSettings = Settings.isolated({
			"security.sandbox": "enforce",
			"security.sandboxProfiles": { explore: { fs: [], network: "blocked" } },
		});

		expect(rawSettings.get("security.sandbox")).toBe("enforce");
		expect(rawSettings.get("security.sandboxProfiles")).toEqual({ explore: { fs: [], network: "blocked" } });
	});
});
