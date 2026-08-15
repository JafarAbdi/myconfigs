import { spawnSync } from "node:child_process";

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: readonly string[]): GitResult {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error) throw result.error;
	return {
		status: result.status,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	};
}

function failure(args: readonly string[], result: GitResult): Error {
	const detail = result.stderr || `exit ${String(result.status)}`;
	return new Error(`git ${args.join(" ")} failed: ${detail}`);
}

function git(cwd: string, args: readonly string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) throw failure(args, result);
	return result.stdout;
}

export function repositoryRoot(cwd: string): string {
	return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export function requireHead(repository: string): void {
	git(repository, ["rev-parse", "--verify", "HEAD"]);
}

export function branchExists(repository: string, branch: string): boolean {
	const args = ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`];
	const result = runGit(repository, args);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw failure(args, result);
}

export function addWorktree(repository: string, path: string, branch: string): void {
	git(repository, ["worktree", "add", "-b", branch, path, "HEAD"]);
}

export function discardWorktree(repository: string, path: string, branch: string): void {
	git(repository, ["worktree", "remove", "--force", path]);
	git(repository, ["branch", "-D", branch]);
}
