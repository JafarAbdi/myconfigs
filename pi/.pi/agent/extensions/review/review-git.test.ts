import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	gitDiffArguments,
	MAX_REVIEW_PATCH_BYTES,
	listGitReviewPaths,
	listGitReviewRequirements,
	readGitReviewPatch,
	reviewPatchFromText,
	reviewSnapshotsEqual,
} from "./review-git.ts";

function git(repository: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();
}

function createRepository(prefix: string): string {
	const repository = mkdtempSync(join(tmpdir(), prefix));
	git(repository, "init", "-b", "main");
	git(repository, "config", "user.name", "Review test");
	git(repository, "config", "user.email", "review@example.invalid");
	writeFileSync(join(repository, "modified.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(repository, "rename-old.txt"), "rename only\n");
	writeFileSync(join(repository, "deleted.txt"), "remove me\n");
	git(repository, "add", "-A");
	git(repository, "commit", "-m", "base");
	return repository;
}

test("captures only the exact staged modified, new, renamed, and deleted candidate", async () => {
	const repository = createRepository("review-git-staged-");
	try {
		writeFileSync(join(repository, "modified.txt"), "one\nTWO\nthree\n");
		writeFileSync(join(repository, "new.txt"), "staged new\n");
		git(repository, "mv", "rename-old.txt", "rename-new.txt");
		rmSync(join(repository, "deleted.txt"));
		git(repository, "add", "-A");

		writeFileSync(join(repository, "modified.txt"), "UNSTAGED\nTWO\nthree\n");
		writeFileSync(join(repository, "new.txt"), "unstaged replacement\n");
		writeFileSync(join(repository, "unstaged.txt"), "not staged\n");
		const beforeStatus = git(repository, "status", "--porcelain=v2");
		const beforeHead = git(repository, "rev-parse", "HEAD");

		const patch = await readGitReviewPatch(join(repository, ".git", ".."));
		const expectedRaw = execFileSync("git", gitDiffArguments(), { cwd: repository });
		assert.equal(patch.snapshot.repositoryRoot, repository);
		assert.equal(patch.snapshot.headOid, beforeHead);
		assert.equal(patch.snapshot.view, "staged");
		assert.deepEqual(patch.snapshot.paths, []);
		assert.equal(patch.snapshot.raw.equals(expectedRaw), true);
		assert.equal(patch.text, expectedRaw.toString("utf8"));
		assert.match(patch.text, /staged new/u);
		assert.doesNotMatch(patch.text, /UNSTAGED|unstaged replacement|unstaged\.txt/u);
		assert.match(patch.text, /--- a\/modified\.txt[\s\S]*-two\n\+TWO/u);
		assert.match(patch.text, /\+\+\+ b\/new\.txt[\s\S]*\+staged new/u);
		assert.match(patch.text, /similarity index 100%\nrename from rename-old\.txt\nrename to rename-new\.txt/u);
		assert.match(patch.text, /--- a\/deleted\.txt[\s\S]*-remove me/u);
		assert.equal(git(repository, "rev-parse", "HEAD"), beforeHead);
		assert.equal(git(repository, "status", "--porcelain=v2"), beforeStatus);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test("captures staged, unstaged, untracked, and overall path-scoped views", async () => {
	const repository = createRepository("review-git-sources-");
	try {
		writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(repository, "modified.txt"), "one\nstaged\nthree\n");
		git(repository, "add", ".gitignore", "modified.txt");
		writeFileSync(join(repository, "modified.txt"), "one\nworktree\nthree\n");
		writeFileSync(join(repository, "rename-old.txt"), "worktree only\n");
		writeFileSync(join(repository, "untracked file.txt"), "new file\n");
		writeFileSync(join(repository, "ignored.txt"), "ignored\n");
		const beforeStatus = git(repository, "status", "--porcelain=v2");

		const staged = await readGitReviewPatch(repository, {
			view: "staged",
			paths: ["modified.txt"],
		});
		assert.equal(staged.snapshot.view, "staged");
		assert.deepEqual(staged.snapshot.paths, ["modified.txt"]);
		assert.match(staged.text, /\+staged/u);
		assert.doesNotMatch(staged.text, /worktree|untracked file/u);

		const unstaged = await readGitReviewPatch(repository, {
			view: "unstaged",
			paths: ["modified.txt", "rename-old.txt"],
		});
		assert.equal(unstaged.snapshot.view, "unstaged");
		assert.match(unstaged.text, /-staged\n\+worktree/u);
		assert.match(unstaged.text, /worktree only/u);
		assert.doesNotMatch(unstaged.text, /untracked file/u);
		assert.match(unstaged.text, /index [0-9a-f]{40}\.\.[0-9a-f]{40}/u);

		const untracked = await readGitReviewPatch(repository, {
			view: "untracked",
			paths: ["."],
		});
		assert.equal(untracked.snapshot.view, "untracked");
		assert.match(untracked.text, /\+\+\+ b\/untracked file\.txt/u);
		assert.match(untracked.text, /\+new file/u);
		assert.doesNotMatch(untracked.text, /ignored/u);
		const overall = await readGitReviewPatch(repository, {
			view: "overall",
			paths: ["modified.txt", "untracked file.txt"],
		});
		assert.equal(overall.snapshot.view, "overall");
		assert.match(overall.text, /-two\n\+worktree/u);
		assert.match(overall.text, /\+new file/u);
		assert.doesNotMatch(overall.text, /\+staged/u);

		assert.deepEqual(await listGitReviewPaths(repository, "staged"), [
			".gitignore",
			"modified.txt",
		]);
		assert.deepEqual(await listGitReviewPaths(repository, "unstaged"), [
			"modified.txt",
			"rename-old.txt",
		]);
		assert.deepEqual(await listGitReviewPaths(repository, "untracked"), ["untracked file.txt"]);
		assert.deepEqual(await listGitReviewPaths(repository, "overall"), [
			".gitignore",
			"modified.txt",
			"rename-old.txt",
			"untracked file.txt",
		]);
		assert.equal(git(repository, "status", "--porcelain=v2"), beforeStatus);
		writeFileSync(join(repository, "review.md"), "# Requirement\n");
		assert.deepEqual(await listGitReviewRequirements(repository), ["review.md"]);

		const statusAfterRequirement = git(repository, "status", "--porcelain=v2");
		assert.notEqual(statusAfterRequirement, beforeStatus);
		writeFileSync(join(repository, "outside-selection.txt"), "unrelated\n");
		const statusWithUnrelated = git(repository, "status", "--porcelain=v2");
		const stagedAgain = await readGitReviewPatch(repository, {
			view: "staged",
			paths: ["modified.txt"],
		});
		assert.equal(reviewSnapshotsEqual(staged.snapshot, stagedAgain.snapshot), true);
		assert.equal(git(repository, "status", "--porcelain=v2"), statusWithUnrelated);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test("uses bounded terminal diff commands with literal selected paths", () => {
	assert.deepEqual(gitDiffArguments(), [
		"diff",
		"--cached",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-algorithm=histogram",
		"--find-renames",
		"--full-index",
		"--unified=3",
		"HEAD",
		"--",
	]);
	assert.deepEqual(gitDiffArguments({ view: "unstaged", paths: ["src/[literal].ts"] }), [
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-algorithm=histogram",
		"--find-renames",
		"--full-index",
		"--unified=3",
		"--",
		":(top,literal)src/[literal].ts",
	]);
	assert.equal(gitDiffArguments({ view: "overall", paths: [] }).includes("HEAD"), true);
	assert.throws(() => gitDiffArguments({ view: "untracked", paths: [] }), /does not use git diff/u);
});

const ROOT = "/repository";
const HEAD = "2".repeat(40);

function syntheticPatch(files: number, changedPairsPerFile: number): string {
	const parts: string[] = [];
	for (let file = 0; file < files; file += 1) {
		const path = `src/generated-${file}.ts`;
		const body: string[] = [];
		for (let pair = 0; pair < changedPairsPerFile; pair += 1) {
			body.push(`-const before${pair} = ${pair};`);
			body.push(`+const after${pair} = ${pair + 1};`);
		}
		parts.push(
			`diff --git a/${path} b/${path}`,
			"index 1111111..2222222 100644",
			`--- a/${path}`,
			`+++ b/${path}`,
			`@@ -1,${changedPairsPerFile} +1,${changedPairsPerFile} @@`,
			...body,
		);
	}
	return `${parts.join("\n")}\n`;
}

test("preserves the existing byte ceiling", () => {
	assert.equal(reviewPatchFromText(syntheticPatch(1, 1), ROOT, HEAD).empty, false);
	assert.throws(
		() => reviewPatchFromText(`${syntheticPatch(1, 1)}${"#".repeat(MAX_REVIEW_PATCH_BYTES)}`, ROOT, HEAD),
		(error) => error instanceof Error && /Review is too large/u.test(error.message),
	);
});

test("represents an empty staged candidate without mutating Git", async () => {
	const repository = createRepository("review-git-empty-");
	try {
		const before = git(repository, "status", "--porcelain=v2");
		const patch = await readGitReviewPatch(repository);
		assert.equal(patch.empty, true);
		assert.equal(patch.snapshot.raw.length, 0);
		assert.equal(git(repository, "status", "--porcelain=v2"), before);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test("snapshot freshness compares repository root, HEAD, and exact bytes", () => {
	const patch = reviewPatchFromText(syntheticPatch(1, 1), ROOT, HEAD);
	const equal = { ...patch.snapshot, paths: [...patch.snapshot.paths], raw: Buffer.from(patch.snapshot.raw) };
	assert.equal(reviewSnapshotsEqual(patch.snapshot, equal), true);
	assert.equal(reviewSnapshotsEqual(patch.snapshot, { ...equal, repositoryRoot: "/other" }), false);
	assert.equal(reviewSnapshotsEqual(patch.snapshot, { ...equal, headOid: "3".repeat(40) }), false);
	assert.equal(reviewSnapshotsEqual(patch.snapshot, { ...equal, view: "unstaged" }), false);
	assert.equal(reviewSnapshotsEqual(patch.snapshot, { ...equal, paths: ["src"] }), false);
	const changedBytes = Buffer.from(equal.raw);
	changedBytes[changedBytes.length - 1] ^= 1;
	assert.equal(reviewSnapshotsEqual(patch.snapshot, { ...equal, raw: changedBytes }), false);
});

test("capture fails if HEAD changes while Git produces the staged bytes", async () => {
	const repository = createRepository("review-git-head-drift-");
	const bin = mkdtempSync(join(tmpdir(), "review-git-wrapper-"));
	const wrapper = join(bin, "git");
	const previousPath = process.env.PATH;
	const previousRealGit = process.env.REVIEW_REAL_GIT;
	try {
		process.env.REVIEW_REAL_GIT = realpathSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
		writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = diff ]; then
  "$REVIEW_REAL_GIT" commit --allow-empty -m drift >/dev/null 2>&1
fi
exec "$REVIEW_REAL_GIT" "$@"
`);
		chmodSync(wrapper, 0o755);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		await assert.rejects(readGitReviewPatch(repository), /HEAD changed while/u);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousRealGit === undefined) delete process.env.REVIEW_REAL_GIT;
		else process.env.REVIEW_REAL_GIT = previousRealGit;
		rmSync(bin, { recursive: true, force: true });
		rmSync(repository, { recursive: true, force: true });
	}
});

test("bounded Git capture rejects oversized staged output", async () => {
	const repository = createRepository("review-git-oversized-");
	try {
		mkdirSync(join(repository, "large"));
		writeFileSync(
			join(repository, "large", "candidate.txt"),
			`${"x".repeat(4_096)}\n`.repeat(Math.ceil(MAX_REVIEW_PATCH_BYTES / 4_097) + 8),
		);
		git(repository, "add", "large/candidate.txt");
		await assert.rejects(readGitReviewPatch(repository), /Review is too large/u);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});
