import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { applyBaseline, captureBaseline, getEncodedProjectName, type WorktreeBaseline } from "../task/worktree";
import * as git from "../utils/git";

export interface SessionWorktreeInfo {
	slug: string;
	worktreeDir: string;
	branch: string;
	repoRoot: string;
}

export interface MergeResult {
	success: boolean;
	/** The final branch name containing the work (e.g. "feature/fix-login") */
	targetBranch: string;
	/** The base branch the target was created from (e.g. "main") */
	baseBranch: string;
}

export function getSessionWorktreeDir(repoRoot: string, slug: string): string {
	const encodedProject = getEncodedProjectName(repoRoot);
	return getWorktreeDir(path.join(encodedProject, `session-${slug}`));
}

export function getSessionBranchName(slug: string): string {
	return `omp/session/${slug}`;
}

/**
 * Validates a session slug. The slug is used both as a filesystem directory
 * name (`session-<slug>`) and embedded into a git branch (`omp/session/<slug>`),
 * so it must not contain path separators or characters that are invalid in
 * either context. A slug like `fix/issue-thing` would create nested folders
 * (`fix/` containing `issue-thing`) while the branch expects a flat directory,
 * desyncing the worktree from its branch.
 */
export function validateSlug(slug: string): void {
	if (!slug) {
		throw new Error("Worktree name cannot be empty.");
	}
	if (slug.includes("/") || slug.includes("\\")) {
		throw new Error(
			`Worktree name cannot contain path separators ("/" or "\\"): "${slug}". Use dashes instead (e.g. "fix-issue-thing").`,
		);
	}
	if (slug === "." || slug === "..") {
		throw new Error(`Worktree name cannot be "." or "..": "${slug}".`);
	}
	// Disallow characters that are invalid in git refs or on common filesystems.
	const invalidChars = /[\s~^:?*[\]<>|"\x00-\x1f]/;
	if (invalidChars.test(slug)) {
		throw new Error(
			`Worktree name contains invalid characters: "${slug}". Use letters, digits, dashes, dots, and underscores.`,
		);
	}
	if (slug.startsWith("-") || slug.startsWith(".")) {
		throw new Error(`Worktree name cannot start with "-" or ".": "${slug}".`);
	}
	if (slug.endsWith(".lock") || slug.endsWith(".")) {
		throw new Error(`Worktree name cannot end with "." or ".lock": "${slug}".`);
	}
}

/**
 * Resolves the base ref that session worktrees should branch from. The monorepo
 * workflow always builds features off `origin/main`, so we prefer that ref. If
 * `origin/main` is not available locally (e.g. fresh clone with a different
 * default), we fall back to `main`, then to the current HEAD as a last resort.
 */
async function resolveBaseRef(repoRoot: string): Promise<string> {
	for (const ref of ["origin/main", "main"]) {
		const check = await $`git -C ${repoRoot} rev-parse --verify --quiet ${`${ref}^{commit}`}`.nothrow();
		if (check.exitCode === 0) return ref;
	}
	return "HEAD";
}

/**
 * Returns the path of a worktree (other than `excludePath`) that currently has
 * `branchName` checked out, or undefined if none does. Used to guard against
 * renaming a branch that is checked out elsewhere, which git refuses to do.
 */
async function findWorktreeForBranch(
	repoRoot: string,
	branchName: string,
	excludePath: string,
): Promise<string | undefined> {
	const fullRef = `refs/heads/${branchName}`;
	const normalizedExclude = path.resolve(excludePath);
	const entries = await git.worktree.list(repoRoot);
	for (const entry of entries) {
		if (entry.branch !== fullRef) continue;
		if (path.resolve(entry.path) === normalizedExclude) continue;
		return entry.path;
	}
	return undefined;
}

export async function createSessionWorktree(
	repoRoot: string,
	slug: string,
	options?: { transferDirtyState?: boolean; baseRef?: string },
): Promise<SessionWorktreeInfo> {
	validateSlug(slug);
	const worktreeDir = getSessionWorktreeDir(repoRoot, slug);
	const branch = getSessionBranchName(slug);

	// Determine the ref to branch from — defaults to origin/main for the monorepo flow.
	const baseRef = options?.baseRef ?? (await resolveBaseRef(repoRoot));

	// Create parent directory
	await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

	// Capture baseline if transferring dirty state
	let baseline: WorktreeBaseline | undefined;
	if (options?.transferDirtyState) {
		baseline = await captureBaseline(repoRoot);
	}

	// Create worktree with branch, based on origin/main (or resolved fallback).
	const addResult = await $`git -C ${repoRoot} worktree add -b ${branch} ${worktreeDir} ${baseRef}`.nothrow();
	if (addResult.exitCode !== 0) {
		const stderr = addResult.stderr.toString().trim();
		throw new Error(`Failed to create worktree from "${baseRef}": ${stderr || "unknown error"}`);
	}

	// Apply baseline if captured
	if (baseline) {
		await applyBaseline(worktreeDir, baseline);
	}

	logger.debug("Session worktree created", { slug, worktreeDir, branch });
	return { slug, worktreeDir, branch, repoRoot };
}

export async function listSessionWorktrees(repoRoot: string): Promise<SessionWorktreeInfo[]> {
	const encodedProject = getEncodedProjectName(repoRoot);
	const projectWorktreeContainer = getWorktreeDir(encodedProject);

	const result: SessionWorktreeInfo[] = [];

	try {
		const entries = await fs.readdir(projectWorktreeContainer, { withFileTypes: true });

		for (const entry of entries) {
			// Only check directories starting with 'session-'
			if (!entry.isDirectory() || !entry.name.startsWith("session-")) {
				continue;
			}

			const worktreeDir = path.join(projectWorktreeContainer, entry.name);

			// Check if it's a valid worktree by checking for .git file
			try {
				await fs.stat(path.join(worktreeDir, ".git"));
			} catch {
				// Not a valid worktree, skip
				continue;
			}

			// Extract slug from directory name
			const slug = entry.name.slice("session-".length);
			const branch = getSessionBranchName(slug);

			result.push({
				slug,
				worktreeDir,
				branch,
				repoRoot,
			});
		}
	} catch (err) {
		// Directory doesn't exist yet, return empty list
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw err;
	}

	return result;
}

export async function removeSessionWorktree(
	repoRoot: string,
	slug: string,
	options?: { force?: boolean },
): Promise<void> {
	const worktreeDir = getSessionWorktreeDir(repoRoot, slug);
	const branch = getSessionBranchName(slug);

	// Check for uncommitted changes unless force is set
	if (!options?.force) {
		const status = await $`git -C ${worktreeDir} status --porcelain`.quiet().nothrow().text();
		if (status.trim()) {
			throw new Error(`Worktree has uncommitted changes; use force: true to proceed`);
		}
	}

	// Remove worktree
	await git.worktree.remove(repoRoot, worktreeDir, { force: true });

	// Clean up directory if still exists
	await fs.rm(worktreeDir, { recursive: true, force: true });

	// Delete the branch
	await $`git -C ${repoRoot} branch -D ${branch}`.quiet().nothrow();

	logger.debug("Session worktree removed", { slug, worktreeDir });
}

export type BranchType = "feature" | "fix" | "chore" | "refactor" | "docs";

export interface MergeOptions {
	/** Branch type prefix (feature, fix, chore, etc.). Default: inferred from slug or "feature". */
	type?: BranchType;
	/** Explicit target branch name. Overrides type + slug derivation. */
	targetBranch?: string;
	/** Whether to squash all worktree commits into a single commit. Default: false. */
	squash?: boolean;
}

/**
 * "Merges" a session worktree by renaming its branch to a properly-named
 * feature/fix/chore branch, ready to push for MR. Does NOT merge into main.
 *
 * Flow:
 * 1. Validates worktree state (no uncommitted changes, branch exists)
 * 2. Determines target branch name (e.g. "feature/fix-login")
 * 3. Optionally squashes commits
 * 4. Removes the worktree directory (keeps the branch)
 * 5. Renames the session branch to the target name
 *
 * After this, the user is back on the base branch with the target branch
 * ready to `git push -u origin <branch>`.
 */
export async function mergeSessionWorktree(
	repoRoot: string,
	slug: string,
	options?: MergeOptions,
): Promise<MergeResult> {
	const worktreeDir = getSessionWorktreeDir(repoRoot, slug);
	const sessionBranch = getSessionBranchName(slug);

	// Verify worktree branch exists
	const branchCheck = await $`git -C ${repoRoot} rev-parse --verify ${sessionBranch}`.nothrow();
	if (branchCheck.exitCode !== 0) {
		const stderr = branchCheck.stderr.toString().trim();
		throw new Error(`Branch "${sessionBranch}" does not exist: ${stderr || "branch not found"}`);
	}

	// Check worktree has no uncommitted changes (user should commit first)
	const worktreeStatusResult = await $`git -C ${worktreeDir} status --porcelain`.nothrow();
	const worktreeStatus = worktreeStatusResult.text();
	if (worktreeStatus.trim()) {
		throw new Error("Worktree has uncommitted changes. Commit or stash your work before merging.");
	}

	// Resolve the base ref the feature was built on — the monorepo flow always
	// builds off origin/main, so report that as the base (falling back if absent).
	const baseBranch = await resolveBaseRef(repoRoot);

	// Determine target branch name
	const targetBranch = options?.targetBranch ?? deriveTargetBranch(slug, options?.type);

	// Validate the target branch is a legal git ref name (an explicit --branch may
	// contain spaces or invalid characters that would make `git branch -m` fail).
	const refCheck = await $`git -C ${repoRoot} check-ref-format ${`refs/heads/${targetBranch}`}`.nothrow();
	if (refCheck.exitCode !== 0) {
		throw new Error(
			`"${targetBranch}" is not a valid branch name. Use letters, digits, dashes, slashes, dots, and underscores.`,
		);
	}

	// Check target branch doesn't already exist
	const targetCheck = await $`git -C ${repoRoot} rev-parse --verify ${targetBranch}`.nothrow();
	if (targetCheck.exitCode === 0) {
		throw new Error(`Branch "${targetBranch}" already exists. Choose a different name with --branch.`);
	}

	// Guard: the session branch must not be checked out in another worktree, or
	// `git branch -m` will fail. Find any worktree (other than the one we're about
	// to remove) that currently has the session branch checked out.
	const conflictingWorktree = await findWorktreeForBranch(repoRoot, sessionBranch, worktreeDir);
	if (conflictingWorktree) {
		throw new Error(
			`Branch "${sessionBranch}" is checked out in another worktree (${conflictingWorktree}). ` +
				`Switch that worktree to a different branch before merging.`,
		);
	}

	// Verify the session branch actually has commits beyond the base. Without this,
	// a squash reset+commit would fail with a confusing "nothing to commit", and a
	// non-squash merge would produce an empty branch with nothing to push.
	const aheadResult = await $`git -C ${repoRoot} rev-list --count ${`${baseBranch}..${sessionBranch}`}`.nothrow();
	const aheadCount = aheadResult.exitCode === 0 ? Number.parseInt(aheadResult.text().trim(), 10) || 0 : 0;
	if (aheadCount === 0) {
		// Common failure mode: work was committed to the base branch (e.g. main)
		// instead of the session branch — typically because the agent's tools ran
		// in the wrong working directory. Detect commits on the base beyond its
		// upstream so we can point the user at the real problem.
		let hint = `Commit your work in the worktree before merging (the session must contain at least one commit).`;
		const upstreamResult =
			await $`git -C ${repoRoot} rev-parse --verify --quiet ${`${baseBranch}@{upstream}`}`.nothrow();
		if (upstreamResult.exitCode === 0) {
			const baseAheadResult =
				await $`git -C ${repoRoot} rev-list --count ${`${baseBranch}@{upstream}..${baseBranch}`}`.nothrow();
			const baseAhead = baseAheadResult.exitCode === 0 ? Number.parseInt(baseAheadResult.text().trim(), 10) || 0 : 0;
			if (baseAhead > 0) {
				hint =
					`Found ${baseAhead} commit(s) on "${baseBranch}" that are not on the session branch — ` +
					`your work may have landed on "${baseBranch}" instead of "${sessionBranch}". ` +
					`Move those commits onto the session branch before merging.`;
			}
		}
		throw new Error(`No commits to merge: branch "${sessionBranch}" has no commits beyond "${baseBranch}". ${hint}`);
	}

	// Optionally squash commits into one
	if (options?.squash) {
		const mergeBaseResult = await $`git -C ${repoRoot} merge-base ${baseBranch} ${sessionBranch}`.nothrow();
		if (mergeBaseResult.exitCode !== 0) {
			const stderr = mergeBaseResult.stderr.toString().trim();
			throw new Error(`Failed to find merge base: ${stderr}`);
		}
		const mergeBase = mergeBaseResult.text().trim();
		const resetResult = await $`git -C ${worktreeDir} reset --soft ${mergeBase}`.nothrow();
		if (resetResult.exitCode !== 0) {
			const stderr = resetResult.stderr.toString().trim();
			throw new Error(`Failed to reset worktree: ${stderr}`);
		}
		const commitMsg = `${options?.type ?? "feature"}(${slug}): squashed session work`;
		const commitResult = await $`git -C ${worktreeDir} commit -m ${commitMsg}`.nothrow();
		if (commitResult.exitCode !== 0) {
			const stderr = commitResult.stderr.toString().trim();
			throw new Error(`Failed to commit squashed changes: ${stderr}`);
		}
	}

	// Remove the worktree (keeps the branch intact in the repo), then rename the
	// session branch to the target name. These two steps are not atomic: if the
	// rename fails after the worktree is gone, we roll back by re-creating the
	// worktree so the user can retry, and surface the original branch name.
	await git.worktree.remove(repoRoot, worktreeDir, { force: true });
	await fs.rm(worktreeDir, { recursive: true, force: true });

	const renameResult = await $`git -C ${repoRoot} branch -m ${sessionBranch} ${targetBranch}`.nothrow();
	if (renameResult.exitCode !== 0) {
		const stderr = renameResult.stderr.toString().trim();
		// Attempt rollback: re-attach the worktree to the still-existing session branch.
		const rollback = await $`git -C ${repoRoot} worktree add ${worktreeDir} ${sessionBranch}`.nothrow();
		const rollbackNote =
			rollback.exitCode === 0
				? `The worktree was restored at "${worktreeDir}".`
				: `Rollback also failed (${rollback.stderr.toString().trim() || "unknown error"}); ` +
					`your work is preserved on branch "${sessionBranch}" — recover it with ` +
					`\`git worktree add <dir> ${sessionBranch}\` or \`git checkout ${sessionBranch}\`.`;
		throw new Error(`Failed to rename branch "${sessionBranch}" to "${targetBranch}": ${stderr}. ${rollbackNote}`);
	}

	logger.debug("Session worktree merged to branch", { slug, targetBranch, baseBranch });

	return {
		success: true,
		targetBranch,
		baseBranch,
	};
}

/** Derive a target branch name from the slug and optional type. */
function deriveTargetBranch(slug: string, type?: BranchType): string {
	const inferredType = type ?? inferBranchType(slug);
	return `${inferredType}/${slug}`;
}

function inferBranchType(slug: string): BranchType {
	const lower = slug.toLowerCase();
	if (lower.startsWith("fix-") || lower.startsWith("bug-") || lower.startsWith("hotfix-")) {
		return "fix";
	}
	if (lower.startsWith("chore-") || lower.startsWith("deps-") || lower.startsWith("ci-")) {
		return "chore";
	}
	if (lower.startsWith("refactor-") || lower.startsWith("cleanup-")) {
		return "refactor";
	}
	if (lower.startsWith("docs-") || lower.startsWith("doc-")) {
		return "docs";
	}
	return "feature";
}

export async function validateSessionWorktree(repoRoot: string, slug: string): Promise<boolean> {
	const worktreeDir = getSessionWorktreeDir(repoRoot, slug);

	try {
		await fs.stat(worktreeDir);
		await fs.stat(path.join(worktreeDir, ".git"));
		return true;
	} catch {
		return false;
	}
}
