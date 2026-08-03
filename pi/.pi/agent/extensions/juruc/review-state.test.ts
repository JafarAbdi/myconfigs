import assert from "node:assert/strict";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	demoReviewPatch,
	demoReviewTask,
} from "./review-fixture.ts";
import { ReviewStateError, ReviewStore } from "./review-state.ts";
import { saveTaskDocument } from "./task.ts";

const validComment = {
	filePath: "src/greeting.ts",
	side: "additions" as const,
	startLine: 2,
	endLine: 3,
	body: "Keep the fallback and add a focused test.",
};

function fixture(prefix: string) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	const taskPath = join(directory, "task.json");
	saveTaskDocument(taskPath, demoReviewTask());
	return { directory, taskPath, patch: demoReviewPatch() };
}

test("task-backed review state reloads strict task.json and persists CRUD with mode 0600", () => {
	const { directory, taskPath, patch } = fixture("juruc-review-state-");
	try {
		const store = new ReviewStore(taskPath, patch);
		assert.equal(store.snapshot().agentAnnotations.length, 1);
		assert.equal(store.snapshot().agentAnnotations[0].source, "Deviation reviewer");
		for (const invalid of [
			{ ...validComment, endLine: 4 },
			{ ...validComment, side: "deletions" },
			{ ...validComment, filePath: ` ${validComment.filePath}` },
			{ ...validComment, filePath: "missing.ts" },
		]) assert.throws(() => store.addComment(invalid), ReviewStateError);

		const saved = store.addComment(validComment);
		const original = saved.humanComments[0];
		const updated = store.updateComment(original.id, { body: "  Revised feedback.  " });
		assert.deepEqual(updated.humanComments[0], { ...original, body: "Revised feedback." });
		assert.throws(
			() => store.updateComment(original.id, { body: "No.", startLine: 3 }),
			/invalid fields/,
		);
		assert.throws(
			() => store.updateComment("00000000-0000-4000-8000-000000000000", { body: "No." }),
			(error) => error instanceof ReviewStateError && error.status === 404,
		);
		assert.equal(statSync(taskPath).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(directory), ["task.json"]);
		assert.deepEqual(new ReviewStore(taskPath, patch).snapshot(), updated);

		assert.equal(store.deleteComment(original.id).humanComments.length, 0);
		assert.deepEqual(readdirSync(directory), ["task.json"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("decisions enforce comment guards and freeze authoritative rounds", () => {
	const feedback = fixture("juruc-review-feedback-");
	const approval = fixture("juruc-review-approval-");
	try {
		const feedbackStore = new ReviewStore(feedback.taskPath, feedback.patch);
		assert.throws(
			() => feedbackStore.decide("send-feedback"),
			(error) => error instanceof ReviewStateError && error.status === 409,
		);
		feedbackStore.addComment(validComment);
		assert.throws(
			() => feedbackStore.decide("approve"),
			(error) => error instanceof ReviewStateError && error.status === 409,
		);
		const completed = feedbackStore.decide("send-feedback");
		assert.equal(completed.decision?.kind, "send-feedback");
		assert.throws(
			() => feedbackStore.addComment(validComment),
			(error) => error instanceof ReviewStateError && error.status === 409,
		);
		assert.throws(() => feedbackStore.deleteComment(completed.humanComments[0].id), /completed decision/);
		assert.deepEqual(new ReviewStore(feedback.taskPath, feedback.patch).snapshot(), completed);

		const approved = new ReviewStore(approval.taskPath, approval.patch).decide("approve");
		assert.equal(approved.decision?.kind, "approve");
	} finally {
		rmSync(feedback.directory, { recursive: true, force: true });
		rmSync(approval.directory, { recursive: true, force: true });
	}
});

test("review readiness omits failures and rejects invalid projections", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-projection-"));
	const taskPath = join(directory, "task.json");
	const patch = demoReviewPatch();
	try {
		saveTaskDocument(taskPath, demoReviewTask({
			deviation: {
				status: "failed",
				failureKind: "malformed-output",
				message: "invalid JSON",
			},
			correctness: {
				status: "completed",
				annotations: [{
					filePath: "src/greeting.ts",
					side: "additions",
					line: 3,
					summary: "Concrete correctness issue.",
				}],
			},
		}));
		assert.deepEqual(new ReviewStore(taskPath, patch).snapshot().agentAnnotations.map(
			({ source }) => source,
		), ["Correctness reviewer"]);

		const invalid = demoReviewTask();
		const outcome = invalid.reviewRounds[0].reviewers.deviation!.outcome!;
		if (outcome.status === "completed") outcome.annotations[0].line = 1;
		saveTaskDocument(taskPath, invalid);
		assert.throws(() => new ReviewStore(taskPath, patch), /not a changed line/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("store detects stale authoritative patch identity on every snapshot", () => {
	const { directory, taskPath, patch } = fixture("juruc-review-stale-");
	try {
		const store = new ReviewStore(taskPath, patch);
		const changed = demoReviewTask();
		changed.repository.sourceHead = "3".repeat(40);
		changed.checkpoints[0].commit = "4".repeat(40);
		changed.reviewRounds[0].baseCommit = "3".repeat(40);
		changed.reviewRounds[0].headCommit = "4".repeat(40);
		saveTaskDocument(taskPath, changed);
		assert.throws(
			() => store.snapshot(),
			(error) => error instanceof ReviewStateError && error.status === 409,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
