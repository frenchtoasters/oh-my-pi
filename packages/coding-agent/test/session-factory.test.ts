/**
 * Unit tests for SubagentSessionFactory
 */

import { describe, expect, test } from "bun:test";
import type { Rule } from "../src/capability/rule";
import type { LoadExtensionsResult } from "../src/extensibility/extensions/types";
import type { FileSlashCommand } from "../src/extensibility/slash-commands";
import type { AgentsMdSearch } from "../src/system-prompt";
import { SubagentSessionFactory, type SubagentSessionFactoryOptions } from "../src/task/session-factory";
import type { WorkspaceTree } from "../src/workspace-tree";

/**
 * Minimal valid mock data for each required type
 */

function createMockLoadExtensionsResult(): LoadExtensionsResult {
	return {
		extensions: [],
		errors: [],
		runtime: { totalMs: 0, extensionMs: [] } as any,
	};
}

function createMockRules(): Rule[] {
	return [];
}

function createMockSlashCommands(): FileSlashCommand[] {
	return [];
}

function createMockAgentsMdSearch(): AgentsMdSearch {
	return {
		scopePath: "/test",
		limit: 0,
		pattern: "",
		files: [],
	};
}

function createMockWorkspaceTree(): WorkspaceTree {
	return {
		rootPath: "/test",
		rendered: "test tree",
		truncated: false,
		totalLines: 1,
	};
}

