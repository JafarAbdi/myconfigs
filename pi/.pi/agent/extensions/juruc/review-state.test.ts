import assert from "node:assert/strict";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEMO_AGENT_ANNOTATIONS,
	demoReviewPatch,
} from "./review-fixture.ts";
import {
	parseReviewState,
	ReviewStore,
} from "./review-state.ts";

const validComment = {
	filePath: "src/greeting.ts",
	side: "additions" as const,
	startLine: 2,
	endLine: 3,
	body: "Keep the fallback and add a focused test.",
};

test("review state validates changed targets and persists atomically with mode 0600", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-state-"));
	try {
		const path = join(directory, "review.json");
		const patch = demoReviewPatch();
		const store = new ReviewStore(path, patch, DEMO_AGENT_ANNOTATIONS);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(store.snapshot().agentAnnotations.length, 1);

		assert.throws(
			() =>
				store.addComment({
					...validComment,
					endLine: 4,
				}),
			/not a changed line/,
		);
		assert.throws(
			() => store.addComment({ ...validComment, side: "deletions" }),
			/not a changed line/,
		);
		assert.throws(
			() => store.addComment({ ...validComment, filePath: "missing.ts" }),
			/not in this patch/,
		);

		const saved = store.addComment(validComment);
		assert.equal(saved.humanComments.length, 1);
		const original = saved.humanComments[0];
		const updated = store.updateComment(original.id, { body: "  Revised feedback.  " });
		assert.deepEqual(updated.humanComments[0], {
			...original,
			body: "Revised feedback.",
		});
		assert.throws(
			() => store.updateComment(original.id, { body: "No.", startLine: 3 }),
			/invalid fields/,
		);
		assert.throws(
			() => store.updateComment("00000000-0000-4000-8000-000000000000", { body: "No." }),
			/not found/,
		);
		assert.deepEqual(readdirSync(directory), ["review.json"]);
		assert.deepEqual(
			parseReviewState(readFileSync(path, "utf8"), patch),
			updated,
		);

		const restarted = new ReviewStore(path, patch);
		assert.deepEqual(restarted.snapshot(), updated);
		assert.equal(statSync(path).mode & 0o777, 0o600);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("review decisions are explicit, final, and guard Send Feedback", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-decision-"));
	try {
		const patch = demoReviewPatch();
		const feedbackPath = join(directory, "feedback.json");
		const feedback = new ReviewStore(feedbackPath, patch);
		assert.throws(
			() => feedback.decide("send-feedback"),
			/at least one saved human comment/,
		);
		feedback.addComment(validComment);
		const completed = feedback.decide("send-feedback");
		assert.equal(completed.decision?.kind, "send-feedback");
		assert.throws(() => feedback.addComment(validComment), /already has a completed decision/);
		assert.throws(
			() => feedback.updateComment(completed.humanComments[0].id, { body: "Too late." }),
			/already has a completed decision/,
		);
		assert.throws(
			() => feedback.deleteComment(completed.humanComments[0].id),
			/already has a completed decision/,
		);
		assert.throws(() => feedback.decide("approve"), /already has a completed decision/);
		assert.deepEqual(new ReviewStore(feedbackPath, patch).snapshot(), completed);

		const approval = new ReviewStore(join(directory, "approval.json"), patch);
		assert.equal(approval.decide("approve").decision?.kind, "approve");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("persisted review state rejects extra fields and a different patch", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-invalid-"));
	try {
		const patch = demoReviewPatch();
		const path = join(directory, "review.json");
		const store = new ReviewStore(path, patch);
		writeFileSync(path, JSON.stringify({ ...store.snapshot(), unexpected: true }));
		assert.throws(() => new ReviewStore(path, patch), /invalid fields/);

		writeFileSync(
			path,
			JSON.stringify({
				...store.snapshot(),
				patch: { ...store.snapshot().patch, headOid: "3".repeat(40) },
			}),
		);
		assert.throws(() => new ReviewStore(path, patch), /different patch/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
