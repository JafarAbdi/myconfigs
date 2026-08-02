import { execFile } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runtimePathsForRoot } from "./runtime.ts";
import type { WorktreeSnapshot } from "./plan.ts";
import type { DeletionWorktreeSnapshot, TaskIdentity } from "./state.ts";

const execFileAsync = promisify(execFile);
const GIT_QUERY_MS = 5_000;
const GIT_WRITE_MS = 120_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

export type ConfirmBootstrap = (
	title: string,
	detail: string,
) => Promise<boolean>;
export type Notify = (message: string) => void;

export async function git(
	cwd: string,
	args: string[],
	timeout = GIT_QUERY_MS,
	env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			env: env ? { ...process.env, ...env } : process.env,
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

export async function repositoryEvidence(
	cwd: string,
): Promise<RepositoryEvidence | undefined> {
	const [root, head, branch] = await Promise.all([
		git(cwd, ["rev-parse", "--show-toplevel"]),
		git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
		git(cwd, ["branch", "--show-current"]),
	]);
	if (root.code !== 0 || head.code !== 0 || branch.code !== 0) return undefined;
	const object = head.stdout.trim();
	if (!OBJECT_ID.test(object)) return undefined;
	try {
		return {
			root: realpathSync(root.stdout.trim()),
			head: object,
			branch: branch.stdout.trim(),
		};
	} catch {
		return undefined;
	}
}

async function indexClean(root: string): Promise<boolean> {
	const result = await git(root, ["diff", "--cached", "--quiet", "--"]);
	if (result.code > 1) throw new Error("could not inspect the Git index");
	return result.code === 0;
}

async function worktreeClean(root: string): Promise<boolean> {
	const [unstaged, untracked] = await Promise.all([
		git(root, ["diff", "--quiet", "--"]),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	if (unstaged.code > 1 || untracked.code !== 0)
		throw new Error("could not inspect the Git worktree");
	return unstaged.code === 0 && untracked.stdout.length === 0;
}

export async function repositoryClean(root: string): Promise<boolean> {
	return (await indexClean(root)) && (await worktreeClean(root));
}

export async function prepareInitialRepository(
	cwd: string,
	confirm: ConfirmBootstrap,
	notify: Notify = () => {},
): Promise<RepositoryEvidence | undefined> {
	const existing = await repositoryEvidence(cwd);
	if (existing) {
		if (!existing.branch)
			throw new Error(
				"JURUC requires a named base branch; detached HEAD is unsupported",
			);
		if (!(await repositoryClean(existing.root)))
			notify(
				"existing checkout changes are excluded; the JURUC worktree starts from committed HEAD",
			);
		return existing;
	}

	const topLevel = await git(cwd, ["rev-parse", "--show-toplevel"]);
	let kind: "absent" | "unborn";
	let root: string;
	if (topLevel.code === 0) {
		const [branch, head] = await Promise.all([
			git(cwd, ["branch", "--show-current"]),
			git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
		]);
		if (branch.code !== 0 || head.code === 0)
			throw new Error(
				branch.stderr.trim() ||
					"Git repository evidence could not be read consistently",
			);
		kind = "unborn";
		root = realpathSync(topLevel.stdout.trim());
	} else {
		const detail = topLevel.stderr.trim();
		if (detail && !/not a git repository/i.test(detail))
			throw new Error(detail);
		kind = "absent";
		root = realpathSync(cwd);
	}

	const action =
		kind === "absent"
			? `Run git init in ${root}, git add -A, and create the root commit "Initialize repository".`
			: `Run git add -A and create the root commit "Initialize repository" in ${root}.`;
	if (
		!(await confirm(
			"Initialize Git and commit the local baseline?",
			`${action} Every current non-ignored file will be committed. Nothing will be pushed.`,
		))
	)
		return undefined;

	if (kind === "absent") {
		const initialized = await git(root, ["init"], GIT_WRITE_MS);
		if (initialized.code !== 0)
			throw new Error(
				initialized.stderr.trim() || `git init failed in ${root}`,
			);
	}
	if (await repositoryEvidence(root))
		throw new Error(
			"Git HEAD appeared while initialization was awaiting confirmation; retry /juruc",
		);
	const added = await git(root, ["add", "-A"], GIT_WRITE_MS);
	if (added.code !== 0)
		throw new Error(added.stderr.trim() || `git add -A failed in ${root}`);
	const committed = await git(
		root,
		[
			"-c",
			"core.hooksPath=",
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"--no-verify",
			"-m",
			"Initialize repository",
		],
		GIT_WRITE_MS,
	);
	if (committed.code !== 0)
		throw new Error(
			committed.stderr.trim() ||
				`could not create the initial baseline commit in ${root}`,
		);
	const initialized = await repositoryEvidence(root);
	if (!initialized?.branch)
		throw new Error(
			`Git initialized in ${root}, but a named HEAD could not be verified`,
		);
	const [parents, subject] = await Promise.all([
		git(root, ["rev-list", "--parents", "-n", "1", initialized.head]),
		git(root, ["log", "-1", "--format=%s", initialized.head]),
	]);
	if (
		parents.code !== 0 ||
		parents.stdout.trim().split(/\s+/).length !== 1 ||
		subject.code !== 0 ||
		subject.stdout.trim() !== "Initialize repository" ||
		!(await repositoryClean(root))
	)
		throw new Error(
			"Git initialization did not produce the expected clean root commit",
		);
	return initialized;
}

export async function validBranchName(
	cwd: string,
	branch: string,
): Promise<boolean> {
	return (await git(cwd, ["check-ref-format", "--branch", branch])).code === 0;
}

export async function branchHead(
	branch: string,
	cwd: string,
): Promise<string | undefined> {
	const result = await git(cwd, [
		"rev-parse",
		"--verify",
		`refs/heads/${branch}^{commit}`,
	]);
	const head = result.stdout.trim();
	return result.code === 0 && OBJECT_ID.test(head) ? head : undefined;
}

export interface WorktreeRecord {
	worktree: string;
	branch?: string;
	detached: boolean;
}

/** Parse Git's NUL-delimited porcelain records without treating paths as lines. */
export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let fields: string[] = [];
	const finish = (): void => {
		if (fields.length === 0) return;
		const worktree = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
		const head = fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length);
		const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length);
		const detached = fields.includes("detached") || fields.includes("bare");
		const known = fields.every((field) =>
			field.startsWith("worktree ") || field.startsWith("HEAD ") ||
			field.startsWith("branch ") || field === "detached" || field === "bare" ||
			field === "locked" || field.startsWith("prunable ") || field.startsWith("reason "),
		);
		if (!known || !worktree || !head || (branch === undefined && !detached) ||
			(branch !== undefined && !/^refs\/heads\/[^\0]+$/.test(branch)))
			throw new Error("Git worktree list output is malformed");
		records.push({ worktree, branch, detached });
		fields = [];
	};
	for (const field of output.split("\0")) {
		if (field === "") finish();
		else fields.push(field);
	}
	finish();
	if (records.length === 0) throw new Error("Git worktree list output is malformed");
	return records;
}

