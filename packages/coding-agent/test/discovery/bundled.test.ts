import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Skill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";

const BUNDLED_SKILLS_DIR = path.join(import.meta.dir, "..", "..", "bundled", "skills");

describe("bundled skill provider", () => {
	let cwd = "";

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bundled-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	test("loads every skill directory under bundled/skills", async () => {
		// A SKILL.md without a description is dropped silently, so a broken copy would vanish unnoticed.
		const entries = await fs.readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true });
		const expected = entries.filter(e => e.isDirectory()).map(e => e.name);
		expect(expected.length).toBeGreaterThan(0);

		const result = await loadCapability<Skill>(skillCapability.id, { cwd, providers: ["bundled"] });
		expect(result.items.map(s => s.name).sort()).toEqual(expected.sort());
	});

	test("a project skill with the same name replaces the bundled one", async () => {
		const skillDir = path.join(cwd, ".omp", "skills", "unslop");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: unslop\ndescription: project override\n---\nbody\n");

		const result = await loadCapability<Skill>(skillCapability.id, { cwd, providers: ["native", "bundled"] });
		const unslop = result.items.filter(s => s.name === "unslop");
		expect(unslop).toHaveLength(1);
		expect(unslop[0].path).toBe(path.join(skillDir, "SKILL.md"));
	});
});
