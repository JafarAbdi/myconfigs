import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addWorktree,
	branchExists,
	discardWorktree,
	removeWorktree,
	repositoryRoot,
	requireHead,
	worktreeChanges,
} from "./git.ts";

function entry(path: string) {
	return lstatSync(path, { throwIfNoEntry: false });
}

function withRepository(run: (repository: string, parent: string) => void): void {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "task-git-test-")));
	const repository = join(parent, "repo");
	try {
		mkdirSync(repository);
		const git = (...args: string[]) => execFileSync("git", args, {
			cwd: repository,
			encoding: "utf8",
		});
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(repository, "README.md"), "hello\n");
		git("add", "README.md");
		git("commit", "-qm", "initial");
		run(repository, parent);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

test("repositoryRoot and requireHead fail loudly outside their domain", () => {
	withRepository((repository, parent) => {
		mkdirSync(join(repository, "src"));
		assert.equal(repositoryRoot(join(repository, "src")), repository);
		assert.doesNotThrow(() => requireHead(repository));
		assert.throws(() => repositoryRoot(parent), /git rev-parse --show-toplevel failed/);
		assert.throws(() => repositoryRoot(join(parent, "missing")), /ENOENT/);
	});
});

test("branch absence is distinct from Git failure", () => {
	withRepository((repository, parent) => {
		assert.equal(branchExists(repository, "main"), true);
		assert.equal(branchExists(repository, "task-branch"), false);
		assert.throws(() => branchExists(parent, "main"), /git show-ref.*failed/);
	});
});

test("worktree creation forks HEAD and rollback removes only the new branch and tree", () => {
	withRepository((repository, parent) => {
		const worktree = join(parent, "repo-task-branch");
		addWorktree(repository, worktree, "task-branch");
		assert.equal(repositoryRoot(worktree), worktree);
		assert.equal(branchExists(repository, "task-branch"), true);
		assert.notEqual(entry(worktree), undefined);

		discardWorktree(repository, worktree, "task-branch");
		assert.equal(entry(worktree), undefined);
		assert.equal(branchExists(repository, "task-branch"), false);
		assert.equal(branchExists(repository, "main"), true);
	});
});

test("task deletion reports discarded work and keeps its branch", () => {
	withRepository((repository, parent) => {
		const worktree = join(parent, "repo-task-branch");
		addWorktree(repository, worktree, "task-branch");
		assert.deepEqual(worktreeChanges(repository, worktree, "task-branch"), {
			modified: 0,
			untracked: 0,
			hasGitlinks: false,
		});
		assert.throws(
			() => worktreeChanges(repository, worktree, "main"),
			/expected branch main, found task-branch/,
		);

		writeFileSync(join(worktree, "README.md"), "changed\n");
		writeFileSync(join(worktree, "new.txt"), "untracked\n");
		assert.deepEqual(worktreeChanges(repository, worktree, "task-branch"), {
			modified: 1,
			untracked: 1,
			hasGitlinks: false,
		});
		assert.throws(
			() => removeWorktree(repository, worktree, false),
			/contains modified or untracked files/,
		);
		assert.notEqual(entry(worktree), undefined);

		removeWorktree(repository, worktree, true);
		assert.equal(entry(worktree), undefined);
		assert.equal(branchExists(repository, "task-branch"), true);
	});
});

test("clean worktrees containing submodules request forced removal", () => {
	withRepository((repository, parent) => {
		const submodule = join(parent, "submodule");
		mkdirSync(submodule);
		for (const args of [
			["init", "-q", "-b", "main"],
			["config", "user.email", "test@example.com"],
			["config", "user.name", "Test"],
		] as const) {
			execFileSync("git", args, { cwd: submodule });
		}
		writeFileSync(join(submodule, "file.txt"), "submodule\n");
		execFileSync("git", ["add", "file.txt"], { cwd: submodule });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: submodule });
		execFileSync(
			"git",
			["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "module"],
			{ cwd: repository },
		);
		execFileSync("git", ["commit", "-qam", "add submodule"], { cwd: repository });

		const worktree = join(parent, "repo-task-branch");
		addWorktree(repository, worktree, "task-branch");
		execFileSync(
			"git",
			["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"],
			{ cwd: worktree },
		);
		const changes = worktreeChanges(repository, worktree, "task-branch");
		assert.deepEqual(changes, { modified: 0, untracked: 0, hasGitlinks: true });
		assert.throws(
			() => removeWorktree(repository, worktree, false),
			/working trees containing submodules cannot be moved or removed/,
		);

		removeWorktree(repository, worktree, changes.hasGitlinks);
		assert.equal(entry(worktree), undefined);
		assert.equal(branchExists(repository, "task-branch"), true);
	});
});
