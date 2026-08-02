import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { TaskRepository } from "./task.ts";

const execFileAsync = promisify(execFile);
const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_WRITE_TIMEOUT_MS = 120_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_COMMIT_MESSAGE_LENGTH = 10_000;

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RepositoryEvidence {
	root: string;
	head: string;
	branch: string;
}

export interface WorkspaceStatus {
	head: string;
	branch: string;
	paths: string[];
}

export type ConfirmRepositoryBootstrap = (
	title: string,
	detail: string,
) => Promise<boolean>;

export type Notify = (message: string) => void;

export async function git(
	cwd: string,
	args: readonly string[],
	timeout = GIT_READ_TIMEOUT_MS,
): Promise<GitResult> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			timeout,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as Error & {
			code?: number;
			killed?: boolean;
			stdout?: string;
			stderr?: string;
		};
		return {
			code:
				typeof failure.code === "number"
					? failure.code
					: failure.killed
						? 124
						: 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
		};
	}
}

function failure(result: GitResult, fallback: string): Error {
	return new Error(result.stderr.trim() || fallback);
}

function objectId(result: GitResult, fallback: string): string {
	const value = result.stdout.trim();
	if (result.code !== 0 || !OBJECT_ID.test(value)) throw failure(result, fallback);
	return value;
}

function nulPaths(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

export async function repositoryEvidence(
	cwd: string,
): Promise<RepositoryEvidence | undefined> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return undefined;
	const [head, branch] = await Promise.all([
		git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
		git(cwd, ["branch", "--show-current"]),
	]);
	if (head.code !== 0) return undefined;
	if (branch.code !== 0) throw failure(branch, "could not read the Git branch");
	const object = head.stdout.trim();
	if (!OBJECT_ID.test(object))
		throw new Error("Git HEAD did not resolve to a full object ID");
	return {
		root: realpathSync(root.stdout.trim()),
		head: object,
		branch: branch.stdout.trim(),
	};
}

export async function workspaceStatus(root: string): Promise<WorkspaceStatus> {
	const [head, branch, tracked, untracked] = await Promise.all([
		git(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
		git(root, ["branch", "--show-current"]),
		git(root, ["diff", "--name-only", "-z", "HEAD", "--"]),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	if (branch.code !== 0) throw failure(branch, "could not read the Git branch");
	if (tracked.code !== 0) throw failure(tracked, "could not read tracked changes");
	if (untracked.code !== 0) throw failure(untracked, "could not read untracked files");
	return {
		head: objectId(head, "could not read Git HEAD"),
		branch: branch.stdout.trim(),
		paths: [...new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)])].sort(),
	};
}

export async function repositoryClean(root: string): Promise<boolean> {
	return (await workspaceStatus(root)).paths.length === 0;
}

export async function prepareRepository(
	cwd: string,
	confirm: ConfirmRepositoryBootstrap,
	notify: Notify = () => {},
): Promise<RepositoryEvidence | undefined> {
	const existing = await repositoryEvidence(cwd);
	if (existing) {
		if (!existing.branch)
			throw new Error("JURUC requires a named base branch; detached HEAD is unsupported");
		if (!(await repositoryClean(existing.root)))
			notify(
				"existing checkout changes are excluded; the JURUC worktree starts from committed HEAD",
			);
		return existing;
	}

	const topLevel = await git(cwd, ["rev-parse", "--show-toplevel"]);
	const absent = topLevel.code !== 0;
	if (absent && topLevel.stderr && !/not a git repository/iu.test(topLevel.stderr))
		throw failure(topLevel, "could not inspect the current directory");
	const root = absent ? realpathSync(cwd) : realpathSync(topLevel.stdout.trim());
	if (!absent) {
		const branch = await git(root, ["branch", "--show-current"]);
		if (branch.code !== 0 || !branch.stdout.trim())
			throw failure(branch, "unborn repository has no named branch");
	}
	const action = absent
		? `Run git init in ${root}, stage the current files, and create the root commit "Initialize repository".`
		: `Stage the current files and create the root commit "Initialize repository" in ${root}.`;
	if (
		!(await confirm(
			"Initialize Git and commit the local baseline?",
			`${action} Nothing will be pushed.`,
		))
	)
		return undefined;

	if (absent) {
		const initialized = await git(root, ["init"], GIT_WRITE_TIMEOUT_MS);
		if (initialized.code !== 0) throw failure(initialized, `git init failed in ${root}`);
	}
	const added = await git(root, ["add", "-A"], GIT_WRITE_TIMEOUT_MS);
	if (added.code !== 0) throw failure(added, `git add -A failed in ${root}`);
	const committed = await git(
		root,
		[
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"--no-verify",
			"-m",
			"Initialize repository",
		],
		GIT_WRITE_TIMEOUT_MS,
	);
	if (committed.code !== 0)
		throw failure(committed, `could not create the initial baseline commit in ${root}`);
	const repository = await repositoryEvidence(root);
	if (!repository?.branch)
		throw new Error(`Git initialized in ${root}, but a named HEAD is unavailable`);
	if (!(await repositoryClean(root)))
		throw new Error(`Git initialized in ${root}, but the baseline is not clean`);
	return repository;
}

