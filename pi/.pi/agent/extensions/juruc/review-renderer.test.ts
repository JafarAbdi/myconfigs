import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	isFeedbackSubmitShortcut,
	isReviewDecisionDisabled,
	reviewCompletion,
	savedSidebarVisible,
	singleLineSelection,
	submitReviewDecision,
	targetFromComposedPath,
} from "./review-browser.js";
import {
	demoReviewPatch,
	demoReviewTask,
} from "./review-fixture.ts";
import { reviewPatchFromText } from "./review-git.ts";
import {
	DEFAULT_REVIEW_VIEW_OPTIONS,
	ReviewRenderer,
} from "./review-renderer.ts";
import { ReviewStore } from "./review-state.ts";
import { saveTaskDocument } from "./task.ts";

test("Pierre SSR output uses declarative Shadow DOM and grouped public annotation slots", async () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-render-"));
	try {
		const patch = demoReviewPatch();
		const taskPath = join(directory, "task.json");
		saveTaskDocument(taskPath, demoReviewTask());
		const store = new ReviewStore(taskPath, patch);
		store.addComment({
			filePath: "src/greeting.ts",
			side: "additions",
			startLine: 2,
			endLine: 3,
			body: "Add a regression test for whitespace-only input.",
		});
		const renderer = new ReviewRenderer(patch);
		const html = await renderer.render(
			store.snapshot(),
			DEFAULT_REVIEW_VIEW_OPTIONS,
			"/capability/",
		);

		assert.match(html, /<template shadowrootmode="open">/u);
		assert.match(html, /<style data-core-css="">/u);
		assert.match(html, /data-mode="stack"/u);
		assert.match(html, /data-layout="unified"/u);
		assert.match(html, /<body class="sidebar-hidden"/u);
		assert.match(html, /id="sidebar-toggle"[^>]*aria-checked="false"/u);
		assert.match(html, /<span class="option-check" aria-hidden="true"><\/span>/u);
		assert.match(html, /data-review-range="1{40}\.\.\.2{40}"/u);
		assert.doesNotMatch(html, /SHA-256|patch-digest/u);
		assert.match(html, /data-diff-type="single"/u);
		assert.match(html, /data-line-type="change-addition" data-column-number="2"/u);
		assert.match(html, /<span style="[^"]*--diffs-token/u);
		assert.match(html, /<slot name="annotation-additions-2"><\/slot>/u);
		assert.equal(
			html.match(
				/class="annotation-group" slot="annotation-additions-2"/gu,
			)?.length,
			1,
		);
		assert.match(html, />Agent note</u);
		assert.match(html, />Your feedback</u);
		assert.match(html, /class="edit-comment"/u);
		assert.match(html, /class="delete-comment"/u);
		assert.match(html, /data-decision="approve" disabled/u);
		assert.match(html, /data-indicators="bars"/u);
		assert.match(html, /href="#file-0"/u);
		assert.match(html, /class="additions">\+2/u);
		assert.match(html, /class="deletions">-1/u);
		assert.match(html, /<span id="save-comment-label">Save feedback<\/span> <kbd>Ctrl\/⌘ Enter<\/kbd>/u);
		assert.match(html, /src="\/capability\/review\.js"/u);
		assert.match(html, /href="\/capability\/review\.css"/u);
		assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//u);
		assert.doesNotMatch(html, /\bReact\b|from ["']react["']/u);

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
				agentNotes: false,
			},
			"/capability/",
		);
		assert.match(minimal, /data-diff-type="single"/u);
		assert.match(minimal, /data-disable-line-numbers=""/u);
		assert.match(minimal, /data-overflow="wrap"/u);
		assert.doesNotMatch(minimal, />Agent note</u);
		assert.match(minimal, />Your feedback</u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("renderer wires hunk metadata through Pierre SSR and its option cache", async () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-render-hunks-"));
	try {
		const patch = reviewPatchFromText(
			`diff --git a/example.txt b/example.txt
index 1111111..2222222 100644
--- a/example.txt
+++ b/example.txt
@@ -1,2 +1,2 @@
-old one
+new one
 context
@@ -10,2 +10,2 @@
-old two
+new two
 context
`,
			"1".repeat(40),
			"2".repeat(40),
		);
		const taskPath = join(directory, "task.json");
		saveTaskDocument(taskPath, demoReviewTask({
			deviation: { status: "completed", annotations: [] },
		}));
		const store = new ReviewStore(taskPath, patch);
		const renderer = new ReviewRenderer(patch);
		const withoutStyles = (html: string): string =>
			html.replaceAll(/<style[^>]*>[\s\S]*?<\/style>/gu, "");
		const headers = withoutStyles(await renderer.render(
			store.snapshot(),
			DEFAULT_REVIEW_VIEW_OPTIONS,
			"/capability/",
		));
		const noHeaders = withoutStyles(await renderer.render(
			store.snapshot(),
			{ ...DEFAULT_REVIEW_VIEW_OPTIONS, hunkHeaders: false },
			"/capability/",
		));
		assert.match(headers, /data-separator="metadata"/u);
		assert.doesNotMatch(noHeaders, /data-separator="metadata"/u);
		assert.match(noHeaders, /data-separator="simple"/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("renderer reports an empty cumulative patch clearly", async () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-render-empty-"));
	try {
		const patch = reviewPatchFromText("", "1".repeat(40), "2".repeat(40));
		const taskPath = join(directory, "task.json");
		const task = demoReviewTask({
			deviation: { status: "completed", annotations: [] },
		});
		task.repository.sourceHead = "1".repeat(40);
		task.checkpoints[0].commit = "2".repeat(40);
		task.reviewRounds[0].baseCommit = "1".repeat(40);
		task.reviewRounds[0].headCommit = "2".repeat(40);
		saveTaskDocument(taskPath, task);
		const store = new ReviewStore(taskPath, patch);
		const html = await new ReviewRenderer(patch).render(
			store.snapshot(),
			DEFAULT_REVIEW_VIEW_OPTIONS,
			"/capability/",
		);
		assert.match(html, /No changes to review/u);
		assert.match(html, /empty cumulative Git patch/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the sidebar stays hidden unless this review explicitly saved visible", () => {
	assert.equal(savedSidebarVisible(() => null), false);
	assert.equal(savedSidebarVisible(() => "hidden"), false);
	assert.equal(savedSidebarVisible(() => "visible"), true);
	assert.equal(savedSidebarVisible(() => {
		throw new Error("storage unavailable");
	}), false);
});

test("decision guards disable approval with comments and recover consistently", () => {
	assert.equal(isReviewDecisionDisabled("approve", { decision: null, humanComments: [] }), false);
	assert.equal(isReviewDecisionDisabled("approve", { decision: null, humanComments: [{}] }), true);
	assert.equal(isReviewDecisionDisabled("send-feedback", { decision: null, humanComments: [] }), true);
	assert.equal(isReviewDecisionDisabled("send-feedback", { decision: null, humanComments: [{}] }), false);
	assert.equal(isReviewDecisionDisabled("approve", {
		decision: { kind: "approve" },
		humanComments: [],
	}), true);
});

test("completion adapter exposes the terminal receipt labels", () => {
	assert.deepEqual(reviewCompletion("approve"), {
		label: "Approved",
		message: "Approved. Decision recorded; this tab may be closed.",
	});
	assert.deepEqual(reviewCompletion("send-feedback"), {
		label: "Feedback sent",
		message: "Feedback sent. Decision recorded; this tab may be closed.",
	});
});

test("successful decision submission completes in place without reload or re-fetch", async () => {
	const state = {
		decision: { kind: "approve", decidedAt: "2026-08-03T00:00:00.000Z" },
	};
	const requests: string[] = [];
	let completed;
	const returned = await submitReviewDecision(
		"approve",
		async (kind: string) => {
			requests.push(kind);
			return { state };
		},
		(value: unknown) => {
			completed = value;
		},
	);
	assert.deepEqual(requests, ["approve"]);
	assert.equal(completed, state);
	assert.equal(returned, state);
});

test("feedback submission requires Ctrl+Enter or Cmd+Enter", () => {
	assert.equal(isFeedbackSubmitShortcut({ key: "Enter", ctrlKey: true }), true);
	assert.equal(isFeedbackSubmitShortcut({ key: "Enter", metaKey: true }), true);
	assert.equal(
		isFeedbackSubmitShortcut({ key: "Enter", ctrlKey: true, altKey: true }),
		false,
	);
	assert.equal(isFeedbackSubmitShortcut({ key: "Enter" }), false);
	assert.equal(isFeedbackSubmitShortcut({ key: " ", ctrlKey: true }), false);
});

test("the tiny browser adapter maps only Pierre changed-line composed paths", () => {
	const target = targetFromComposedPath([
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
	assert.deepEqual(
		targetFromComposedPath([
			{ dataset: { columnNumber: "2", lineType: "change-deletion" } },
			{ dataset: { filePath: "src/greeting.ts" } },
		]),
		{ filePath: "src/greeting.ts", side: "deletions", line: 2 },
	);
	assert.equal(
		targetFromComposedPath([
			{ dataset: { line: "1", lineType: "context" } },
			{ dataset: { filePath: "src/greeting.ts" } },
		]),
		undefined,
	);
	assert.equal(
		targetFromComposedPath([
			{ dataset: { line: "2", lineType: "change-addition" } },
		]),
		undefined,
	);
});
