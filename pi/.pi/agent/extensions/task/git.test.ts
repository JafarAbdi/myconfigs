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
	repositoryRoot,
	requireHead,
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
