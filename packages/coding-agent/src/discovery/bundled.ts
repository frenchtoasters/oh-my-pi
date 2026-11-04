/**
 * Bundled Provider
 *
 * Skills shipped in packages/coding-agent/bundled/skills, so every checkout has them.
 * Lowest priority: any user, project, or tool-specific skill with the same name wins.
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type Skill, skillCapability } from "../capability/skill";
import { scanSkillsFromDir } from "./helpers";

const PROVIDER_ID = "bundled";

// ponytail: resolved from the source tree. A `bun build --compile` binary has no
// bundled/ dir on disk and loads nothing; embed via Bun.embeddedFiles if compiled builds matter.
const BUNDLED_SKILLS_DIR = path.join(import.meta.dir, "..", "..", "bundled", "skills");

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: "Bundled",
	description: "Skills shipped with oh-my-pi",
	priority: 1,
	load: ctx =>
		scanSkillsFromDir(ctx, {
			dir: BUNDLED_SKILLS_DIR,
			level: "user",
			providerId: PROVIDER_ID,
			requireDescription: true,
		}),
});
