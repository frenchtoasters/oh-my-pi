/**
 * SubagentSessionFactory — pre-computes and caches immutable discovery artifacts
 * so subagent sessions can be stamped out without redundant filesystem scans.
 *
 * Created lazily on first task invocation and reused for all subsequent spawns
 * within the same parent session.
 */

import * as path from "node:path";
import type { Rule } from "../capability/rule";
import type { LoadExtensionsResult } from "../extensibility/extensions/types";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { AgentsMdSearch } from "../system-prompt";
import type { WorkspaceTree } from "../workspace-tree";

/**
 * Cached discovery results that are immutable for the lifetime of the parent session.
 * These are safe to share across all subagent spawns within the same project.
 */
export interface CachedDiscovery {
	/** The CWD these discoveries were computed for */
	cwd: string;
	/** Pre-loaded extension discovery result */
	preloadedExtensions: LoadExtensionsResult;
	/** All discovered rules (rulebook + alwaysApply) */
	rules: Rule[];
	/** Discovered file-based slash commands */
	slashCommands: FileSlashCommand[];
	/** AGENTS.md search result (CWD-relative) */
	agentsMdSearch?: AgentsMdSearch;
	/** Workspace tree (CWD-relative) */
	workspaceTree?: WorkspaceTree;
}

export interface SubagentSessionFactoryOptions {
	/** Parent session's working directory */
	cwd: string;
	/** Pre-loaded extensions from parent */
	preloadedExtensions?: LoadExtensionsResult;
	/** Discovered rules from parent */
	rules?: Rule[];
	/** Discovered slash commands from parent */
	slashCommands?: FileSlashCommand[];
	/** Pre-computed AGENTS.md search from parent */
	agentsMdSearch?: AgentsMdSearch;
	/** Pre-computed workspace tree from parent */
	workspaceTree?: WorkspaceTree;
}

/**
 * Caches and serves pre-computed discovery artifacts for subagent sessions.
 *
 * Usage:
 * ```ts
 * const factory = new SubagentSessionFactory({ cwd, ...session });
 * // For same-CWD subagents: full cache including workspace tree + AGENTS.md
 * const cached = factory.getCachedDiscovery(effectiveCwd);
 * // cached.agentsMdSearch and cached.workspaceTree will be undefined if CWD differs
 * ```
 */
export class SubagentSessionFactory {
	#options: SubagentSessionFactoryOptions;
	#cached?: CachedDiscovery;

	constructor(options: SubagentSessionFactoryOptions) {
		this.#options = options;
		// Build cache immediately from provided values
		if (options.preloadedExtensions && options.rules && options.slashCommands) {
			this.#cached = {
				cwd: options.cwd,
				preloadedExtensions: options.preloadedExtensions,
				rules: options.rules,
				slashCommands: options.slashCommands,
				agentsMdSearch: options.agentsMdSearch,
				workspaceTree: options.workspaceTree,
			};
		}
	}

	/** Whether the factory has cached discovery results ready. */
	get isWarmed(): boolean {
		return this.#cached !== undefined;
	}

	/** The CWD these cached discoveries were computed against. */
	get cwd(): string {
		return this.#options.cwd;
	}

	/**
	 * Get cached discovery results, applying CWD-gating logic.
	 *
	 * Extensions, rules, and slash commands are always returned regardless of CWD because
	 * they are discovered via config-dir traversal (walking up to `.omp/`) rather than
	 * scanning directory content. This means:
	 * - Same-CWD subagents: get full cache including workspace tree + AGENTS.md
	 * - Different-CWD subagents (e.g. fuse-overlay in /tmp): still get extensions/rules/commands
	 *   (which they'd miss entirely without the cache since the overlay has no `.omp/` ancestor)
	 *
	 * Note: This optimization does not cascade to nested subagents (subagent-of-subagent).
	 * If the intermediate subagent's toolSession doesn't populate preloadedExtensions,
	 * the factory won't warm and grandchild subagents fall through to full discovery.
	 * This is safe but means nested task invocations don't benefit from the cache.
	 */
	getCachedDiscovery(effectiveCwd: string): Partial<CachedDiscovery> | undefined {
		if (!this.#cached) return undefined;

		const cwdMatches = path.resolve(effectiveCwd) === path.resolve(this.#cached.cwd);

		return {
			cwd: this.#cached.cwd,
			preloadedExtensions: this.#cached.preloadedExtensions,
			rules: this.#cached.rules,
			slashCommands: this.#cached.slashCommands,
			// CWD-gated: only share workspace tree and AGENTS.md when in same directory
			agentsMdSearch: cwdMatches ? this.#cached.agentsMdSearch : undefined,
			workspaceTree: cwdMatches ? this.#cached.workspaceTree : undefined,
		};
	}
}