export async function worktreeForBranch(
	branch: string,
	cwd: string,
): Promise<string | undefined> {
	const result = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
	if (result.code !== 0)
		throw new Error(
			result.stderr.trim() || "Git worktree list could not be inspected",
		);
	const match = parseWorktreePorcelain(result.stdout).find(
		(entry) => entry.branch === `refs/heads/${branch}`,
	);
	return match?.worktree;
}

function requireWorktreeRuntime(worktree: string, slug: string): void {
	const paths = runtimePathsForRoot(dirname(dirname(worktree)));
	if (worktree !== join(paths.worktrees, slug))
		throw new Error(`${worktree} is outside the exact JURUC worktree path`);
}

export async function assertTaskBranchAvailable(
	sourceRoot: string,
	branch: string,
	worktree: string,
): Promise<void> {
	requireWorktreeRuntime(worktree, branch);
	if (
		(await branchHead(branch, sourceRoot)) ||
		existsSync(worktree) ||
		(await worktreeForBranch(branch, sourceRoot))
	)
		throw new Error(`branch ${branch} or worktree ${worktree} already exists`);
}

async function commonGitDirectory(cwd: string): Promise<string> {
	const result = await git(cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (result.code !== 0)
		throw new Error(
			result.stderr.trim() || "Git common directory could not be resolved",
		);
	return realpathSync(result.stdout.trim());
}

async function validateSource(identity: TaskIdentity): Promise<void> {
	let sourceRoot: string;
	try {
		sourceRoot = realpathSync(identity.sourceRoot);
	} catch {
		throw new Error(`source repository ${identity.sourceRoot} is absent`);
	}
	const source = await repositoryEvidence(identity.sourceRoot);
	if (
		!source ||
		source.root !== identity.sourceRoot ||
		sourceRoot !== identity.sourceRoot
	)
		throw new Error(
			`source repository root is not exactly ${identity.sourceRoot}`,
		);
	if (!(await branchHead(identity.baseBranch, identity.sourceRoot)))
		throw new Error(`named base branch ${identity.baseBranch} is missing`);
	const sourceCommit = await git(identity.sourceRoot, [
		"cat-file",
		"-e",
		`${identity.sourceHead}^{commit}`,
	]);
	if (sourceCommit.code !== 0)
		throw new Error(
			`persisted source commit ${identity.sourceHead} is missing`,
		);
}

export async function validateManagedWorktree(
	identity: TaskIdentity,
	checkSource = true,
): Promise<RepositoryEvidence> {
	requireWorktreeRuntime(identity.worktree, identity.slug);
	if (checkSource) await validateSource(identity);
	let canonical: string;
	try {
		canonical = realpathSync(identity.worktree);
	} catch {
		throw new Error(`exact worktree ${identity.worktree} is absent`);
	}
	const repository = await repositoryEvidence(identity.worktree);
	if (
		!repository ||
		canonical !== identity.worktree ||
		repository.root !== identity.worktree
	)
		throw new Error(`worktree root is not exactly ${identity.worktree}`);
	if (repository.branch !== identity.branch)
		throw new Error(
			`expected branch ${identity.branch}, found ${repository.branch || "<detached>"}`,
		);
	if (!lstatSync(`${identity.worktree}/.git`).isFile())
		throw new Error(`${identity.worktree} is not a linked Git worktree`);
	const registered = await worktreeForBranch(
		identity.branch,
		identity.sourceRoot,
	);
	if (registered !== identity.worktree)
		throw new Error(
			`branch ${identity.branch} is registered at ${registered ?? "<none>"}, not ${identity.worktree}`,
		);
	if (
		(await commonGitDirectory(identity.sourceRoot)) !==
		(await commonGitDirectory(identity.worktree))
	)
		throw new Error(
			"managed worktree does not belong to the persisted source repository",
		);
	return repository;
}

export async function ensureManagedWorktree(
	identity: TaskIdentity,
): Promise<void> {
	requireWorktreeRuntime(identity.worktree, identity.slug);
	await validateSource(identity);
	const branch = await branchHead(identity.branch, identity.sourceRoot);
	const registered = await worktreeForBranch(
		identity.branch,
		identity.sourceRoot,
	);
	if (registered && registered !== identity.worktree)
		throw new Error(
			`branch ${identity.branch} worktree is at ${registered}, not ${identity.worktree}`,
		);
	if (existsSync(identity.worktree) && !registered)
		throw new Error(
			`${identity.worktree} exists but is not registered as the managed worktree`,
		);
	if (branch && branch !== identity.sourceHead)
		throw new Error(
			`branch ${identity.branch} starts at ${branch}, expected ${identity.sourceHead}`,
		);
	if (!registered) {
		const args = branch
			? ["worktree", "add", identity.worktree, identity.branch]
			: [
					"worktree",
					"add",
					"-b",
					identity.branch,
					identity.worktree,
					identity.sourceHead,
				];
		const result = await git(identity.sourceRoot, args, GIT_WRITE_MS);
		if (result.code !== 0)
			throw new Error(result.stderr.trim() || "git worktree add failed");
	}
	const created = await validateManagedWorktree(identity);
	if (created.head !== identity.sourceHead)
		throw new Error(
			`new task branch starts at ${created.head}, expected ${identity.sourceHead}`,
		);
	if (!(await repositoryClean(identity.worktree)))
		throw new Error(`new managed worktree ${identity.worktree} is dirty`);
}

async function changedSubmoduleStatuses(
	root: string,
	includeIgnored: boolean,
	untrackedFiles: "all" | "normal",
): Promise<{ path: string; status: string; paths: string[] }[]> {
	const discovered = await git(root, [
		"submodule",
		"foreach",
		"--quiet",
		"--recursive",
		"printf '%s\\0' \"$displaypath\"",
	]);
	if (discovered.code !== 0)
		throw new Error(
			discovered.stderr.trim() ||
				"initialized submodules could not be inspected",
		);
	const statuses: { path: string; status: string; paths: string[] }[] = [];
	for (const path of discovered.stdout.split("\0").filter(Boolean)) {
		const exact = untrackedFiles === "all";
		const args = [
			"status",
			"--porcelain=v1",
			"--no-renames",
			`--untracked-files=${untrackedFiles}`,
		];
		if (exact) args.push("-z");
		if (includeIgnored) args.push("--ignored");
		const result = await git(join(root, path), args);
		if (result.code !== 0)
			throw new Error(
				result.stderr.trim() ||
					`submodule ${path} status could not be inspected`,
			);
		const status = result.stdout.trimEnd();
		if (status) statuses.push({
			path,
			status,
			paths: exact
				? result.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3))
				: [],
		});
	}
	return statuses;
}

