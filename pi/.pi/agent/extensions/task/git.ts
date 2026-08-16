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
		stdout: result.stdout,
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
	return result.stdout.trim();
}

function gitRaw(cwd: string, args: readonly string[]): string {
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

export interface WorktreeChanges {
	modified: number;
	untracked: number;
	hasGitlinks: boolean;
}

function commonGitDirectory(cwd: string): string {
	return git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

function worktreeBranch(cwd: string): string | undefined {
	const args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
	const result = runGit(cwd, args);
	if (result.status === 0) return result.stdout.trim();
	if (result.status === 1) return undefined;
	throw failure(args, result);
}

function parseWorktreeChanges(output: string): Omit<WorktreeChanges, "hasGitlinks"> {
	if (output.length === 0) return { modified: 0, untracked: 0 };
	if (!output.endsWith("\0")) throw new Error("git status returned an unterminated porcelain record");
	const records = output.slice(0, -1).split("\0");
	let modified = 0;
	let untracked = 0;
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record || record.length < 4 || record[2] !== " ") {
			throw new Error("git status returned an invalid porcelain record");
		}
		const status = record.slice(0, 2);
		if (status === "??") {
			untracked += 1;
			continue;
		}
		const valid = [...status].every((character) => " MADRCUT".includes(character));
		if (!valid || status === "  ") {
			throw new Error(`git status returned invalid status ${JSON.stringify(status)}`);
		}
		modified += 1;
		if (!status.includes("R") && !status.includes("C")) continue;
		index += 1;
		if (!records[index]) throw new Error("git status returned an incomplete rename record");
	}
	return { modified, untracked };
}

function hasGitlinks(output: string): boolean {
	if (output.length === 0) return false;
	if (!output.endsWith("\0")) throw new Error("git ls-files returned an unterminated record");
	let found = false;
	for (const record of output.slice(0, -1).split("\0")) {
		const separator = record.indexOf("\t");
		if (separator < 1 || separator === record.length - 1) {
			throw new Error("git ls-files returned an invalid stage record");
		}
		const fields = record.slice(0, separator).split(" ");
		if (
			fields.length !== 3 ||
			!fields[0]?.match(/^[0-7]{6}$/) ||
			!fields[1]?.match(/^[0-9a-f]+$/) ||
			!fields[2]?.match(/^[0-3]$/)
		) {
			throw new Error("git ls-files returned an invalid stage record");
		}
		if (fields[0] === "160000") found = true;
	}
	return found;
}

export function worktreeChanges(
	repository: string,
	path: string,
	branch: string,
): WorktreeChanges {
	const root = git(path, ["rev-parse", "--show-toplevel"]);
	if (root !== path) throw new Error(`${path}: expected a worktree root, found ${root}`);
	if (commonGitDirectory(path) !== commonGitDirectory(repository)) {
		throw new Error(`${path}: does not belong to repository ${repository}`);
	}
	const currentBranch = worktreeBranch(path);
	if (currentBranch !== branch) {
		throw new Error(`${path}: expected branch ${branch}, found ${currentBranch ?? "detached HEAD"}`);
	}
	const changes = parseWorktreeChanges(
		gitRaw(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
	);
	return {
		...changes,
		hasGitlinks: hasGitlinks(gitRaw(path, ["ls-files", "--stage", "-z"])),
	};
}

export function removeWorktree(repository: string, path: string, force: boolean): void {
	git(repository, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}
