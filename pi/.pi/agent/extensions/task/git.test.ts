import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addWorktree,
	branchExists,
	currentBranch,
	removeWorktree,
	repositoryRoot,
	worktreeChanges,
} from "./git.ts";

/** A repository with one commit on `main`, and a place beside it for worktrees. */
function withRepository(run: (repository: string, beside: string) => void): void {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "task-git-test-")));
	const repository = join(root, "repo");
	try {
		mkdirSync(repository);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf-8" });
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@test");
		git("config", "user.name", "test");
		writeFileSync(join(repository, "README.md"), "hi\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		run(repository, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a repository answers where it is and what branch it is on", () => {
	withRepository((repository) => {
		mkdirSync(join(repository, "src"));
		assert.equal(repositoryRoot(join(repository, "src")), repository);
		assert.equal(currentBranch(repository), "main");
		assert.equal(branchExists(repository, "main"), true);
		assert.equal(branchExists(repository, "joint-rail"), false);
	});
});

test("a question about a path that is not a repository answers no, rather than throwing", () => {
	withRepository((_repository, beside) => {
		assert.equal(repositoryRoot(beside), undefined);
		assert.equal(currentBranch(beside), undefined);
		assert.equal(worktreeChanges(join(beside, "gone")), undefined);
	});
});

test("a worktree is created on its own branch, forked from the base", () => {
	withRepository((repository, beside) => {
		const worktree = join(beside, "repo-joint-rail");
		addWorktree(repository, worktree, "joint-rail", "main");
		assert.equal(currentBranch(worktree), "joint-rail");
		assert.equal(repositoryRoot(worktree), worktree);
		assert.equal(branchExists(repository, "joint-rail"), true);
		assert.deepEqual(worktreeChanges(worktree), { modified: 0, untracked: 0 });
	});
});

test("uncommitted work is counted by kind, and unknown is not zero", () => {
	withRepository((repository, beside) => {
		const worktree = join(beside, "repo-joint-rail");
		addWorktree(repository, worktree, "joint-rail", "main");
		writeFileSync(join(worktree, "README.md"), "changed\n");
		writeFileSync(join(worktree, "scratch.txt"), "new\n");
		assert.deepEqual(worktreeChanges(worktree), { modified: 1, untracked: 1 });
	});
});

test("a worktree with work in it refuses to vanish until the delete says it will discard it", () => {
	withRepository((repository, beside) => {
		const worktree = join(beside, "repo-joint-rail");
		addWorktree(repository, worktree, "joint-rail", "main");
		writeFileSync(join(worktree, "scratch.txt"), "new\n");

		// git's own words reach the operator: the refusal says which file stopped it.
		assert.throws(() => removeWorktree(repository, worktree, false), /contains modified or untracked files/);
		assert.equal(existsSync(worktree), true, "the refusal changed nothing");

		removeWorktree(repository, worktree, true);
		assert.equal(existsSync(worktree), false);
		assert.equal(branchExists(repository, "joint-rail"), true, "the branch is the work, and it stays");
	});
});

test("a clean worktree needs no force", () => {
	withRepository((repository, beside) => {
		const worktree = join(beside, "repo-joint-rail");
		addWorktree(repository, worktree, "joint-rail", "main");
		removeWorktree(repository, worktree, false);
		assert.equal(existsSync(worktree), false);
		assert.equal(branchExists(repository, "joint-rail"), true);
	});
});
