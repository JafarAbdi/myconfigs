import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	commitStaged,
	createTaskWorktree,
	git,
	inspectTaskWorktree,
	prepareRepository,
	recoverUnrecordedTaskCommits,
	removeTaskWorktree,
	repositoryEvidence,
	stageAll,
	unstageAll,
	workspaceStatus,
	type RepositoryEvidence,
} from "./workspace.ts";

function run(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initializeRepository(root: string): RepositoryEvidence {
	mkdirSync(root, { recursive: true });
	run(root, "init", "-b", "main");
	run(root, "config", "user.name", "JURUC Test");
	run(root, "config", "user.email", "juruc@example.invalid");
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	run(root, "add", "-A");
	run(root, "commit", "-m", "baseline");
	return {
		root,
		head: run(root, "rev-parse", "HEAD"),
		branch: "main",
	};
}

async function withGitIdentity<T>(operation: () => Promise<T>): Promise<T> {
	const keys = [
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.GIT_AUTHOR_NAME = "JURUC Test";
	process.env.GIT_AUTHOR_EMAIL = "juruc@example.invalid";
	process.env.GIT_COMMITTER_NAME = "JURUC Test";
	process.env.GIT_COMMITTER_EMAIL = "juruc@example.invalid";
	try {
		return await operation();
	} finally {
		for (const key of keys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("prepareRepository initializes an absent repository after confirmation", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-init-"));
	try {
		writeFileSync(join(root, "local.txt"), "baseline\n");
		const confirmations: string[] = [];
		const repository = await withGitIdentity(() =>
			prepareRepository(root, async (title, detail) => {
				confirmations.push(`${title}\n${detail}`);
				return true;
			}),
		);
		assert.ok(repository);
		assert.equal(repository.root, root);
		assert.equal(run(root, "log", "-1", "--format=%s"), "Initialize repository");
		assert.equal(readFileSync(join(root, "local.txt"), "utf8"), "baseline\n");
		assert.equal((await workspaceStatus(root)).paths.length, 0);
		assert.match(confirmations[0], /Nothing will be pushed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prepareRepository leaves an absent directory untouched when declined", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-decline-"));
	try {
		assert.equal(await prepareRepository(root, async () => false), undefined);
		assert.equal(await repositoryEvidence(root), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prepareRepository creates the first commit in an unborn repository", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-unborn-"));
	try {
		run(root, "init", "-b", "main");
		writeFileSync(join(root, "first.txt"), "first\n");
		const repository = await withGitIdentity(() =>
			prepareRepository(root, async () => true),
		);
		assert.ok(repository);
		assert.equal(repository.branch, "main");
		assert.equal(run(root, "rev-list", "--count", "HEAD"), "1");
		assert.equal((await workspaceStatus(root)).paths.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an existing detached checkout stops instead of being treated as bootstrap", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-detached-"));
	try {
		initializeRepository(root);
		run(root, "checkout", "--detach");
		await assert.rejects(
			prepareRepository(root, async () => true),
			/requires a named base branch/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an existing dirty checkout is reported but its committed HEAD remains the base", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-existing-"));
	try {
		const expected = initializeRepository(root);
		writeFileSync(join(root, "tracked.txt"), "local change\n");
		const notices: string[] = [];
		const repository = await prepareRepository(
			root,
			async () => {
				throw new Error("existing repositories do not require confirmation");
			},
			(message) => notices.push(message),
		);
		assert.deepEqual(repository, expected);
		assert.equal(notices.length, 1);
		assert.match(notices[0], /excluded/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createTaskWorktree creates an isolated named branch from committed HEAD", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-create-"));
	try {
		const source = join(root, "source");
		const repository = initializeRepository(source);
		writeFileSync(join(source, "tracked.txt"), "uncommitted source change\n");
		const worktree = join(root, "worktrees", "task-one");
		mkdirSync(join(root, "worktrees"));
		const identity = await createTaskWorktree(repository, "task-one", worktree);
		assert.equal(identity.worktree, worktree);
		assert.equal((await inspectTaskWorktree(identity)).branch, "task-one");
		assert.equal(readFileSync(join(worktree, "tracked.txt"), "utf8"), "baseline\n");
		assert.equal(run(worktree, "rev-parse", "HEAD"), repository.head);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stage, unstage, and extension-owned commit use the complete candidate", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-commit-"));
	try {
		const source = join(root, "source");
		const repository = initializeRepository(source);
		mkdirSync(join(root, "worktrees"));
		const identity = await createTaskWorktree(
			repository,
			"task-two",
			join(root, "worktrees", "task-two"),
		);
		writeFileSync(join(identity.worktree, "tracked.txt"), "changed\n");
		writeFileSync(join(identity.worktree, "new\nfile.txt"), "new\n");
		assert.deepEqual(await stageAll(identity), ["new\nfile.txt", "tracked.txt"]);
		await unstageAll(identity);
		assert.equal(
			(await git(identity.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"]))
				.code,
			0,
		);
		assert.deepEqual((await workspaceStatus(identity.worktree)).paths, [
			"new\nfile.txt",
			"tracked.txt",
		]);
		await stageAll(identity);
		const commit = await commitStaged(identity, "Implement complete candidate\n\nTested locally.");
		assert.equal(commit, run(identity.worktree, "rev-parse", "HEAD"));
		assert.equal(
			run(identity.worktree, "log", "-1", "--format=%B"),
			"Implement complete candidate\n\nTested locally.",
		);
		assert.deepEqual((await inspectTaskWorktree(identity)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unrecorded descendant commits reset mixed and preserve candidate changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-recover-"));
	try {
		const source = join(root, "source");
		const repository = initializeRepository(source);
		mkdirSync(join(root, "worktrees"));
		const identity = await createTaskWorktree(
			repository,
			"recover-task",
			join(root, "worktrees", "recover-task"),
		);
		writeFileSync(join(identity.worktree, "tracked.txt"), "committed by model\n");
		run(identity.worktree, "add", "-A");
		run(identity.worktree, "commit", "-m", "unrecorded");
		writeFileSync(join(identity.worktree, "new.txt"), "still dirty\n");

		assert.equal(await recoverUnrecordedTaskCommits(identity, repository.head), true);
		assert.equal(run(identity.worktree, "rev-parse", "HEAD"), repository.head);
		assert.equal(readFileSync(join(identity.worktree, "tracked.txt"), "utf8"), "committed by model\n");
		assert.equal(readFileSync(join(identity.worktree, "new.txt"), "utf8"), "still dirty\n");
		assert.deepEqual((await workspaceStatus(identity.worktree)).paths, ["new.txt", "tracked.txt"]);
		assert.equal(await recoverUnrecordedTaskCommits(identity, repository.head), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unrecorded recovery rejects history divergent from the recorded checkpoint", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-diverged-"));
	try {
		const source = join(root, "source");
		const repository = initializeRepository(source);
		mkdirSync(join(root, "worktrees"));
		const identity = await createTaskWorktree(
			repository,
			"diverged-task",
			join(root, "worktrees", "diverged-task"),
		);
		writeFileSync(join(identity.worktree, "tracked.txt"), "recorded\n");
		run(identity.worktree, "add", "-A");
		run(identity.worktree, "commit", "-m", "recorded");
		const recorded = run(identity.worktree, "rev-parse", "HEAD");
		run(identity.worktree, "reset", "--hard", repository.head);
		writeFileSync(join(identity.worktree, "tracked.txt"), "diverged\n");
		run(identity.worktree, "add", "-A");
		run(identity.worktree, "commit", "-m", "diverged");
		await assert.rejects(
			recoverUnrecordedTaskCommits(identity, recorded),
			/diverged from recorded task history/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("task worktree removal discards confirmed dirty work but retains the branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-remove-"));
	try {
		const repository = initializeRepository(root);
		const worktree = join(root, "worktrees", "remove-task");
		const identity = await createTaskWorktree(repository, "remove-task", worktree);
		writeFileSync(join(worktree, "tracked.txt"), "dirty\n");
		assert.equal(await removeTaskWorktree(identity), true);
		assert.equal(existsSync(worktree), false);
		assert.equal(
			(await git(root, ["show-ref", "--verify", "--quiet", "refs/heads/remove-task"])).code,
			0,
		);
		assert.equal(await removeTaskWorktree(identity), false);

		const staleWorktree = join(root, "worktrees", "stale-task");
		const stale = await createTaskWorktree(repository, "stale-task", staleWorktree);
		rmSync(staleWorktree, { recursive: true, force: true });
		assert.equal(await removeTaskWorktree(stale), true);
		assert.equal(
			(await git(root, ["worktree", "list", "--porcelain", "-z"])).stdout.includes(staleWorktree),
			false,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("worktree creation stops when the task branch already exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-fail-"));
	try {
		const source = join(root, "source");
		const repository = initializeRepository(source);
		run(source, "branch", "occupied");
		mkdirSync(join(root, "worktrees"));
		await assert.rejects(
			createTaskWorktree(
				repository,
				"occupied",
				join(root, "worktrees", "occupied"),
			),
			/already exists/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
