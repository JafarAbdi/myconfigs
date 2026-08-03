import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireTaskReviewLock } from "./review-lock.ts";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-lock-"));
	const taskPath = join(directory, "task.json");
	const lockPath = `${taskPath}.review.lock`;
	return { directory, taskPath, lockPath };
}

test("review lock rejects live ownership and releases token-safely", () => {
	const { directory, taskPath, lockPath } = fixture();
	try {
		const release = acquireTaskReviewLock(taskPath);
		assert.equal(statSync(lockPath).mode & 0o777, 0o600);
		const owner = JSON.parse(readFileSync(lockPath, "utf8"));
		assert.equal(owner.pid, process.pid);
		assert.equal(typeof owner.token, "string");
		assert.ok(owner.token.length >= 32);
		assert.throws(
			() => acquireTaskReviewLock(taskPath),
			/another review operation already owns/,
		);
		writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "replacement" })}\n`);
		release();
		assert.equal(existsSync(lockPath), true);
		unlinkSync(lockPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("review lock reclaims dead owners but preserves malformed locks", () => {
	const { directory, taskPath, lockPath } = fixture();
	try {
		writeFileSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, token: randomUUID() })}\n`, {
			mode: 0o600,
		});
		const release = acquireTaskReviewLock(taskPath);
		assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
		release();
		assert.equal(existsSync(lockPath), false);

		writeFileSync(lockPath, "not-json\n", { mode: 0o600 });
		assert.throws(
			() => acquireTaskReviewLock(taskPath),
			/review lock is invalid.*confirming no review operation is running/,
		);
		assert.equal(readFileSync(lockPath, "utf8"), "not-json\n");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
