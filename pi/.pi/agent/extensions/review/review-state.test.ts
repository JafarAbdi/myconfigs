import assert from "node:assert/strict";
import test from "node:test";
import type { AuditFinding } from "./audit.ts";
import { reviewPatchFromText } from "./review-git.ts";
import {
	formatReviewFeedback,
	MAX_REVIEW_AGGREGATE_COMMENT_BYTES,
	MAX_REVIEW_COMMENTS,
	ReviewStateError,
	ReviewStore,
} from "./review-state.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
-old one
-old two
+new one
+new two
+new three
 context

diff --git a/src/z.ts b/src/z.ts
index 1111111..2222222 100644
--- a/src/z.ts
+++ b/src/z.ts
@@ -1 +1 @@
-before
+after
`;

function patch() {
	return reviewPatchFromText(PATCH, "/repository", "2".repeat(40));
}

function finding(overrides: Partial<AuditFinding> = {}): AuditFinding {
	return {
		category: "correctness",
		filePath: "src/a.ts",
		side: "additions",
		line: 2,
		message: "The new branch returns the wrong value.",
		...overrides,
	};
}

const comment = {
	filePath: "src/a.ts",
	side: "additions" as const,
	startLine: 1,
	endLine: 3,
	body: "Keep this range coherent.",
};

function deterministicStore(findings: readonly AuditFinding[] = []) {
	const times = [
		"2026-01-01T00:00:00.000Z",
		"2026-01-01T00:00:01.000Z",
		"2026-01-01T00:00:02.000Z",
		"2026-01-01T00:00:03.000Z",
	];
	const ids = ["comment-1", "comment-2", "comment-3"];
	return new ReviewStore(patch(), findings, {
		clock: () => times.shift()!,
		idFactory: () => ids.shift()!,
	});
}

function boundedStore() {
	let nextId = 0;
	return new ReviewStore(patch(), [], {
		clock: () => "2026-01-01T00:00:00.000Z",
		idFactory: () => `comment-${nextId += 1}`,
	});
}

test("state clones immutable snapshot identity and audit findings", () => {
	const sourcePatch = patch();
	const sourceFinding = finding();
	const store = new ReviewStore(sourcePatch, [sourceFinding]);
	sourceFinding.message = "mutated input";
	const first = store.snapshot();
	assert.deepEqual(first.snapshot, { headOid: "2".repeat(40) });
	assert.equal(first.auditFindings[0].message, "The new branch returns the wrong value.");
	first.snapshot.headOid = "3".repeat(40);
	first.auditFindings[0].message = "mutated snapshot";
	assert.deepEqual(store.snapshot().snapshot, { headOid: "2".repeat(40) });
	assert.equal(store.snapshot().auditFindings[0].message, "The new branch returns the wrong value.");
	assert.throws(
		() => new ReviewStore(patch(), [finding({ line: 4 })]),
		/not a changed line/u,
	);
});

test("comment CRUD validates exact changed lines and uses injectable identity factories", () => {
	const store = deterministicStore();
	for (const invalid of [
		{ ...comment, endLine: 4 },
		{ ...comment, startLine: 3, endLine: 2 },
		{ ...comment, side: "deletions" as const, startLine: 3, endLine: 3 },
		{ ...comment, filePath: "missing.ts" },
		{ ...comment, filePath: ` ${comment.filePath}` },
	]) assert.throws(() => store.addComment(invalid), ReviewStateError);

	const added = store.addComment(comment).humanComments[0];
	assert.deepEqual(added, {
		...comment,
		id: "comment-1",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	const updated = store.updateComment(added.id, { body: "  Revised.  " }).humanComments[0];
	assert.deepEqual(updated, {
		...added,
		body: "Revised.",
		updatedAt: "2026-01-01T00:00:01.000Z",
	});
	assert.throws(() => store.updateComment(added.id, { body: "No.", line: 2 }), /invalid fields/u);
	assert.throws(
		() => store.updateComment("missing", { body: "No." }),
		(error) => error instanceof ReviewStateError && error.status === 404,
	);
	assert.equal(store.deleteComment(added.id).humanComments.length, 0);
	assert.throws(
		() => store.deleteComment(added.id),
		(error) => error instanceof ReviewStateError && error.status === 404,
	);
});

test("comment count is bounded", () => {
	const store = boundedStore();
	for (let index = 0; index < MAX_REVIEW_COMMENTS; index += 1)
		store.addComment({ ...comment, body: `Comment ${index}.` });
	assert.equal(store.snapshot().humanComments.length, MAX_REVIEW_COMMENTS);
	assert.throws(
		() => store.addComment({ ...comment, body: "One too many." }),
		(error) => error instanceof ReviewStateError && error.status === 413,
	);
});

test("aggregate UTF-8 comment bytes are bounded on add and update", () => {
	const store = boundedStore();
	for (let index = 0; index < 26; index += 1)
		store.addComment({ ...comment, body: "a".repeat(10_000) });
	const last = store.addComment({ ...comment, body: "b".repeat(2_144) }).humanComments.at(-1)!;
	assert.equal(26 * 10_000 + Buffer.byteLength(last.body), MAX_REVIEW_AGGREGATE_COMMENT_BYTES);
	assert.throws(
		() => store.addComment({ ...comment, body: "x" }),
		(error) => error instanceof ReviewStateError && error.status === 413,
	);

	const sameBytes = "é".repeat(1_072);
	assert.equal(store.updateComment(last.id, { body: sameBytes }).humanComments.at(-1)?.body, sameBytes);
	assert.throws(
		() => store.updateComment(last.id, { body: "€".repeat(1_072) }),
		(error) => error instanceof ReviewStateError && error.status === 413,
	);
	assert.equal(store.snapshot().humanComments.at(-1)?.body, sameBytes);
});

test("decision rules distinguish advisory findings from blocking human comments", () => {
	assert.throws(
		() => deterministicStore().decide("send-feedback"),
		(error) => error instanceof ReviewStateError && error.status === 409,
	);
	const advisory = deterministicStore([finding()]);
	assert.equal(advisory.decide("approve").decision?.kind, "approve");
	assert.throws(() => advisory.addComment(comment), /terminal decision/u);
	assert.throws(() => advisory.decide("approve"), /terminal decision/u);

	const comments = deterministicStore();
	comments.addComment(comment);
	assert.throws(
		() => comments.decide("approve"),
		(error) => error instanceof ReviewStateError && error.status === 409,
	);
	const feedback = comments.decide("send-feedback");
	assert.deepEqual(feedback.decision, {
		kind: "send-feedback",
		decidedAt: "2026-01-01T00:00:01.000Z",
	});
	assert.throws(() => comments.updateComment("comment-1", { body: "late" }), /terminal decision/u);
	assert.throws(() => comments.deleteComment("comment-1"), /terminal decision/u);
});

test("feedback Markdown is exact and sorted by path, side, then line", () => {
	const store = deterministicStore([
		finding({
			filePath: "src/z.ts",
			line: 1,
			message: "Z finding.",
		}),
		finding({
			side: "deletions",
			line: 2,
			message: "Old-side finding.",
		}),
		finding(),
	]);
	store.addComment({
		filePath: "src/z.ts",
		side: "deletions",
		startLine: 1,
		endLine: 1,
		body: "Z comment.",
	});
	store.addComment({
		filePath: "src/a.ts",
		side: "additions",
		startLine: 2,
		endLine: 3,
		body: "A comment.",
	});
	assert.equal(formatReviewFeedback(store.snapshot()), `# Review feedback

## Audit findings
- src/a.ts:new L2 — The new branch returns the wrong value.
- src/a.ts:old L2 — Old-side finding.
- src/z.ts:new L1 — Z finding.

## Human comments
- src/a.ts:new L2-3 — A comment.
- src/z.ts:old L1 — Z comment.
`);
});
