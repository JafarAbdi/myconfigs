import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	isFeedbackSubmitShortcut,
	isReviewDecisionDisabled,
	reviewCompletion,
	singleLineSelection,
	submitReviewDecision,
	targetFromComposedPath,
} from "./review-browser.js";
import { demoAuditFinding, demoReviewPatch } from "./review-fixture.ts";
import { reviewPatchFromText } from "./review-git.ts";
import {
	DEFAULT_REVIEW_VIEW_OPTIONS,
	ReviewRenderer,
} from "./review-renderer.ts";
import { ReviewStore } from "./review-state.ts";

function storeWithFinding() {
	return new ReviewStore(demoReviewPatch(), [demoAuditFinding()], {
		clock: () => "2026-08-03T00:00:00.000Z",
		idFactory: () => "comment-1",
	});
}

test("Pierre SSR stays selectable and renders the audit message at its exact changed line", async () => {
	const patch = demoReviewPatch();
	const html = await new ReviewRenderer(patch).render(
		storeWithFinding().snapshot(),
		DEFAULT_REVIEW_VIEW_OPTIONS,
		"/capability/",
	);

	assert.match(html, /<template shadowrootmode="open">/u);
	assert.match(html, /<style data-core-css="">/u);
	assert.match(html, /<style data-unsafe-css="">[\s\S]*user-select: text/u);
	assert.match(html, /\[data-utility-button\]/u);
	assert.match(html, /data-diff-type="single"/u);
	assert.match(html, /data-line-type="change-addition" data-column-number="2"/u);
	assert.match(html, /<span style="[^"]*--diffs-token/u);
	assert.match(html, /<slot name="annotation-additions-2"><\/slot>/u);
	assert.equal(
		html.match(/class="annotation-group" slot="annotation-additions-2"/gu)?.length,
		1,
	);
	assert.match(html, />Audit finding</u);
	assert.match(html, />correctness · new L2</u);
	assert.match(html, /class="finding-message">Whitespace-only names now take a new fallback path\.<\/p>/u);
	assert.doesNotMatch(html, /finding-details|Evidence|Failure|Repair/u);
	assert.match(html, /data-decision="approve">Approve<\/button>/u);
	assert.match(html, /data-decision="send-feedback">Send Feedback<\/button>/u);
	assert.match(html, />Audit findings<\/span><kbd>a<\/kbd>/u);
	assert.match(html, />Staged diff</u);
	assert.match(html, /<title>Review<\/title>/u);
	assert.doesNotMatch(html, /cumulative|Agent note|data-review-range/u);
	assert.match(html, /src="\/capability\/review\.js"/u);
	assert.match(html, /href="\/capability\/review\.css"/u);
	assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//u);
});

test("human comments alone block Approve while findings remain advisory", async () => {
	const patch = demoReviewPatch();
	const store = storeWithFinding();
	store.addComment({
		filePath: "src/greeting.ts",
		side: "additions",
		startLine: 2,
		endLine: 3,
		body: "Add a regression test for whitespace-only input.",
	});
	const html = await new ReviewRenderer(patch).render(
		store.snapshot(),
		DEFAULT_REVIEW_VIEW_OPTIONS,
		"/capability/",
	);
	assert.match(html, />Your comment</u);
	assert.match(html, /class="edit-comment"/u);
	assert.match(html, /class="delete-comment"/u);
	assert.match(html, /data-decision="approve" disabled>Approve/u);
	assert.match(html, /data-decision="send-feedback">Send Feedback/u);

	const empty = await new ReviewRenderer(patch).render(
		new ReviewStore(patch).snapshot(),
		DEFAULT_REVIEW_VIEW_OPTIONS,
		"/capability/",
	);
	assert.match(empty, /data-decision="send-feedback" disabled>Send Feedback/u);
});

test("view controls render fresh bounded SSR variants without persistent cache state", async () => {
	const patch = demoReviewPatch();
	const store = storeWithFinding();
	store.addComment({
		filePath: "src/greeting.ts",
		side: "additions",
		startLine: 3,
		endLine: 3,
		body: "Keep punctuation consistent.",
	});
	const renderer = new ReviewRenderer(patch);
	const split = await renderer.render(
		store.snapshot(),
		{ ...DEFAULT_REVIEW_VIEW_OPTIONS, mode: "split" },
		"/capability/",
	);
	assert.match(split, /data-diff-type="split"/u);

	const minimal = await renderer.render(
		store.snapshot(),
		{
			mode: "stack",
			lineNumbers: false,
			wrap: true,
			hunkHeaders: false,
			auditFindings: false,
		},
		"/capability/",
	);
	assert.match(minimal, /data-disable-line-numbers=""/u);
	assert.match(minimal, /data-overflow="wrap"/u);
	assert.match(minimal, /data-separator="simple"/u);
	assert.doesNotMatch(minimal, />Audit finding</u);
	assert.match(minimal, />Your comment</u);
	assert.match(minimal, /audit-findings=off/u);
	assert.equal(
		Object.values(renderer as unknown as Record<string, unknown>)
			.some((value) => value instanceof Map),
		false,
	);
});