async function deletionPaths(root: string): Promise<string[]> {
	const [status, submodules] = await Promise.all([
		git(root, [
			"status",
			"--porcelain=v1",
			"--no-renames",
			"-z",
			"--untracked-files=all",
			"--ignored",
		]),
		changedSubmoduleStatuses(root, true, "all"),
	]);
	if (status.code !== 0)
		throw new Error("could not inspect managed worktree paths");
	return [
		...new Set([
			...status.stdout
				.split("\0")
				.filter(Boolean)
				.map((entry) => entry.slice(3)),
			...submodules.flatMap(({ path, paths }) => [
				path,
				...paths.map((nested) => `${path}/${nested}`),
			]),
		]),
	].sort();
}

async function worktreeTree(root: string): Promise<{ tree: string; paths: string[] }> {
	const dirtySubmodules = await changedSubmoduleStatuses(root, false, "all");
	if (dirtySubmodules.length) {
		throw new Error(
			`dirty submodule worktrees are not representable: ${dirtySubmodules.map(({ path }) => path).join(", ")}`,
		);
	}
	const temporary = mkdtempSync(join(tmpdir(), "juruc-index-"));
	const env = { GIT_INDEX_FILE: join(temporary, "index") };
	try {
		for (const args of [["read-tree", "HEAD"], ["add", "-A"]]) {
			const result = await git(root, args, GIT_WRITE_MS, env);
			if (result.code !== 0)
				throw new Error(result.stderr.trim() || `git ${args[0]} failed while capturing the worktree`);
		}
		const written = await git(root, ["write-tree"], GIT_WRITE_MS, env);
		const tree = written.stdout.trim();
		if (written.code !== 0 || !OBJECT_ID.test(tree))
			throw new Error(written.stderr.trim() || "Git could not write the worktree tree");
		const changed = await git(root, [
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			"HEAD",
			tree,
			"--",
		]);
		if (changed.code !== 0)
			throw new Error(changed.stderr.trim() || "Git could not inspect the worktree tree");
		return { tree, paths: changed.stdout.split("\0").filter(Boolean).sort() };
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export type ManagedWorktreeSnapshot =
	| { kind: "absent" }
	| ({ kind: "present" } & WorktreeSnapshot);

export async function managedWorktreeSnapshot(
	identity: TaskIdentity,
	checkSource = true,
): Promise<ManagedWorktreeSnapshot> {
	requireWorktreeRuntime(identity.worktree, identity.slug);
	if (!existsSync(identity.worktree)) return { kind: "absent" };
	const repository = await validateManagedWorktree(identity, checkSource);
	const { tree, paths } = await worktreeTree(identity.worktree);
	return { kind: "present", head: repository.head, paths, tree };
}

export async function managedDeletionWorktreeSnapshot(
	identity: TaskIdentity,
): Promise<DeletionWorktreeSnapshot> {
	requireWorktreeRuntime(identity.worktree, identity.slug);
	if (!existsSync(identity.worktree)) return { kind: "absent" };
	const repository = await validateManagedWorktree(identity);
	return {
		kind: "present",
		head: repository.head,
		paths: await deletionPaths(identity.worktree),
	};
}

export async function discardCapturedWork(
	identity: TaskIdentity,
	expected: WorktreeSnapshot,
): Promise<WorktreeSnapshot> {
	const before = await managedWorktreeSnapshot(identity);
	if (before.kind === "absent") throw new Error("managed worktree is absent");
	if (
		before.head !== expected.head ||
		before.tree !== expected.tree ||
		before.paths.length !== expected.paths.length ||
		before.paths.some((path, index) => path !== expected.paths[index])
	) throw new Error("discard worktree changed after confirmation");
	const { head, paths } = expected;
	if (paths.length === 0)
		throw new Error("discard transaction has no captured paths");

	for (const path of paths) {
		const absolute = join(identity.worktree, path);
		const reset = await git(identity.worktree, [
			"reset",
			"--quiet",
			head,
			"--",
			path,
		]);
		if (reset.code !== 0)
			throw new Error(reset.stderr.trim() || `could not reset captured path ${path}`);
		const tracked = await git(identity.worktree, ["ls-tree", "-z", head, "--", path]);
		if (tracked.code !== 0)
			throw new Error(tracked.stderr.trim() || `could not inspect captured path ${path}`);
		const entry = /^(\d+)\s+\w+\s+([0-9a-f]+)\t/u.exec(tracked.stdout);
		if (!entry) {
			rmSync(absolute, { recursive: true, force: true });
			continue;
		}
		if (entry[1] === "160000") {
			const resetSubmodule = await git(absolute, ["reset", "--hard", entry[2]]);
			const cleanSubmodule = await git(absolute, ["clean", "-fd"]);
			if (resetSubmodule.code !== 0 || cleanSubmodule.code !== 0)
				throw new Error(
					resetSubmodule.stderr.trim() ||
						cleanSubmodule.stderr.trim() ||
						`could not discard captured submodule ${path}`,
				);
			continue;
		}
		const restore = await git(identity.worktree, ["checkout", head, "--", path]);
		if (restore.code !== 0)
			throw new Error(restore.stderr.trim() || `could not restore captured path ${path}`);
	}

	const after = await managedWorktreeSnapshot(identity);
	if (after.kind === "absent" || after.head !== head || after.paths.length !== 0)
		throw new Error("discard transaction did not reach the clean expected HEAD");
	return after;
}

export async function worktreeStatus(
	identity: TaskIdentity,
): Promise<string | undefined> {
	requireWorktreeRuntime(identity.worktree, identity.slug);
	if (!existsSync(identity.worktree)) return undefined;
	await validateManagedWorktree(identity);
	const [status, submodules] = await Promise.all([
		git(identity.worktree, [
			"status",
			"--short",
			"--ignored",
			"--untracked-files=normal",
		]),
		changedSubmoduleStatuses(identity.worktree, true, "normal"),
	]);
	if (status.code !== 0)
		throw new Error(
			status.stderr.trim() || "Git status could not be inspected",
		);
	return [
		status.stdout.trimEnd(),
		...submodules.flatMap(({ path, status: submoduleStatus }) =>
			submoduleStatus.split("\n").map((line) => `[submodule ${path}] ${line}`),
		),
	]
		.filter(Boolean)
		.join("\n");
}

async function assertManagedWorktreeUnregistered(
	identity: TaskIdentity,
): Promise<void> {
	const registered = await worktreeForBranch(
		identity.branch,
		identity.sourceRoot,
	);
	if (registered)
		throw new Error(
			registered === identity.worktree
				? `branch ${identity.branch} remains registered at ${identity.worktree}`
				: `branch ${identity.branch} worktree is at ${registered}, not ${identity.worktree}`,
		);
}

export async function removeManagedWorktree(
	identity: TaskIdentity,
): Promise<void> {
	requireWorktreeRuntime(identity.worktree, identity.slug);
	if (!existsSync(identity.worktree)) {
		await assertManagedWorktreeUnregistered(identity);
		return;
	}
	await validateManagedWorktree(identity);
	const args = ["worktree", "remove"];
	const dirty = (await deletionPaths(identity.worktree)).length > 0;
	if (dirty) args.push("--force");
	args.push(identity.worktree);
	let removed = await git(identity.sourceRoot, args, GIT_WRITE_MS);
	if (
		removed.code !== 0 &&
		!dirty &&
		/working trees containing submodules cannot be moved or removed/.test(
			removed.stderr,
		)
	) {
		args.splice(2, 0, "--force");
		removed = await git(identity.sourceRoot, args, GIT_WRITE_MS);
	}
	if (removed.code !== 0)
		throw new Error(removed.stderr.trim() || "git worktree remove failed");
	await assertManagedWorktreeUnregistered(identity);
}
