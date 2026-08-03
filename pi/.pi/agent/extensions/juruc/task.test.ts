import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acceptTaskPlan,
	activateTaskPlan,
	addTaskReviewComment,
	appendTaskSession,
	completeTaskCorrection,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	currentTaskCorrectionRound,
	currentTaskPhase,
	currentTaskReviewRound,
	decideTaskReview,
	deleteTaskReviewComment,
	findTaskSession,
	loadTaskDocument,
	parseTaskDocument,
	registerTaskCorrectionStart,
	registerTaskReviewerStart,
	saveTaskDocument,
	serializeTaskDocument,
	TASK_VERSION,
	updateTaskReviewComment,
	type NewTaskInput,
	type ReviewerOutcome,
	type TaskDocument,
	type TaskPhase,
	type TaskPlan,
	type TaskQuestions,
	type TaskSpecification,
} from "./task.ts";

const oid = (digit: string): string => digit.repeat(40);
const questions: TaskQuestions = {
	sharedUnderstanding: "Build the confirmed workflow.",
	decisions: ["Keep the API small."],
	acceptedAssumptions: ["One operator owns the task."],
	researchTargets: [],
};
const specification: TaskSpecification = {
	summary: "Implement the confirmed workflow.",
	requirements: ["The workflow advances automatically."],
	nonGoals: ["No remote publication."],
	constraints: ["Keep strict persisted state."],
	acceptanceCriteria: ["Focused tests pass."],
	decisions: ["Use local commits."],
};
const first: TaskPhase = {
	id: "build-core",
	title: "Build core",
	goal: "Implement the core.",
	fileScopes: ["src/**", "test/core.test.ts"],
	instructions: ["Implement the smallest core.", "Add focused tests."],
	verification: ["node --test test/core.test.ts"],
};
const second: TaskPhase = {
	id: "connect-workflow",
	title: "Connect workflow",
	goal: "Connect the core.",
	fileScopes: ["src/index.ts"],
	instructions: ["Wire the core into the workflow."],
	verification: ["npm test"],
};
const plan: TaskPlan = { phases: [first, second] };
const completed: ReviewerOutcome = { status: "completed", annotations: [] };
const failed: ReviewerOutcome = {
	status: "failed",
	failureKind: "session-error",
	message: "provider unavailable",
};
const now = "2026-08-03T00:00:00.000Z";
const commentId = "12345678-1234-4234-8234-123456789abc";
const correctionEvidence = [{ command: "npm test", exitCode: 0, summary: "Correction passed." }];

function input(): NewTaskInput {
	return {
		slug: "small-task",
		title: "Small task",
		request: "Make the workflow smaller.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: oid("1"),
			branch: "small-task",
			worktree: "/runtime/worktrees/small-task",
		},
	};
}

function implementationTask(): TaskDocument {
	let task = createTaskDocument(input());
	task = confirmTaskQuestions(task, questions);
	task = completeTaskResearch(task);
	task = confirmTaskSpecification(task, specification);
	return activateTaskPlan(acceptTaskPlan(task, plan));
}

function finishImplementation(): TaskDocument {
	let task = appendTaskSession(implementationTask(), {
		kind: "implementation",
		phase: 1,
		path: "/sessions/implementation-1.jsonl",
	});
	task = completeTaskPhase(
		task,
		"Core complete.",
		[{ command: first.verification[0], exitCode: 0, summary: "Passed." }],
		oid("2"),
	);
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 2,
		path: "/sessions/implementation-2.jsonl",
	});
	return completeTaskPhase(
		task,
		"Workflow complete.",
		[{ command: second.verification[0], exitCode: 0, summary: "Passed." }],
		oid("3"),
	);
}

function terminalReview(): TaskDocument {
	let task = finishImplementation();
	task = registerTaskReviewerStart(task, "deviation", "/sessions/deviation-1.jsonl");
	task = completeTaskReviewer(task, "deviation", completed);
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness-1.jsonl");
	return completeTaskReviewer(task, "correctness", failed);
}

