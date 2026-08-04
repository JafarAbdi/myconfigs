import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	gitDiffArguments,
	MAX_REVIEW_CHANGED_LINES,
	MAX_REVIEW_FILES,
	MAX_REVIEW_PATCH_BYTES,
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
		assert.equal(patch.snapshot.raw.equals(expectedRaw), true);
		assert.equal(patch.text, expectedRaw.toString("utf8"));
		assert.match(patch.text, /staged new/u);
		assert.doesNotMatch(patch.text, /UNSTAGED|unstaged replacement|unstaged\.txt/u);
		assert.deepEqual(patch.files.map(({ filePath }) => filePath).sort(), [
			"deleted.txt",
			"modified.txt",
			"new.txt",
			"rename-new.txt",
		]);
		assert.deepEqual(
			patch.files.find(({ filePath }) => filePath === "modified.txt")?.changed,
			{ additions: [2], deletions: [2] },
		);
		assert.deepEqual(
			patch.files.find(({ filePath }) => filePath === "new.txt")?.changed,
			{ additions: [1], deletions: [] },
		);
		const renamed = patch.files.find(({ filePath }) => filePath === "rename-new.txt");
		assert.equal(renamed?.previousPath, "rename-old.txt");
		assert.equal(renamed?.type, "rename-pure");
		assert.deepEqual(
			patch.files.find(({ filePath }) => filePath === "deleted.txt")?.changed,
			{ additions: [], deletions: [1] },
		);
		assert.equal(git(repository, "rev-parse", "HEAD"), beforeHead);
		assert.equal(git(repository, "status", "--porcelain=v2"), beforeStatus);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test("uses the bounded, terminal staged diff command", () => {
	assert.deepEqual(gitDiffArguments(), [
		"diff",
		"--cached",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-algorithm=histogram",
		"--find-renames",
		"--unified=3",
		"HEAD",
		"--",
	]);
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

test("preserves the existing file, changed-line, and byte ceilings", () => {
	assert.equal(reviewPatchFromText(syntheticPatch(MAX_REVIEW_FILES, 1), ROOT, HEAD).files.length, MAX_REVIEW_FILES);
	assert.throws(
		() => reviewPatchFromText(syntheticPatch(MAX_REVIEW_FILES + 1, 1), ROOT, HEAD),
		new RegExp(`above the ${MAX_REVIEW_FILES} Review limit`),
	);
	const pairs = MAX_REVIEW_CHANGED_LINES / 2;
	assert.equal(
		reviewPatchFromText(syntheticPatch(1, pairs), ROOT, HEAD).files[0].changed.additions.length * 2,
		MAX_REVIEW_CHANGED_LINES,
	);
	assert.throws(
		() => reviewPatchFromText(syntheticPatch(1, pairs + 1), ROOT, HEAD),
		new RegExp(`above the ${MAX_REVIEW_CHANGED_LINES} Review limit`),
	);
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
		assert.deepEqual(patch.files, []);
		assert.equal(git(repository, "status", "--porcelain=v2"), before);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test("snapshot freshness compares repository root, HEAD, and exact bytes", () => {
	const patch = reviewPatchFromText(syntheticPatch(1, 1), ROOT, HEAD);
	const equal = { ...patch.snapshot, raw: Buffer.from(patch.snapshot.raw) };
	assert.equal(reviewSnapshotsEqual(patch.snapshot, equal), true);
	assert.equal(reviewSnapshotsEqual(patch.snapshot, { ...equal, repositoryRoot: "/other" }), false);
	assert.equal(reviewSnapshotsEqual(patch.snapshot, { ...equal, headOid: "3".repeat(40) }), false);
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
