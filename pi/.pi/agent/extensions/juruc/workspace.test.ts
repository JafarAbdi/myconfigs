import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TaskRepository } from "./task.ts";
import {
	commitStaged,
	copyTaskLocalFiles,
	ensureTaskWorktree,
	git,
	hasTaskWorktreeRegistration,
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
		root: realpathSync(root),
		head: run(root, "rev-parse", "HEAD"),
		branch: "main",
	};
}

function descriptor(
	repository: RepositoryEvidence,
	root: string,
	branch = "task",
): TaskRepository {
	return {
		sourceRoot: repository.root,
		baseBranch: repository.branch,
		sourceHead: repository.head,
		branch,
		worktree: join(root, "worktrees", branch),
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
		const repository = await withGitIdentity(() => prepareRepository(root, async () => true));
		assert.ok(repository);
		assert.equal(repository.branch, "main");
		assert.equal(run(root, "rev-list", "--count", "HEAD"), "1");
		assert.equal((await workspaceStatus(root)).paths.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("existing detached and dirty source checkouts retain existing preparation behavior", async () => {
	const detached = mkdtempSync(join(tmpdir(), "juruc-workspace-detached-"));
	const dirty = mkdtempSync(join(tmpdir(), "juruc-workspace-dirty-"));
	try {
		initializeRepository(detached);
		run(detached, "checkout", "--detach");
		await assert.rejects(prepareRepository(detached, async () => true), /requires a named base branch/);

		const expected = initializeRepository(dirty);
		writeFileSync(join(dirty, "tracked.txt"), "local change\n");
		const notices: string[] = [];
		assert.deepEqual(await prepareRepository(dirty, async () => false, (message) => notices.push(message)), expected);
		assert.equal(notices.length, 1);
	} finally {
		rmSync(detached, { recursive: true, force: true });
		rmSync(dirty, { recursive: true, force: true });
	}
});

test("ensureTaskWorktree creates once and repeated exact activation is a no-op", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-ensure-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root);
		assert.equal(existsSync(task.worktree), false);
		assert.equal((await git(repository.root, ["show-ref", "--verify", "--quiet", "refs/heads/task"])).code, 1);
		await ensureTaskWorktree(task);
		assert.equal((await inspectTaskWorktree(task)).head, repository.head);
		assert.equal(await hasTaskWorktreeRegistration(task), true);
		await ensureTaskWorktree(task);
		assert.equal(run(task.worktree, "rev-list", "--count", "HEAD"), "1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureTaskWorktree adopts an exact branch-only interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-branch-only-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root);
		run(repository.root, "branch", task.branch, task.sourceHead);
		await ensureTaskWorktree(task);
		assert.equal((await inspectTaskWorktree(task)).head, task.sourceHead);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureTaskWorktree prunes and restores an exact stale missing registration", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-stale-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root);
		await ensureTaskWorktree(task);
		rmSync(task.worktree, { recursive: true, force: true });
		assert.equal(await hasTaskWorktreeRegistration(task), true);
		await ensureTaskWorktree(task);
		assert.equal((await inspectTaskWorktree(task)).head, task.sourceHead);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureTaskWorktree never prunes an unrelated stale registration", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-stale-unrelated-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root, "task");
		const unrelated = descriptor(repository, root, "unrelated");
		await ensureTaskWorktree(task);
		await ensureTaskWorktree(unrelated);
		rmSync(task.worktree, { recursive: true, force: true });
		rmSync(unrelated.worktree, { recursive: true, force: true });
		await assert.rejects(ensureTaskWorktree(task), /refusing to prune unrelated stale worktree/);
		assert.equal(await hasTaskWorktreeRegistration(task), true);
		assert.equal(await hasTaskWorktreeRegistration(unrelated), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureTaskWorktree rejects wrong branch OID and a branch checked out elsewhere", async () => {
	const wrongRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-wrong-oid-"));
	const elsewhereRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-elsewhere-"));
	try {
		const wrongRepository = initializeRepository(join(wrongRoot, "source"));
		mkdirSync(join(wrongRoot, "worktrees"));
		writeFileSync(join(wrongRepository.root, "tracked.txt"), "later\n");
		run(wrongRepository.root, "add", "-A");
		run(wrongRepository.root, "commit", "-m", "later");
		run(wrongRepository.root, "branch", "task", "HEAD");
		await assert.rejects(
			ensureTaskWorktree(descriptor(wrongRepository, wrongRoot)),
			/does not point to sourceHead/,
		);

		const elsewhereRepository = initializeRepository(join(elsewhereRoot, "source"));
		mkdirSync(join(elsewhereRoot, "worktrees"));
		const task = descriptor(elsewhereRepository, elsewhereRoot);
		run(
			elsewhereRepository.root,
			"worktree",
			"add",
			"-b",
			task.branch,
			join(elsewhereRoot, "other"),
			task.sourceHead,
		);
		await assert.rejects(ensureTaskWorktree(task), /already checked out/);
	} finally {
		rmSync(wrongRoot, { recursive: true, force: true });
		rmSync(elsewhereRoot, { recursive: true, force: true });
	}
});

test("ensureTaskWorktree rejects occupied, symlinked, wrong-repository, wrong-branch, and dirty workspaces", async () => {
	const occupiedRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-occupied-"));
	const symlinkRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-symlink-"));
	const wrongRepositoryRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-wrong-repository-"));
	const wrongBranchRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-wrong-branch-"));
	const dirtyRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-dirty-task-"));
	try {
		const occupiedRepository = initializeRepository(join(occupiedRoot, "source"));
		mkdirSync(join(occupiedRoot, "worktrees"));
		const occupied = descriptor(occupiedRepository, occupiedRoot);
		mkdirSync(occupied.worktree);
		await assert.rejects(ensureTaskWorktree(occupied), /occupied path is not the managed worktree/);

		const symlinkRepository = initializeRepository(join(symlinkRoot, "source"));
		mkdirSync(join(symlinkRoot, "worktrees"));
		const symlink = descriptor(symlinkRepository, symlinkRoot);
		symlinkSync(symlinkRepository.root, symlink.worktree, "dir");
		await assert.rejects(ensureTaskWorktree(symlink), /path is a symlink/);

		const wrongRepository = initializeRepository(join(wrongRepositoryRoot, "source"));
		mkdirSync(join(wrongRepositoryRoot, "worktrees"));
		const wrongRepositoryTask = descriptor(wrongRepository, wrongRepositoryRoot);
		initializeRepository(wrongRepositoryTask.worktree);
		await assert.rejects(ensureTaskWorktree(wrongRepositoryTask), /not the managed worktree/);

		const wrongBranchRepository = initializeRepository(join(wrongBranchRoot, "source"));
		mkdirSync(join(wrongBranchRoot, "worktrees"));
		const wrongBranch = descriptor(wrongBranchRepository, wrongBranchRoot);
		run(
			wrongBranchRepository.root,
			"worktree",
			"add",
			"-b",
			"other",
			wrongBranch.worktree,
			wrongBranch.sourceHead,
		);
		await assert.rejects(ensureTaskWorktree(wrongBranch), /branch differs|registration differs/);

		const dirtyRepository = initializeRepository(join(dirtyRoot, "source"));
		mkdirSync(join(dirtyRoot, "worktrees"));
		const dirty = descriptor(dirtyRepository, dirtyRoot);
		await ensureTaskWorktree(dirty);
		writeFileSync(join(dirty.worktree, "tracked.txt"), "dirty\n");
		await assert.rejects(ensureTaskWorktree(dirty), /pending candidate paths/);
	} finally {
		rmSync(occupiedRoot, { recursive: true, force: true });
		rmSync(symlinkRoot, { recursive: true, force: true });
		rmSync(wrongRepositoryRoot, { recursive: true, force: true });
		rmSync(wrongBranchRoot, { recursive: true, force: true });
		rmSync(dirtyRoot, { recursive: true, force: true });
	}
});

test("copyTaskLocalFiles copies only approved root locals with exact bytes and modes", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-copy-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		writeFileSync(
			join(repository.root, ".gitignore"),
			".env*\nCLAUDE.local.md\n.claude/settings.local.json\n",
		);
		run(repository.root, "add", ".gitignore");
		run(repository.root, "commit", "-m", "ignore local files");
		repository.head = run(repository.root, "rev-parse", "HEAD");
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root);
		writeFileSync(join(repository.root, ".env"), Buffer.from([0, 1, 2, 255]));
		chmodSync(join(repository.root, ".env"), 0o640);
		writeFileSync(join(repository.root, ".env.dev"), "dev\n");
		writeFileSync(join(repository.root, "CLAUDE.local.md"), "local instructions\n");
		mkdirSync(join(repository.root, ".claude"));
		writeFileSync(join(repository.root, ".claude", "settings.local.json"), "{\"local\":true}\n");
		mkdirSync(join(repository.root, ".env-directory"));
		mkdirSync(join(repository.root, "nested"));
		writeFileSync(join(repository.root, "nested", ".env"), "nested\n");
		writeFileSync(join(repository.root, "other.local"), "other\n");

		await ensureTaskWorktree(task);
		await copyTaskLocalFiles(task);
		assert.deepEqual(readFileSync(join(task.worktree, ".env")), Buffer.from([0, 1, 2, 255]));
		assert.equal(lstatSync(join(task.worktree, ".env")).mode & 0o777, 0o640);
		assert.equal(readFileSync(join(task.worktree, ".env.dev"), "utf8"), "dev\n");
		assert.equal(readFileSync(join(task.worktree, "CLAUDE.local.md"), "utf8"), "local instructions\n");
		assert.equal(
			readFileSync(join(task.worktree, ".claude", "settings.local.json"), "utf8"),
			"{\"local\":true}\n",
		);
		assert.equal(existsSync(join(task.worktree, ".env-directory")), false);
		assert.equal(existsSync(join(task.worktree, "nested", ".env")), false);
		assert.equal(existsSync(join(task.worktree, "other.local")), false);
		await copyTaskLocalFiles(task);
		assert.equal(
			readdirSync(task.worktree, { recursive: true }).some((name) => String(name).endsWith(".tmp")),
			false,
		);
		assert.deepEqual((await inspectTaskWorktree(task)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("copyTaskLocalFiles skips missing files and rejects source or destination symlinks", async () => {
	const missingRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-copy-missing-"));
	const sourceLinkRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-copy-source-link-"));
	const sourceDirectoryRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-copy-source-directory-"));
	const destinationLinkRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-copy-destination-link-"));
	try {
		const missingRepository = initializeRepository(join(missingRoot, "source"));
		mkdirSync(join(missingRoot, "worktrees"));
		const missing = descriptor(missingRepository, missingRoot);
		await ensureTaskWorktree(missing);
		await copyTaskLocalFiles(missing);

		const sourceLinkRepository = initializeRepository(join(sourceLinkRoot, "source"));
		writeFileSync(join(sourceLinkRepository.root, ".gitignore"), ".env*\n");
		run(sourceLinkRepository.root, "add", ".gitignore");
		run(sourceLinkRepository.root, "commit", "-m", "ignore env");
		sourceLinkRepository.head = run(sourceLinkRepository.root, "rev-parse", "HEAD");
		mkdirSync(join(sourceLinkRoot, "worktrees"));
		const sourceLink = descriptor(sourceLinkRepository, sourceLinkRoot);
		symlinkSync("tracked.txt", join(sourceLinkRepository.root, ".env.link"));
		await ensureTaskWorktree(sourceLink);
		await assert.rejects(copyTaskLocalFiles(sourceLink), /source is not a regular file/);

		const sourceDirectoryRepository = initializeRepository(join(sourceDirectoryRoot, "source"));
		mkdirSync(join(sourceDirectoryRoot, "worktrees"));
		const sourceDirectory = descriptor(sourceDirectoryRepository, sourceDirectoryRoot);
		mkdirSync(join(sourceDirectoryRepository.root, "CLAUDE.local.md"));
		await ensureTaskWorktree(sourceDirectory);
		await assert.rejects(copyTaskLocalFiles(sourceDirectory), /source is not a regular file/);

		const destinationLinkRepository = initializeRepository(join(destinationLinkRoot, "source"));
		writeFileSync(join(destinationLinkRepository.root, ".gitignore"), ".env*\n");
		run(destinationLinkRepository.root, "add", ".gitignore");
		run(destinationLinkRepository.root, "commit", "-m", "ignore env");
		destinationLinkRepository.head = run(destinationLinkRepository.root, "rev-parse", "HEAD");
		writeFileSync(join(destinationLinkRepository.root, ".env"), "source\n");
		mkdirSync(join(destinationLinkRoot, "worktrees"));
		const destinationLink = descriptor(destinationLinkRepository, destinationLinkRoot);
		await ensureTaskWorktree(destinationLink);
		symlinkSync("tracked.txt", join(destinationLink.worktree, ".env"));
		await assert.rejects(copyTaskLocalFiles(destinationLink), /destination is not a regular file/);
	} finally {
		rmSync(missingRoot, { recursive: true, force: true });
		rmSync(sourceLinkRoot, { recursive: true, force: true });
		rmSync(sourceDirectoryRoot, { recursive: true, force: true });
		rmSync(destinationLinkRoot, { recursive: true, force: true });
	}
});

test("copyTaskLocalFiles rolls back an unignored candidate and a corrected retry succeeds", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-copy-dirty-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		writeFileSync(join(repository.root, ".env"), "replacement\n");
		writeFileSync(join(repository.root, ".git", "info", "exclude"), ".env\n");
		writeFileSync(join(repository.root, "CLAUDE.local.md"), "unignored\n");
		mkdirSync(join(repository.root, ".claude"));
		writeFileSync(join(repository.root, ".claude", "settings.local.json"), "{}\n");
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root);
		await ensureTaskWorktree(task);
		writeFileSync(join(task.worktree, ".env"), "original\n");
		chmodSync(join(task.worktree, ".env"), 0o600);
		await assert.rejects(copyTaskLocalFiles(task), /pending candidate paths/);
		assert.equal(readFileSync(join(task.worktree, ".env"), "utf8"), "original\n");
		assert.equal(lstatSync(join(task.worktree, ".env")).mode & 0o777, 0o600);
		assert.equal(existsSync(join(task.worktree, "CLAUDE.local.md")), false);
		assert.equal(existsSync(join(task.worktree, ".claude")), false);
		assert.deepEqual((await inspectTaskWorktree(task)).paths, []);

		writeFileSync(
			join(repository.root, ".git", "info", "exclude"),
			".env\nCLAUDE.local.md\n.claude/settings.local.json\n",
		);
		await copyTaskLocalFiles(task);
		assert.equal(readFileSync(join(task.worktree, ".env"), "utf8"), "replacement\n");
		assert.equal(readFileSync(join(task.worktree, "CLAUDE.local.md"), "utf8"), "unignored\n");
		assert.deepEqual((await inspectTaskWorktree(task)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("copyTaskLocalFiles preflights every source before replacing earlier destinations", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-copy-preflight-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		writeFileSync(join(repository.root, ".gitignore"), ".env*\n");
		run(repository.root, "add", ".gitignore");
		run(repository.root, "commit", "-m", "ignore env");
		repository.head = run(repository.root, "rev-parse", "HEAD");
		writeFileSync(join(repository.root, ".env"), "replacement\n");
		mkdirSync(join(repository.root, "CLAUDE.local.md"));
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root);
		await ensureTaskWorktree(task);
		writeFileSync(join(task.worktree, ".env"), "original\n");
		chmodSync(join(task.worktree, ".env"), 0o600);

		await assert.rejects(copyTaskLocalFiles(task), /source is not a regular file/);
		assert.equal(readFileSync(join(task.worktree, ".env"), "utf8"), "original\n");
		assert.equal(lstatSync(join(task.worktree, ".env")).mode & 0o777, 0o600);
		assert.deepEqual((await inspectTaskWorktree(task)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stage, unstage, and extension-owned commit use the complete candidate", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-commit-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		mkdirSync(join(root, "worktrees"));
		const task = descriptor(repository, root);
		await ensureTaskWorktree(task);
		writeFileSync(join(task.worktree, "tracked.txt"), "changed\n");
		writeFileSync(join(task.worktree, "new\nfile.txt"), "new\n");
		assert.deepEqual(await stageAll(task), ["new\nfile.txt", "tracked.txt"]);
		await unstageAll(task);
		assert.deepEqual((await workspaceStatus(task.worktree)).paths, ["new\nfile.txt", "tracked.txt"]);
		await stageAll(task);
		const commit = await commitStaged(task, "Implement complete candidate\n\nTested locally.");
		assert.equal(commit, run(task.worktree, "rev-parse", "HEAD"));
		assert.deepEqual((await inspectTaskWorktree(task)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unrecorded descendant commits reset mixed and divergence is rejected", async () => {
	const recoveryRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-recover-"));
	const divergenceRoot = mkdtempSync(join(tmpdir(), "juruc-workspace-diverge-"));
	try {
		const recoveryRepository = initializeRepository(join(recoveryRoot, "source"));
		mkdirSync(join(recoveryRoot, "worktrees"));
		const recovery = descriptor(recoveryRepository, recoveryRoot);
		await ensureTaskWorktree(recovery);
		writeFileSync(join(recovery.worktree, "tracked.txt"), "committed by model\n");
		run(recovery.worktree, "add", "-A");
		run(recovery.worktree, "commit", "-m", "unrecorded");
		writeFileSync(join(recovery.worktree, "new.txt"), "still dirty\n");
		assert.equal(await recoverUnrecordedTaskCommits(recovery, recovery.sourceHead), true);
		assert.equal(run(recovery.worktree, "rev-parse", "HEAD"), recovery.sourceHead);
		assert.deepEqual((await workspaceStatus(recovery.worktree)).paths, ["new.txt", "tracked.txt"]);

		const divergenceRepository = initializeRepository(join(divergenceRoot, "source"));
		mkdirSync(join(divergenceRoot, "worktrees"));
		const divergence = descriptor(divergenceRepository, divergenceRoot);
		await ensureTaskWorktree(divergence);
		writeFileSync(join(divergence.worktree, "tracked.txt"), "recorded\n");
		run(divergence.worktree, "add", "-A");
		run(divergence.worktree, "commit", "-m", "recorded");
		const recorded = run(divergence.worktree, "rev-parse", "HEAD");
		run(divergence.worktree, "reset", "--hard", divergence.sourceHead);
		writeFileSync(join(divergence.worktree, "tracked.txt"), "diverged\n");
		run(divergence.worktree, "add", "-A");
		run(divergence.worktree, "commit", "-m", "diverged");
		await assert.rejects(recoverUnrecordedTaskCommits(divergence, recorded), /diverged/);
	} finally {
		rmSync(recoveryRoot, { recursive: true, force: true });
		rmSync(divergenceRoot, { recursive: true, force: true });
	}
});

test("task worktree removal handles absent, branch-only, registered, and unmanaged paths safely", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-workspace-remove-"));
	try {
		const repository = initializeRepository(join(root, "source"));
		mkdirSync(join(root, "worktrees"));
		const absent = descriptor(repository, root, "absent-task");
		assert.equal(await removeTaskWorktree(absent), false);

		const branchOnly = descriptor(repository, root, "branch-only-task");
		run(repository.root, "branch", branchOnly.branch, branchOnly.sourceHead);
		assert.equal(await removeTaskWorktree(branchOnly), false);
		assert.equal((await git(repository.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branchOnly.branch}`])).code, 0);

		const unmanaged = descriptor(repository, root, "unmanaged-task");
		mkdirSync(unmanaged.worktree);
		assert.equal(await removeTaskWorktree(unmanaged), false);
		assert.equal(existsSync(unmanaged.worktree), true);

		const registered = descriptor(repository, root, "registered-task");
		await ensureTaskWorktree(registered);
		writeFileSync(join(registered.worktree, "tracked.txt"), "dirty\n");
		assert.equal(await removeTaskWorktree(registered), true);
		assert.equal(existsSync(registered.worktree), false);
		assert.equal((await git(repository.root, ["show-ref", "--verify", "--quiet", `refs/heads/${registered.branch}`])).code, 0);

		const stale = descriptor(repository, root, "stale-task");
		await ensureTaskWorktree(stale);
		rmSync(stale.worktree, { recursive: true, force: true });
		assert.equal(await removeTaskWorktree(stale), true);
		assert.equal((await git(repository.root, ["show-ref", "--verify", "--quiet", `refs/heads/${stale.branch}`])).code, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
