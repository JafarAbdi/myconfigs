import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "./review-git.ts";

function git(repository: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, {
		cwd: repository,
		encoding: "utf8",
	}).trim();
}

test("Git adapter resolves commits and renders the pinned cumulative command", async () => {
	const repository = mkdtempSync(join(tmpdir(), "juruc-review-git-"));
	try {
		git(repository, "init", "-b", "main");
		git(repository, "config", "user.name", "JURUC review test");
		git(repository, "config", "user.email", "review@example.invalid");
		writeFileSync(join(repository, "app.ts"), "one\ntwo\nthree\n");
		writeFileSync(join(repository, "old-name.txt"), "rename me\n");
		git(repository, "add", "-A");
		git(repository, "commit", "-m", "base");
		const base = git(repository, "rev-parse", "HEAD");

		writeFileSync(join(repository, "app.ts"), "one\nTWO\nTHREE\nthree\n");
		git(repository, "mv", "old-name.txt", "new-name.txt");
		git(repository, "add", "-A");
		git(repository, "commit", "-m", "head");
		const head = git(repository, "rev-parse", "HEAD");

		assert.deepEqual(gitDiffArguments(base, head), [
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--diff-algorithm=histogram",
			"--find-renames",
			"--unified=3",
			`${base}...${head}`,
		]);
		const patch = await readGitReviewPatch(repository, "HEAD~1", "HEAD");
		assert.equal(patch.identity.baseOid, base);
		assert.equal(patch.identity.headOid, head);
		assert.equal(patch.empty, false);
		assert.doesNotMatch(patch.text, /\x1b\[/u);
		const app = patch.files.find(({ filePath }) => filePath === "app.ts");
		assert.deepEqual(app?.changed, {
			additions: [2, 3],
			deletions: [2],
		});
		const renamed = patch.files.find(({ filePath }) => filePath === "new-name.txt");
		assert.equal(renamed?.previousPath, "old-name.txt");
		assert.equal(renamed?.type, "rename-pure");
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

const BASE_OID = "1".repeat(40);
const HEAD_OID = "2".repeat(40);

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

test("measured review limits accept their boundary and refuse one step past it", () => {
	const atFileLimit = reviewPatchFromText(
		syntheticPatch(MAX_REVIEW_FILES, 1),
		BASE_OID,
		HEAD_OID,
	);
	assert.equal(atFileLimit.files.length, MAX_REVIEW_FILES);
	assert.throws(
		() => reviewPatchFromText(syntheticPatch(MAX_REVIEW_FILES + 1, 1), BASE_OID, HEAD_OID),
		new RegExp(`changed file count is ${MAX_REVIEW_FILES + 1}, above the ${MAX_REVIEW_FILES} JURUC limit`),
	);

	const pairs = MAX_REVIEW_CHANGED_LINES / 2;
	const atLineLimit = reviewPatchFromText(syntheticPatch(1, pairs), BASE_OID, HEAD_OID);
	assert.equal(
		atLineLimit.files[0].changed.additions.length + atLineLimit.files[0].changed.deletions.length,
		MAX_REVIEW_CHANGED_LINES,
	);
	assert.throws(
		() => reviewPatchFromText(syntheticPatch(1, pairs + 1), BASE_OID, HEAD_OID),
		new RegExp(`changed line count is ${MAX_REVIEW_CHANGED_LINES + 2}, above the ${MAX_REVIEW_CHANGED_LINES} JURUC limit`),
	);

	const oversizedText = `${syntheticPatch(1, 1)}${"#".repeat(MAX_REVIEW_PATCH_BYTES)}\n`;
	assert.throws(
		() => reviewPatchFromText(oversizedText, BASE_OID, HEAD_OID),
		/cumulative patch is \d+, above the \d+ JURUC limit/,
	);
});

test("Git diff collection is bounded before an unlimited buffer accumulates", async () => {
	const repository = mkdtempSync(join(tmpdir(), "juruc-review-oversized-"));
	try {
		git(repository, "init", "-b", "main");
		git(repository, "config", "user.name", "JURUC review test");
		git(repository, "config", "user.email", "review@example.invalid");
		writeFileSync(join(repository, "seed.txt"), "seed\n");
		git(repository, "add", "-A");
		git(repository, "commit", "-m", "base");
		writeFileSync(
			join(repository, "huge.txt"),
			`${"x".repeat(4_096)}\n`.repeat((MAX_REVIEW_PATCH_BYTES / 4_097) + 64),
		);
		git(repository, "add", "-A");
		git(repository, "commit", "-m", "huge");
		await assert.rejects(
			readGitReviewPatch(repository, "HEAD~1", "HEAD"),
			/review is too large to render/,
		);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

test("Git adapter reports an empty diff explicitly", async () => {
	const repository = mkdtempSync(join(tmpdir(), "juruc-review-empty-"));
	try {
		git(repository, "init", "-b", "main");
		git(repository, "config", "user.name", "JURUC review test");
		git(repository, "config", "user.email", "review@example.invalid");
		writeFileSync(join(repository, "file.txt"), "unchanged\n");
		git(repository, "add", "-A");
		git(repository, "commit", "-m", "only commit");
		const patch = await readGitReviewPatch(repository, "HEAD", "HEAD");
		assert.equal(patch.empty, true);
		assert.equal(patch.text, "");
		assert.deepEqual(patch.files, []);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});