test("version 6 task.json round-trips atomically from Questions", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-task-"));
	try {
		const path = join(directory, "task.json");
		const task = createTaskDocument(input());
		assert.equal(task.version, TASK_VERSION);
		assert.equal(task.stage, "questions");
		assert.deepEqual(task.reviewRounds, []);
		saveTaskDocument(path, task);
		assert.deepEqual(loadTaskDocument(path), task);
		assert.equal(readFileSync(path, "utf8"), serializeTaskDocument(task));
		assert.equal(lstatSync(path).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(directory), ["task.json"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("strict forward transitions produce Q to R to S to P to I", () => {
	let task = createTaskDocument(input());
	assert.throws(() => completeTaskResearch(task), /not researching/);
	task = confirmTaskQuestions(task, questions);
	assert.equal(task.stage, "research");
	task = completeTaskResearch(task);
	assert.equal(task.stage, "specification");
	task = confirmTaskSpecification(task, specification);
	assert.equal(task.stage, "plan");
	task = acceptTaskPlan(task, plan);
	assert.deepEqual(acceptTaskPlan(task, structuredClone(plan)), task);
	assert.throws(
		() => acceptTaskPlan(task, { phases: [{ ...first, goal: "Changed." }, second] }),
		/immutable/,
	);
	task = activateTaskPlan(task);
	assert.equal(task.stage, "implementation");
	assert.deepEqual(currentTaskPhase(task), first);
});

test("final checkpoint atomically creates the exact first review round", () => {
	const task = finishImplementation();
	assert.equal(task.stage, "review");
	assert.equal(task.checkpoints.length, 2);
	assert.deepEqual(currentTaskReviewRound(task), {
		number: 1,
		baseCommit: oid("1"),
		headCommit: oid("3"),
		reviewers: { deviation: null, correctness: null },
		humanComments: [],
		decision: null,
		correction: null,
	});
	assert.equal(findTaskSession(task, { kind: "implementation", phase: 2 })?.path,
		"/sessions/implementation-2.jsonl");
});

test("reviewer registration is atomic, ordered, typed, exact, and one-way", () => {
	let task = finishImplementation();
	assert.throws(
		() => registerTaskReviewerStart(task, "correctness", "/sessions/correctness-1.jsonl"),
		/requires a terminal deviation outcome/,
	);
	task = registerTaskReviewerStart(task, "deviation", "/sessions/deviation-1.jsonl");
	assert.deepEqual(currentTaskReviewRound(task)?.reviewers.deviation, {
		sessionPath: "/sessions/deviation-1.jsonl",
		outcome: null,
	});
	assert.equal(findTaskSession(task, { kind: "deviation-review", round: 1 })?.path,
		"/sessions/deviation-1.jsonl");
	assert.throws(
		() => registerTaskReviewerStart(task, "deviation", "/sessions/deviation-2.jsonl"),
		/already started/,
	);
	const unordered = structuredClone(task);
	unordered.sessions.push({
		kind: "correctness-review",
		round: 1,
		path: "/sessions/correctness-1.jsonl",
	});
	unordered.reviewRounds[0].reviewers.correctness = {
		sessionPath: "/sessions/correctness-1.jsonl",
		outcome: null,
	};
	assert.throws(() => parseTaskDocument(JSON.stringify(unordered)), /invalid/);

	task = completeTaskReviewer(task, "deviation", completed);
	assert.throws(() => completeTaskReviewer(task, "deviation", failed), /already complete/);
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness-1.jsonl");
	assert.equal(currentTaskReviewRound(task)?.reviewers.correctness?.outcome, null);
});

test("comments preserve immutable fields and decisions freeze the round", () => {
	let task = terminalReview();
	assert.throws(() => decideTaskReview(task, "send-feedback", now), /at least one/);
	task = addTaskReviewComment(task, {
		filePath: "src/index.ts",
		side: "additions",
		startLine: 4,
		endLine: 5,
		body: "Fix the changed range.",
	}, commentId, now);
	const original = currentTaskReviewRound(task)!.humanComments[0];
	task = updateTaskReviewComment(task, commentId, "  Revise the changed range.  ");
	assert.deepEqual(currentTaskReviewRound(task)!.humanComments[0], {
		...original,
		body: "Revise the changed range.",
	});
	assert.throws(() => decideTaskReview(task, "approve", now), /zero saved/);
	task = decideTaskReview(task, "send-feedback", now);
	assert.equal(task.stage, "review");
	assert.throws(() => deleteTaskReviewComment(task, commentId), /completed decision/);
	assert.throws(() => updateTaskReviewComment(task, commentId, "Too late."), /completed decision/);
	assert.throws(() => decideTaskReview(task, "send-feedback", now), /completed decision/);

	let approval = terminalReview();
	approval = decideTaskReview(approval, "approve", now);
	assert.equal(approval.stage, "done");
	assert.equal(approval.reviewRounds.at(-1)?.correction, null);
	assert.throws(
		() => parseTaskDocument(JSON.stringify({ ...approval, stage: "review" })),
		/invalid/,
	);
	assert.throws(() => registerTaskCorrectionStart(approval, "/sessions/correction-1.jsonl"), /no current review round/);
});

test("corrections append fresh cumulative rounds and freeze completed ones", () => {
	let task = decideTaskReview(
		addTaskReviewComment(terminalReview(), {
			filePath: "src/index.ts",
			side: "additions",
			startLine: 4,
			endLine: 4,
			body: "Fix the changed line.",
		}, commentId, now),
		"send-feedback",
		now,
	);
	assert.equal(currentTaskCorrectionRound(task), undefined);
	assert.throws(() => completeTaskCorrection(task, "Fixed.", correctionEvidence, oid("4")), /has not started/);

	task = registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl");
	assert.deepEqual(currentTaskReviewRound(task)?.correction, {
		sessionPath: "/sessions/correction-1.jsonl",
		result: null,
	});
	assert.equal(currentTaskCorrectionRound(task)?.number, 1);
	assert.equal(findTaskSession(task, { kind: "correction", round: 1 })?.path, "/sessions/correction-1.jsonl");
	assert.throws(() => registerTaskCorrectionStart(task, "/sessions/correction-2.jsonl"), /already started/);

	const frozen = structuredClone(task.reviewRounds[0]);
	task = completeTaskCorrection(task, "Fixed the changed line.", correctionEvidence, oid("4"));
	assert.equal(task.stage, "review");
	assert.equal(task.reviewRounds.length, 2);
	assert.deepEqual(task.reviewRounds[0], {
		...frozen,
		correction: {
			sessionPath: "/sessions/correction-1.jsonl",
			result: { resolution: "Fixed the changed line.", verificationEvidence: correctionEvidence, commit: oid("4") },
		},
	});
	assert.deepEqual(task.reviewRounds[1], {
		number: 2,
		baseCommit: oid("1"),
		headCommit: oid("4"),
		reviewers: { deviation: null, correctness: null },
		humanComments: [],
		decision: null,
		correction: null,
	});
	assert.throws(() => completeTaskCorrection(task, "Again.", correctionEvidence, oid("5")), /no Send Feedback decision/);
	assert.throws(() => deleteTaskReviewComment(task, commentId), /not found/);
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(task)), task);

	let second = registerTaskReviewerStart(task, "deviation", "/sessions/deviation-2.jsonl");
	second = completeTaskReviewer(second, "deviation", completed);
	second = registerTaskReviewerStart(second, "correctness", "/sessions/correctness-2.jsonl");
	second = completeTaskReviewer(second, "correctness", completed);
	second = decideTaskReview(second, "approve", now);
	assert.equal(second.stage, "done");
	assert.equal(second.reviewRounds.length, 2);
});

test("multi-round review shapes reject broken chains, sessions, and mutated history", () => {
	let task = decideTaskReview(
		addTaskReviewComment(terminalReview(), {
			filePath: "src/index.ts",
			side: "additions",
			startLine: 4,
			endLine: 4,
			body: "Fix the changed line.",
		}, commentId, now),
		"send-feedback",
		now,
	);
	task = registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl");
	const running = structuredClone(task);
	task = completeTaskCorrection(task, "Fixed.", correctionEvidence, oid("4"));

	const rounds = () => structuredClone(task.reviewRounds);
	for (const changed of [
		// a later round must start from the previous round's correction commit
		{ ...task, reviewRounds: rounds().map((round, index) => index === 1 ? { ...round, headCommit: oid("9") } : round) },
		// every round is based on sourceHead
		{ ...task, reviewRounds: rounds().map((round, index) => index === 1 ? { ...round, baseCommit: oid("4") } : round) },
		// a nonfinal round must have a completed correction
		{ ...task, reviewRounds: rounds().map((round, index) => index === 0 ? { ...round, correction: null } : round) },
		// the last round may not carry a completed correction
		{ ...task, reviewRounds: [rounds()[0]] },
		// a correction slot needs its exact recorded session
		{ ...task, sessions: task.sessions.filter((run) => run.kind !== "correction") },
		// correction evidence must be nonzero-free and nonempty
		{
			...task,
			reviewRounds: rounds().map((round, index) =>
				index === 0
					? { ...round, correction: { ...round.correction!, result: { ...round.correction!.result!, verificationEvidence: [] } } }
					: round),
		},
		// a running correction cannot exist without its Send Feedback decision
		{ ...running, reviewRounds: [{ ...running.reviewRounds[0], decision: null }] },
	]) assert.throws(() => parseTaskDocument(JSON.stringify(changed)), /invalid/);
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(running)), running);
});