export async function validBranchName(
	cwd: string,
	branch: string,
): Promise<boolean> {
	return (await git(cwd, ["check-ref-format", "--branch", branch])).code === 0;
}

export async function createTaskWorktree(
	repository: RepositoryEvidence,
	branch: string,
	worktree: string,
): Promise<TaskRepository> {
	if (!(await validBranchName(repository.root, branch)))
		throw new Error(`${branch}: invalid Git branch name`);
	if (lstatSync(worktree, { throwIfNoEntry: false }))
		throw new Error(`${worktree}: task worktree already exists`);
	const existingBranch = await git(repository.root, [
		"show-ref",
		"--verify",
		"--quiet",
		`refs/heads/${branch}`,
	]);
	if (existingBranch.code === 0) throw new Error(`${branch}: task branch already exists`);
	if (existingBranch.code !== 1)
		throw failure(existingBranch, `could not inspect task branch ${branch}`);

	const added = await git(
		repository.root,
		["worktree", "add", "-b", branch, worktree, repository.head],
		GIT_WRITE_TIMEOUT_MS,
	);
	if (added.code !== 0) throw failure(added, `could not create task worktree ${worktree}`);
	const identity: TaskRepository = {
		sourceRoot: repository.root,
		baseBranch: repository.branch,
		sourceHead: repository.head,
		branch,
		worktree: realpathSync(worktree),
	};
	await inspectTaskWorktree(identity);
	return identity;
}

export async function inspectTaskWorktree(
	repository: TaskRepository,
): Promise<WorkspaceStatus> {
	const stat = lstatSync(repository.worktree, { throwIfNoEntry: false });
	if (!stat?.isDirectory() || stat.isSymbolicLink())
		throw new Error(`${repository.worktree}: managed worktree is unavailable`);
	const root = await git(repository.worktree, ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) throw failure(root, "managed worktree is not a Git checkout");
	if (realpathSync(root.stdout.trim()) !== realpathSync(repository.worktree))
		throw new Error("managed worktree root differs from task.json");
	const status = await workspaceStatus(repository.worktree);
	if (status.branch !== repository.branch)
		throw new Error("managed worktree branch differs from task.json");
	return status;
}

export async function removeTaskWorktree(
	repository: TaskRepository,
): Promise<boolean> {
	const listed = await git(repository.sourceRoot, ["worktree", "list", "--porcelain", "-z"]);
	if (listed.code !== 0) throw failure(listed, "could not inspect registered worktrees");
	const registered = listed.stdout
		.split("\0")
		.includes(`worktree ${repository.worktree}`);
	const present = lstatSync(repository.worktree, { throwIfNoEntry: false });
	if (!registered) {
		if (present) throw new Error(`${repository.worktree}: path exists but is not a registered worktree`);
		return false;
	}
	if (present) await inspectTaskWorktree(repository);
	const removed = await git(
		repository.sourceRoot,
		["worktree", "remove", "--force", repository.worktree],
		GIT_WRITE_TIMEOUT_MS,
	);
	if (removed.code !== 0)
		throw failure(removed, `could not remove task worktree ${repository.worktree}`);
	if (lstatSync(repository.worktree, { throwIfNoEntry: false }))
		throw new Error(`${repository.worktree}: Git reported removal but the worktree remains`);
	return true;
}

export async function stageAll(repository: TaskRepository): Promise<string[]> {
	await inspectTaskWorktree(repository);
	const result = await git(repository.worktree, ["add", "-A"], GIT_WRITE_TIMEOUT_MS);
	if (result.code !== 0) throw failure(result, "git add -A failed");
	const staged = await git(repository.worktree, [
		"diff",
		"--cached",
		"--name-only",
		"-z",
		"HEAD",
		"--",
	]);
	if (staged.code !== 0) throw failure(staged, "could not inspect the staged candidate");
	return nulPaths(staged.stdout);
}

export async function unstageAll(repository: TaskRepository): Promise<void> {
	const result = await git(
		repository.worktree,
		["reset", "--mixed", "--quiet", "HEAD"],
		GIT_WRITE_TIMEOUT_MS,
	);
	if (result.code !== 0) throw failure(result, "could not unstage the candidate");
}

export async function commitStaged(
	repository: TaskRepository,
	message: string,
): Promise<string> {
	if (!message.trim() || message.length > MAX_COMMIT_MESSAGE_LENGTH || message.includes("\0"))
		throw new Error("commit message is empty, invalid, or too long");
	await inspectTaskWorktree(repository);
	const pending = await git(repository.worktree, [
		"diff",
		"--cached",
		"--quiet",
		"HEAD",
		"--",
	]);
	if (pending.code === 0) throw new Error("cannot commit an empty staged candidate");
	if (pending.code !== 1) throw failure(pending, "could not inspect the staged candidate");
	const committed = await git(
		repository.worktree,
		[
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--cleanup=verbatim",
			"--no-gpg-sign",
			"--no-verify",
			"-m",
			message,
		],
		GIT_WRITE_TIMEOUT_MS,
	);
	if (committed.code !== 0) throw failure(committed, "git commit failed");
	const status = await inspectTaskWorktree(repository);
	if (status.paths.length)
		throw new Error("git commit succeeded but the managed worktree is not clean");
	return status.head;
}
