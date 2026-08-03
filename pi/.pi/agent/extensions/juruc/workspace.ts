import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
	/** False when Git never produced an exit status, so `code` is not its verdict. */
	ran: boolean;
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
		return { code: 0, stdout, stderr, ran: true };
	} catch (error) {
		const failure = error as Error & {
			code?: number | string;
			killed?: boolean;
			stdout?: string;
			stderr?: string;
		};
		// A spawn failure reports a string errno such as ENOENT, and a killed child never
		// exited; neither is an answer from Git.
		const ran = typeof failure.code === "number" && !failure.killed;
		return {
			code:
				typeof failure.code === "number"
					? failure.code
					: failure.killed
						? 124
						: 1,
			stdout: failure.stdout ?? "",
			// Git's own stderr when it ran; otherwise only the failure itself explains it.
			stderr: ran ? failure.stderr ?? failure.message : failure.stderr || failure.message,
			ran,
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

/** Git's own branch-syntax verdict; an operational failure throws instead of denying. */
export async function validBranchName(
	cwd: string,
	branch: string,
): Promise<boolean> {
	const result = await git(cwd, ["check-ref-format", "--branch", branch]);
	if (!result.ran) throw failure(result, `could not validate branch name ${branch}`);
	return result.code === 0;
}

interface WorktreeRegistration {
	path: string;
	head?: string;
	branch?: string;
	prunable: boolean;
}

async function worktreeRegistrations(sourceRoot: string): Promise<WorktreeRegistration[]> {
	const listed = await git(sourceRoot, ["worktree", "list", "--porcelain", "-z"]);
	if (listed.code !== 0) throw failure(listed, "could not inspect registered worktrees");
	return listed.stdout.split("\0\0").filter(Boolean).map((record) => {
		const fields = record.split("\0").filter(Boolean);
		const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
		if (!path) throw new Error("Git returned an invalid worktree registration");
		return {
			path,
			head: fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length),
			branch: fields.find((field) => field.startsWith("branch "))?.slice("branch ".length),
			prunable: fields.some((field) => field.startsWith("prunable")),
		};
	});
}

async function gitCommonDirectory(cwd: string): Promise<string> {
	const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
	if (common.code !== 0) throw failure(common, "could not resolve the Git common directory");
	return realpathSync(resolve(cwd, common.stdout.trim()));
}

async function requireSourceRepository(repository: TaskRepository): Promise<string> {
	const stat = lstatSync(repository.sourceRoot, { throwIfNoEntry: false });
	if (!stat?.isDirectory() || stat.isSymbolicLink() || realpathSync(repository.sourceRoot) !== repository.sourceRoot)
		throw new Error(`${repository.sourceRoot}: source repository is not an exact directory`);
	const root = await git(repository.sourceRoot, ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0 || realpathSync(root.stdout.trim()) !== repository.sourceRoot)
		throw failure(root, "sourceRoot is not the exact Git repository root");
	const commit = await git(repository.sourceRoot, ["cat-file", "-e", `${repository.sourceHead}^{commit}`]);
	if (commit.code !== 0) throw failure(commit, "sourceHead is unavailable in the source repository");
	return gitCommonDirectory(repository.sourceRoot);
}

async function branchHead(repository: TaskRepository): Promise<string | undefined> {
	const reference = `refs/heads/${repository.branch}`;
	const exists = await git(repository.sourceRoot, ["show-ref", "--verify", "--quiet", reference]);
	if (exists.code === 1) return undefined;
	if (exists.code !== 0) throw failure(exists, `could not inspect task branch ${repository.branch}`);
	const result = await git(repository.sourceRoot, ["rev-parse", "--verify", `${reference}^{commit}`]);
	return objectId(result, `could not resolve task branch ${repository.branch}`);
}

function requireDesiredWorktreeParent(repository: TaskRepository): void {
	const parent = dirname(repository.worktree);
	const stat = lstatSync(parent, { throwIfNoEntry: false });
	if (!stat?.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent)
		throw new Error(`${parent}: desired worktree parent is not an exact directory`);
}

async function inspectActivationWorkspace(
	repository: TaskRepository,
	sourceCommonDirectory?: string,
): Promise<WorkspaceStatus> {
	const common = sourceCommonDirectory ?? await requireSourceRepository(repository);
	const status = await inspectTaskWorktree(repository);
	if (status.head !== repository.sourceHead)
		throw new Error("managed worktree HEAD differs from activation sourceHead");
	if (status.paths.length)
		throw new Error(`managed worktree has pending candidate paths: ${status.paths.join(", ")}`);
	if (await gitCommonDirectory(repository.worktree) !== common)
		throw new Error("managed worktree belongs to a different Git common directory");
	const registration = (await worktreeRegistrations(repository.sourceRoot))
		.find(({ path }) => path === repository.worktree);
	if (
		!registration ||
		registration.head !== repository.sourceHead ||
		registration.branch !== `refs/heads/${repository.branch}`
	) throw new Error("managed worktree registration differs from task.json");
	return status;
}

export async function ensureTaskWorktree(repository: TaskRepository): Promise<void> {
	const sourceCommonDirectory = await requireSourceRepository(repository);
	if (!(await validBranchName(repository.sourceRoot, repository.branch)))
		throw new Error(`${repository.branch}: invalid Git branch name`);
	if (repository.worktree === repository.sourceRoot)
		throw new Error("task worktree must differ from sourceRoot");
	if (lstatSync(repository.worktree, { throwIfNoEntry: false })?.isSymbolicLink())
		throw new Error(`${repository.worktree}: desired worktree path is a symlink`);
	const registrations = await worktreeRegistrations(repository.sourceRoot);
	const exact = registrations.find(({ path }) => path === repository.worktree);
	const branchRef = `refs/heads/${repository.branch}`;
	const elsewhere = registrations.find(
		({ path, branch }) => branch === branchRef && path !== repository.worktree,
	);
	if (elsewhere)
		throw new Error(`task branch is already checked out at ${elsewhere.path}`);

	const present = lstatSync(repository.worktree, { throwIfNoEntry: false });
	if (present) {
		if (!present.isDirectory() || present.isSymbolicLink())
			throw new Error(`${repository.worktree}: desired worktree path is not a regular directory`);
		if (!exact) throw new Error(`${repository.worktree}: occupied path is not the managed worktree`);
		await inspectActivationWorkspace(repository, sourceCommonDirectory);
		return;
	}
	if (exact) {
		if (exact.head !== repository.sourceHead || exact.branch !== branchRef)
			throw new Error("stale worktree registration differs from task.json");
		if (!exact.prunable)
			throw new Error("missing worktree registration is not safely prunable");
		const otherPrunable = registrations.find(
			({ path, prunable }) => path !== repository.worktree && prunable,
		);
		if (otherPrunable)
			throw new Error(`refusing to prune unrelated stale worktree ${otherPrunable.path}`);
		const pruned = await git(
			repository.sourceRoot,
			["worktree", "prune", "--expire", "now"],
			GIT_WRITE_TIMEOUT_MS,
		);
		if (pruned.code !== 0) throw failure(pruned, "could not prune stale worktree registration");
		if ((await worktreeRegistrations(repository.sourceRoot)).some(({ path }) => path === repository.worktree))
			throw new Error("stale worktree registration could not be pruned");
	}

	requireDesiredWorktreeParent(repository);
	const existingHead = await branchHead(repository);
	if (existingHead && existingHead !== repository.sourceHead)
		throw new Error("existing task branch does not point to sourceHead");
	const args = existingHead
		? ["worktree", "add", repository.worktree, repository.branch]
		: ["worktree", "add", "-b", repository.branch, repository.worktree, repository.sourceHead];
	const added = await git(repository.sourceRoot, args, GIT_WRITE_TIMEOUT_MS);
	if (added.code !== 0) throw failure(added, `could not prepare task worktree ${repository.worktree}`);
	await inspectActivationWorkspace(repository, sourceCommonDirectory);
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
	if (await gitCommonDirectory(repository.worktree) !== await gitCommonDirectory(repository.sourceRoot))
		throw new Error("managed worktree belongs to a different source repository");
	return status;
}

function exactDirectory(path: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	return Boolean(stat?.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path);
}

interface LocalFileSnapshot {
	bytes: Buffer;
	mode: number;
}

interface LocalFileCopy {
	destination: string;
	bytes: Buffer;
	mode: number;
	previous?: LocalFileSnapshot;
}

function preflightLocalFile(source: string, destination: string): LocalFileCopy {
	const sourceStat = lstatSync(source, { throwIfNoEntry: false });
	if (!sourceStat?.isFile() || sourceStat.isSymbolicLink())
		throw new Error(`${source}: approved local source is not a regular file`);
	const destinationStat = lstatSync(destination, { throwIfNoEntry: false });
	if (destinationStat && (!destinationStat.isFile() || destinationStat.isSymbolicLink()))
		throw new Error(`${destination}: approved local destination is not a regular file`);
	return {
		destination,
		bytes: readFileSync(source),
		mode: sourceStat.mode & 0o7777,
		previous: destinationStat
			? { bytes: readFileSync(destination), mode: destinationStat.mode & 0o7777 }
			: undefined,
	};
}

function syncDirectory(path: string): void {
	const directory = openSync(path, "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function replaceLocalFile(destination: string, bytes: Buffer, mode: number): void {
	const temporary = join(
		dirname(destination),
		`.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		const file = openSync(temporary, "wx", mode);
		try {
			writeFileSync(file, bytes);
			fchmodSync(file, mode);
			fsyncSync(file);
		} finally {
			closeSync(file);
		}
		renameSync(temporary, destination);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

function rollbackLocalFiles(
	copies: readonly LocalFileCopy[],
	createdClaudeDirectory: string | undefined,
): unknown[] {
	const failures: unknown[] = [];
	const directories = new Set(copies.map(({ destination }) => dirname(destination)));
	for (const copy of copies.toReversed()) {
		try {
			if (copy.previous)
				replaceLocalFile(copy.destination, copy.previous.bytes, copy.previous.mode);
			else if (lstatSync(copy.destination, { throwIfNoEntry: false }))
				unlinkSync(copy.destination);
		} catch (error) {
			failures.push(error);
		}
	}
	for (const directory of directories) {
		try {
			syncDirectory(directory);
		} catch (error) {
			failures.push(error);
		}
	}
	if (createdClaudeDirectory) {
		try {
			rmdirSync(createdClaudeDirectory);
		} catch (error) {
			failures.push(error);
		}
		try {
			syncDirectory(dirname(createdClaudeDirectory));
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
}

export async function copyTaskLocalFiles(repository: TaskRepository): Promise<void> {
	const sourceCommonDirectory = await requireSourceRepository(repository);
	await inspectActivationWorkspace(repository, sourceCommonDirectory);
	const copies: LocalFileCopy[] = [];
	for (const entry of readdirSync(repository.sourceRoot, { withFileTypes: true })) {
		if (!entry.name.startsWith(".env")) continue;
		if (entry.isDirectory() && !entry.isSymbolicLink()) continue;
		copies.push(preflightLocalFile(
			join(repository.sourceRoot, entry.name),
			join(repository.worktree, entry.name),
		));
	}

	const claudeLocal = join(repository.sourceRoot, "CLAUDE.local.md");
	if (lstatSync(claudeLocal, { throwIfNoEntry: false }))
		copies.push(preflightLocalFile(claudeLocal, join(repository.worktree, "CLAUDE.local.md")));

	const sourceClaude = join(repository.sourceRoot, ".claude");
	const sourceSettings = join(sourceClaude, "settings.local.json");
	const destinationClaude = join(repository.worktree, ".claude");
	let createClaudeDirectory = false;
	if (lstatSync(sourceSettings, { throwIfNoEntry: false })) {
		if (!exactDirectory(sourceClaude))
			throw new Error(`${sourceClaude}: approved local source directory is not exact`);
		const destinationClaudeStat = lstatSync(destinationClaude, { throwIfNoEntry: false });
		createClaudeDirectory = !destinationClaudeStat;
		if (destinationClaudeStat && !exactDirectory(destinationClaude))
			throw new Error(`${destinationClaude}: approved local destination directory is not exact`);
		copies.push(preflightLocalFile(
			sourceSettings,
			join(destinationClaude, "settings.local.json"),
		));
	}

	let createdClaudeDirectory: string | undefined;
	try {
		if (createClaudeDirectory) {
			mkdirSync(destinationClaude, { mode: 0o700 });
			createdClaudeDirectory = destinationClaude;
		}
		for (const copy of copies)
			replaceLocalFile(copy.destination, copy.bytes, copy.mode);
		const affectedDirectories = new Set(copies.map(({ destination }) => dirname(destination)));
		if (createdClaudeDirectory) affectedDirectories.add(repository.worktree);
		for (const directory of affectedDirectories)
			syncDirectory(directory);
		await inspectActivationWorkspace(repository, sourceCommonDirectory);
	} catch (error) {
		const rollbackFailures = rollbackLocalFiles(copies, createdClaudeDirectory);
		if (rollbackFailures.length)
			throw new AggregateError([error, ...rollbackFailures], "local-file copy and rollback failed");
		throw error;
	}
}

export async function hasTaskWorktreeRegistration(repository: TaskRepository): Promise<boolean> {
	return (await worktreeRegistrations(repository.sourceRoot))
		.some(({ path }) => path === repository.worktree);
}

export async function removeTaskWorktree(
	repository: TaskRepository,
): Promise<boolean> {
	const registration = (await worktreeRegistrations(repository.sourceRoot))
		.find(({ path }) => path === repository.worktree);
	if (!registration) return false;
	if (registration.branch !== `refs/heads/${repository.branch}`)
		throw new Error("refusing to remove a worktree registration for another branch");
	const present = lstatSync(repository.worktree, { throwIfNoEntry: false });
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

export async function recoverUnrecordedTaskCommits(
	repository: TaskRepository,
	expectedHead: string,
): Promise<boolean> {
	const status = await inspectTaskWorktree(repository);
	if (status.head === expectedHead) return false;
	const ancestor = await git(repository.worktree, [
		"merge-base",
		"--is-ancestor",
		expectedHead,
		status.head,
	]);
	if (ancestor.code === 1)
		throw new Error("managed worktree HEAD diverged from recorded task history");
	if (ancestor.code !== 0)
		throw failure(ancestor, "could not compare managed worktree HEAD with recorded task history");
	const reset = await git(
		repository.worktree,
		["reset", "--mixed", "--quiet", expectedHead],
		GIT_WRITE_TIMEOUT_MS,
	);
	if (reset.code !== 0)
		throw failure(reset, "could not recover commits absent from task.json");
	const recovered = await inspectTaskWorktree(repository);
	if (recovered.head !== expectedHead)
		throw new Error("managed worktree HEAD recovery did not reach recorded task history");
	return true;
}

export async function stageAll(repository: TaskRepository): Promise<string[]> {
	await inspectTaskWorktree(repository);
	const result = await git(repository.worktree, ["add", "-A"], GIT_WRITE_TIMEOUT_MS);
	if (result.code !== 0) throw failure(result, "git add -A failed");
	const staged = await git(repository.worktree, [
		"diff",
		"--no-renames",
		"--cached",
		"--name-only",
		"-z",
		"HEAD",
		"--",
	]);
	if (staged.code !== 0) throw failure(staged, "could not inspect the staged candidate");
	return nulPaths(staged.stdout);
}

export async function stagedPathsMatchingScopes(
	repository: TaskRepository,
	fileScopes: readonly string[],
): Promise<string[]> {
	const matched = await git(repository.worktree, [
		"diff",
		"--no-renames",
		"--cached",
		"--name-only",
		"-z",
		"HEAD",
		"--",
		...fileScopes,
	]);
	if (matched.code !== 0)
		throw failure(matched, "could not match staged paths against phase file scopes");
	return nulPaths(matched.stdout);
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
