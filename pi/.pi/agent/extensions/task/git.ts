/**
 * The only Git this extension performs.
 *
 * Two writes exist, and each is the direct result of a keypress: `worktree add` when the operator
 * turns a plan into a workspace, and `worktree remove` behind the picker's delete confirmation.
 * Branches are never created except as part of `worktree add`, and never deleted: the branch is the
 * work, and it outlives the task that planned it. Nothing here stages, commits, merges, or rebases.
 *
 * Reads answer two questions: which task a session is driving, from the branch of its directory,
 * and what a worktree still holds that has not been committed — asked only when that worktree is
 * about to be deleted, and only where it can actually be answered.
 */

import { spawnSync } from "node:child_process";

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * `spawnSync` reports a failed command as data, so a git error is read rather than reconstructed.
 * A command that could not start at all — a missing directory, no git on PATH — is reported the
 * same way: total, so a question about a path that has gone answers "no", never throws past its
 * caller, and never has to be guarded by an existence check somewhere else.
 */
function run(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.error) return { status: null, stdout: "", stderr: result.error.message };
	return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function git(cwd: string, ...args: string[]): string {
	const { status, stdout, stderr } = run(cwd, args);
	if (status !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || `exit ${status}`}`);
	return stdout;
}

/** For questions where "no" is an ordinary answer: not a repository, no such branch. */
function tryGit(cwd: string, ...args: string[]): string | undefined {
	const { status, stdout } = run(cwd, args);
	return status === 0 ? stdout : undefined;
}

export function repositoryRoot(cwd: string): string | undefined {
	return tryGit(cwd, "rev-parse", "--show-toplevel") || undefined;
}

/** Empty on a detached HEAD, which is simply a session driving no task. */
export function currentBranch(cwd: string): string | undefined {
	return tryGit(cwd, "branch", "--show-current") || undefined;
}

export function branchExists(repository: string, branch: string): boolean {
	return tryGit(repository, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`) !== undefined;
}

export function addWorktree(repository: string, path: string, branch: string, base: string): void {
	git(repository, "worktree", "add", path, "-b", branch, base);
}

/** `--force` only when the operator confirmed a delete that named what it would discard. */
export function removeWorktree(repository: string, path: string, force: boolean): void {
	git(repository, "worktree", "remove", ...(force ? ["--force"] : []), path);
}

export interface WorktreeChanges {
	modified: number;
	untracked: number;
}

/**
 * What the worktree holds beyond its last commit, from `status --porcelain`: `??` entries are
 * untracked, everything else is a change to a tracked file. Undefined when git could not answer —
 * a caller that cannot say what would be discarded must not claim there is nothing.
 */
export function worktreeChanges(path: string): WorktreeChanges | undefined {
	const status = tryGit(path, "status", "--porcelain");
	if (status === undefined) return undefined;
	const lines = status ? status.split("\n") : [];
	const untracked = lines.filter((line) => line.startsWith("??")).length;
	return { modified: lines.length - untracked, untracked };
}