describe("SubagentSessionFactory", () => {
	/**
	 * Test 1: Factory warms when all required fields provided
	 * Contract: When preloadedExtensions, rules, and slashCommands are all provided,
	 * isWarmed should be true.
	 */
	test("warms when all required fields provided", () => {
		const options: SubagentSessionFactoryOptions = {
			cwd: "/test/cwd",
			preloadedExtensions: createMockLoadExtensionsResult(),
			rules: createMockRules(),
			slashCommands: createMockSlashCommands(),
		};

		const factory = new SubagentSessionFactory(options);
		expect(factory.isWarmed).toBe(true);
	});

	/**
	 * Test 2: Factory does NOT warm when preloadedExtensions missing
	 * Contract: When preloadedExtensions is undefined (or omitted),
	 * isWarmed should be false even if rules and slashCommands are provided.
	 */
	test("does NOT warm when preloadedExtensions missing", () => {
		const options: SubagentSessionFactoryOptions = {
			cwd: "/test/cwd",
			rules: createMockRules(),
			slashCommands: createMockSlashCommands(),
		};

		const factory = new SubagentSessionFactory(options);
		expect(factory.isWarmed).toBe(false);
	});

	/**
	 * Test 3: Factory does NOT warm when rules missing
	 * Contract: When rules is undefined (or omitted),
	 * isWarmed should be false even if preloadedExtensions and slashCommands are provided.
	 */
	test("does NOT warm when rules missing", () => {
		const options: SubagentSessionFactoryOptions = {
			cwd: "/test/cwd",
			preloadedExtensions: createMockLoadExtensionsResult(),
			slashCommands: createMockSlashCommands(),
		};

		const factory = new SubagentSessionFactory(options);
		expect(factory.isWarmed).toBe(false);
	});

	/**
	 * Test 4: Factory does NOT warm when slashCommands missing
	 * Contract: When slashCommands is undefined (or omitted),
	 * isWarmed should be false even if preloadedExtensions and rules are provided.
	 */
	test("does NOT warm when slashCommands missing", () => {
		const options: SubagentSessionFactoryOptions = {
			cwd: "/test/cwd",
			preloadedExtensions: createMockLoadExtensionsResult(),
			rules: createMockRules(),
		};

		const factory = new SubagentSessionFactory(options);
		expect(factory.isWarmed).toBe(false);
	});

	/**
	 * Test 5: getCachedDiscovery returns undefined when not warmed
	 * Contract: When the factory is not warmed (missing required fields),
	 * getCachedDiscovery should return undefined regardless of the effectiveCwd parameter.
	 */
	test("getCachedDiscovery returns undefined when not warmed", () => {
		const options: SubagentSessionFactoryOptions = {
			cwd: "/test/cwd",
			// Intentionally omit one required field to prevent warming
			rules: createMockRules(),
			slashCommands: createMockSlashCommands(),
		};

		const factory = new SubagentSessionFactory(options);
		const result = factory.getCachedDiscovery("/some/other/cwd");

		expect(result).toBeUndefined();
	});

	/**
	 * Test 6: getCachedDiscovery returns full cache when CWD matches
	 * Contract: When the factory is warmed and effectiveCwd matches the factory's cwd,
	 * getCachedDiscovery should return the full cache including agentsMdSearch and workspaceTree.
	 */
	test("getCachedDiscovery returns full cache when CWD matches", () => {
		const testCwd = "/test/cwd";
		const preloadedExtensions = createMockLoadExtensionsResult();
		const rules = createMockRules();
		const slashCommands = createMockSlashCommands();
		const agentsMdSearch = createMockAgentsMdSearch();
		const workspaceTree = createMockWorkspaceTree();

		const options: SubagentSessionFactoryOptions = {
			cwd: testCwd,
			preloadedExtensions,
			rules,
			slashCommands,
			agentsMdSearch,
			workspaceTree,
		};

		const factory = new SubagentSessionFactory(options);
		const result = factory.getCachedDiscovery(testCwd);

		expect(result).toBeDefined();
		expect(result?.cwd).toBe(testCwd);
		expect(result?.preloadedExtensions).toBe(preloadedExtensions);
		expect(result?.rules).toBe(rules);
		expect(result?.slashCommands).toBe(slashCommands);
		expect(result?.agentsMdSearch).toBe(agentsMdSearch);
		expect(result?.workspaceTree).toBe(workspaceTree);
	});

	/**
	 * Test 7: getCachedDiscovery excludes CWD-gated fields when CWD differs
	 * Contract: When the factory is warmed but effectiveCwd differs from the factory's cwd,
	 * getCachedDiscovery should return preloadedExtensions, rules, and slashCommands,
	 * but agentsMdSearch and workspaceTree should be undefined.
	 */
	test("getCachedDiscovery excludes CWD-gated fields when CWD differs", () => {
		const factoryCwd = "/test/cwd";
		const differentCwd = "/other/cwd";
		const preloadedExtensions = createMockLoadExtensionsResult();
		const rules = createMockRules();
		const slashCommands = createMockSlashCommands();
		const agentsMdSearch = createMockAgentsMdSearch();
		const workspaceTree = createMockWorkspaceTree();

		const options: SubagentSessionFactoryOptions = {
			cwd: factoryCwd,
			preloadedExtensions,
			rules,
			slashCommands,
			agentsMdSearch,
			workspaceTree,
		};

		const factory = new SubagentSessionFactory(options);
		const result = factory.getCachedDiscovery(differentCwd);

		expect(result).toBeDefined();
		expect(result?.cwd).toBe(factoryCwd);
		// Core fields should still be present
		expect(result?.preloadedExtensions).toBe(preloadedExtensions);
		expect(result?.rules).toBe(rules);
		expect(result?.slashCommands).toBe(slashCommands);
		// CWD-gated fields should be undefined
		expect(result?.agentsMdSearch).toBeUndefined();
		expect(result?.workspaceTree).toBeUndefined();
	});

	/**
	 * Test 8: CWD comparison is path-normalized
	 * Contract: CWD comparison should use path.resolve() normalization.
	 * Equivalent paths with trailing slashes, dots (./), or symlink variations
	 * should be considered equal.
	 */
	test("CWD comparison is path-normalized", () => {
		const baseCwd = "/test/cwd";
		const preloadedExtensions = createMockLoadExtensionsResult();
		const rules = createMockRules();
		const slashCommands = createMockSlashCommands();
		const agentsMdSearch = createMockAgentsMdSearch();
		const workspaceTree = createMockWorkspaceTree();

		const options: SubagentSessionFactoryOptions = {
			cwd: baseCwd,
			preloadedExtensions,
			rules,
			slashCommands,
			agentsMdSearch,
			workspaceTree,
		};

		const factory = new SubagentSessionFactory(options);

		// Test with trailing slash: /test/cwd/ should resolve to /test/cwd
		const cwdWithTrailingSlash = `${baseCwd}/`;
		const result1 = factory.getCachedDiscovery(cwdWithTrailingSlash);
		expect(result1).toBeDefined();
		expect(result1?.agentsMdSearch).toBe(agentsMdSearch);
		expect(result1?.workspaceTree).toBe(workspaceTree);

		// Test with ./: /test/cwd/. should resolve to /test/cwd
		const cwdWithDot = `${baseCwd}/.`;
		const result2 = factory.getCachedDiscovery(cwdWithDot);
		expect(result2).toBeDefined();
		expect(result2?.agentsMdSearch).toBe(agentsMdSearch);
		expect(result2?.workspaceTree).toBe(workspaceTree);

		// Test that different paths still exclude CWD-gated fields
		const differentCwd = `${baseCwd}-different`;
		const result3 = factory.getCachedDiscovery(differentCwd);
		expect(result3).toBeDefined();
		expect(result3?.agentsMdSearch).toBeUndefined();
		expect(result3?.workspaceTree).toBeUndefined();
	});

	/**
	 * Verify cwd property always returns the factory's original cwd
	 */
	test("cwd property returns the factory's cwd", () => {
		const testCwd = "/test/project";
		const options: SubagentSessionFactoryOptions = {
			cwd: testCwd,
			preloadedExtensions: createMockLoadExtensionsResult(),
			rules: createMockRules(),
			slashCommands: createMockSlashCommands(),
		};

		const factory = new SubagentSessionFactory(options);
		expect(factory.cwd).toBe(testCwd);
	});
});
