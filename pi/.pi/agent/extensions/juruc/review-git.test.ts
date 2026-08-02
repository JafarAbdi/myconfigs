import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	gitDiffArguments,
	readGitReviewPatch,
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