test("completed decisions render a read-only receipt", async () => {
	const patch = demoReviewPatch();
	const store = storeWithFinding();
	store.decide("approve");
	const html = await new ReviewRenderer(patch).render(
		store.snapshot(),
		DEFAULT_REVIEW_VIEW_OPTIONS,
		"/capability/",
	);
	assert.match(html, />Approved<\/div>/u);
	assert.match(html, /Approved\. Decision recorded; this tab may be closed\./u);
	assert.match(html, /Read-only completion receipt\./u);
	assert.match(html, /data-decision="approve" disabled/u);
	assert.match(html, /data-decision="send-feedback" disabled/u);
	assert.doesNotMatch(html, /class="edit-comment"|class="delete-comment"/u);
});

test("renderer reports an empty staged patch clearly", async () => {
	const patch = reviewPatchFromText("", "/repository", "2".repeat(40));
	const html = await new ReviewRenderer(patch).render(
		new ReviewStore(patch).snapshot(),
		DEFAULT_REVIEW_VIEW_OPTIONS,
		"/capability/",
	);
	assert.match(html, /No staged changes to review/u);
	assert.match(html, /exact staged Git patch is empty/u);
});

test("browser guards account for findings, comments, and terminal receipts", () => {
	assert.equal(isReviewDecisionDisabled("approve", {
		decision: null,
		auditFindings: [{}],
		humanComments: [],
	}), false);
	assert.equal(isReviewDecisionDisabled("approve", {
		decision: null,
		auditFindings: [],
		humanComments: [{}],
	}), true);
	assert.equal(isReviewDecisionDisabled("send-feedback", {
		decision: null,
		auditFindings: [],
		humanComments: [],
	}), true);
	assert.equal(isReviewDecisionDisabled("send-feedback", {
		decision: null,
		auditFindings: [{}],
		humanComments: [],
	}), false);
	assert.equal(isReviewDecisionDisabled("approve", {
		decision: { kind: "approve" },
		auditFindings: [],
		humanComments: [],
	}), true);
	assert.deepEqual(reviewCompletion("approve"), {
		label: "Approved",
		message: "Approved. Decision recorded; this tab may be closed.",
	});
	assert.deepEqual(reviewCompletion("send-feedback"), {
		label: "Feedback sent",
		message: "Feedback sent. Decision recorded; this tab may be closed.",
	});
});

test("a failed decision remains incomplete for the browser to display", async () => {
	let completed = false;
	await assert.rejects(
		submitReviewDecision(
			"approve",
			async () => { throw new Error("Review is stale: HEAD changed; run /review again."); },
			() => { completed = true; },
		),
		/Review is stale: HEAD changed/u,
	);
	assert.equal(completed, false);
});

test("plain browser code uses explicit changed-line gutters", () => {
	const source = readFileSync(new URL("./review-browser.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /reviewRange|data\.reviewRange/u);
	assert.match(source, /data-gutter/u);
	assert.match(source, /change-addition/u);
	assert.match(source, /change-deletion/u);
	assert.match(source, /button\.textContent = "\+"/u);

	const target = targetFromComposedPath([
		{ dataset: { utilityButton: "" } },
		{ dataset: { line: "3", lineType: "change-addition" } },
		{ dataset: { content: "" } },
		{ dataset: { filePath: "src/greeting.ts" } },
	]);
	assert.deepEqual(target, {
		filePath: "src/greeting.ts",
		side: "additions",
		line: 3,
	});
	assert.deepEqual(singleLineSelection(target), {
		filePath: "src/greeting.ts",
		side: "additions",
		startLine: 3,
		endLine: 3,
	});
	assert.equal(targetFromComposedPath([
		{ dataset: { line: "3", lineType: "change-addition" } },
		{ dataset: { filePath: "src/greeting.ts" } },
	]), undefined);
	assert.equal(targetFromComposedPath([
		{ dataset: { utilityButton: "" } },
		{ dataset: { line: "1", lineType: "context" } },
		{ dataset: { filePath: "src/greeting.ts" } },
	]), undefined);
});

test("comment shortcut stays application-owned", () => {
	assert.equal(isFeedbackSubmitShortcut({ key: "Enter", ctrlKey: true }), true);
	assert.equal(isFeedbackSubmitShortcut({ key: "Enter", metaKey: true }), true);
	assert.equal(isFeedbackSubmitShortcut({ key: "Enter", ctrlKey: true, altKey: true }), false);
	assert.equal(isFeedbackSubmitShortcut({ key: "Enter" }), false);
});