test("persisted correction evidence must use accepted verification commands", () => {
	let task = decideTaskReview(
		addTaskReviewComment(terminalReview(), {
			filePath: "src/index.ts",
			side: "additions",
			startLine: 4,
			endLine: 4,
			body: "Fix the changed line.",
		}, commentId, now),
		"send-feedback",
		now,
	);
	task = registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl");
	task = completeTaskCorrection(task, "Fixed.", correctionEvidence, oid("4"));
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(task)), task);

	const rounds = structuredClone(task.reviewRounds);
	rounds[0].correction!.result!.verificationEvidence[0].command = "npm run lint";
	assert.throws(() => parseTaskDocument(JSON.stringify({ ...task, reviewRounds: rounds })), /invalid/);
});

test("review and legacy shapes are rejected strictly", () => {
	const fresh = createTaskDocument(input());
	for (const old of [
		{ ...fresh, version: 4 },
		Object.fromEntries(Object.entries(fresh).filter(([key]) => key !== "reviewRounds")),
		{ ...fresh, reviewRounds: [{}] },
		{ ...fresh, stage: "review" },
		{ ...fresh, blockReason: null },
	]) assert.throws(() => parseTaskDocument(JSON.stringify(old)), /invalid/);

	const review = terminalReview();
	for (const changed of [
		{ ...review, reviewRounds: [{ ...review.reviewRounds[0], number: 2 }] },
		{ ...review, reviewRounds: [{ ...review.reviewRounds[0], baseCommit: oid("9") }] },
		{ ...review, reviewRounds: [{ ...review.reviewRounds[0], correction: {} }] },
		{ ...review, reviewRounds: [...review.reviewRounds, review.reviewRounds[0]] },
	]) assert.throws(() => parseTaskDocument(JSON.stringify(changed)), /invalid/);
	assert.throws(() => parseTaskDocument("{"), /not valid JSON/);
});
