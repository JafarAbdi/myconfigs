import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveResearchBrief } from "./research.ts";

const brief = "  ## Findings\r\n\nUse the existing transaction boundary.\n";

const root = mkdtempSync(join(tmpdir(), "juruc-research-test-"));
try {
	const task = join(root, "task");
	mkdirSync(task);
	const path = join(task, "research.md");
	const assertNoTemporaryFiles = () =>
		assert.deepEqual(
			readdirSync(task).filter((name) => name.startsWith(".research.md.")),
			[],
		);

	const previousUmask = process.umask(0o777);
	try {
		saveResearchBrief(task, brief);
	} finally {
		process.umask(previousUmask);
	}
	assert.equal(
		readFileSync(path, "utf8"),
		brief,
		"research.md is the exact opaque synthesizer output",
	);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assertNoTemporaryFiles();

	writeFileSync(path, "obsolete unapproved research\n");
	chmodSync(path, 0o644);
	const replacement = "  Replacement synthesis.\n";
	saveResearchBrief(task, replacement);
	assert.equal(
		readFileSync(path, "utf8"),
		replacement,
		"an interrupted unapproved artifact is overwritten verbatim",
	);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assertNoTemporaryFiles();

	for (const invalid of ["", " \n\t "]) {
		assert.throws(() => saveResearchBrief(task, invalid), /research brief/);
		assertNoTemporaryFiles();
	}
	const opaque = "NUL\u0000body";
	saveResearchBrief(task, opaque);
	assert.equal(readFileSync(path, "utf8"), opaque);
	const large = "é".repeat(40_000);
	saveResearchBrief(task, large);
	assert.equal(
		readFileSync(path, "utf8"),
		large,
		"successful synthesis is not truncated or rejected by an arbitrary content limit",
	);
	assertNoTemporaryFiles();

	const outside = join(root, "outside.md");
	writeFileSync(outside, "outside\n");
	unlinkSync(path);
	symlinkSync(outside, path);
	assert.throws(() => saveResearchBrief(task, brief), /not a regular file/);
	assert.equal(readFileSync(outside, "utf8"), "outside\n");
	assertNoTemporaryFiles();
	unlinkSync(path);

	mkdirSync(path);
	assert.throws(() => saveResearchBrief(task, brief), /not a regular file/);
	assertNoTemporaryFiles();
	rmSync(path, { recursive: true });

	const linkedTask = join(root, "linked-task");
	symlinkSync(task, linkedTask);
	assert.throws(
		() => saveResearchBrief(linkedTask, brief),
		/not an exact regular task directory/,
	);
	assertNoTemporaryFiles();
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("juruc research artifact: ok");
