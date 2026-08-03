import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acceptTaskCorrectionPlan,
	acceptTaskPlan,
	activateTaskPlan,
	addTaskReviewComment,
	appendTaskSession,
	completeTaskCorrection,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskCorrectionFeedback,
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
	registerTaskCorrectionPlanStart,
	registerTaskCorrectionStart,
	registerTaskFeedbackGrillStart,
	registerTaskReviewerStart,
	saveTaskDocument,
	serializeTaskDocument,
	TASK_VERSION,
	updateTaskReviewComment,
	type NewTaskInput,
	type ReviewerOutcome,
	type TaskCorrectionFeedback,
	type TaskCorrectionPlan,
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
const correctionFeedback: TaskCorrectionFeedback = {
	sharedUnderstanding: "Fix the confirmed review issue.",
	corrections: ["Fix the changed line."],
	decisions: ["Keep the existing interface."],
	acceptedAssumptions: [],
};
const correctionPlan: TaskCorrectionPlan = {
	goal: "Fix the changed line.",
	fileScopes: ["src/index.ts"],
	dependencies: [],
	instructions: ["Apply the confirmed correction."],
	verification: ["npm run correction-check", "npm test"],
};
const correctionEvidence = [
	{ command: "npm run correction-check", exitCode: 0, summary: "Correction check passed." },
	{ command: "npm test", exitCode: 0, summary: "Workflow passed." },
];

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

function feedbackTask(): TaskDocument {
	return decideTaskReview(
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
}

function correctionTask(): TaskDocument {
	let task = registerTaskFeedbackGrillStart(feedbackTask(), "/sessions/feedback-grill-1.jsonl");
	task = confirmTaskCorrectionFeedback(task, correctionFeedback);
	task = registerTaskCorrectionPlanStart(task, "/sessions/correction-plan-1.jsonl");
	task = acceptTaskCorrectionPlan(task, correctionPlan);
	return registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl");
}

test("version 7 task.json round-trips atomically from Questions and rejects v6", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-task-"));
	try {
		const path = join(directory, "task.json");
		const task = createTaskDocument(input());
		assert.equal(TASK_VERSION, 7);
		assert.equal(task.version, 7);
		assert.throws(() => parseTaskDocument(JSON.stringify({ ...task, version: 6 })), /invalid/);
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

test("reviewer registration is atomic, independent, typed, exact, and one-way", () => {
	let task = finishImplementation();
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness-1.jsonl");
	assert.deepEqual(currentTaskReviewRound(task)?.reviewers.correctness, {
		sessionPath: "/sessions/correctness-1.jsonl",
		outcome: null,
	});
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(task)), task);
	task = registerTaskReviewerStart(task, "deviation", "/sessions/deviation-1.jsonl");
	assert.deepEqual(currentTaskReviewRound(task)?.reviewers.deviation, {
		sessionPath: "/sessions/deviation-1.jsonl",
		outcome: null,
	});
	assert.equal(findTaskSession(task, { kind: "deviation-review", round: 1 })?.path,
		"/sessions/deviation-1.jsonl");
	assert.equal(findTaskSession(task, { kind: "correctness-review", round: 1 })?.path,
		"/sessions/correctness-1.jsonl");
	assert.throws(
		() => registerTaskReviewerStart(task, "deviation", "/sessions/deviation-2.jsonl"),
		/already started/,
	);

	task = completeTaskReviewer(task, "correctness", completed);
	task = completeTaskReviewer(task, "deviation", completed);
	assert.throws(() => completeTaskReviewer(task, "deviation", failed), /already complete/);
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
	assert.deepEqual(currentTaskReviewRound(task)?.correction, {
		feedbackGrill: null,
		correctionPlan: null,
		sessionPath: null,
		result: null,
	});
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

test("feedback rounds enforce grill, accepted plan, implementation, and fresh review order", () => {
	let task = feedbackTask();
	assert.equal(currentTaskCorrectionRound(task), undefined);
	assert.throws(
		() => registerTaskCorrectionPlanStart(task, "/sessions/correction-plan-1.jsonl"),
		/requires confirmed feedback/,
	);
	assert.throws(
		() => registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl"),
		/requires an accepted correction plan/,
	);

	task = registerTaskFeedbackGrillStart(task, "/sessions/feedback-grill-1.jsonl");
	assert.equal(findTaskSession(task, { kind: "feedback-grill", round: 1 })?.path,
		"/sessions/feedback-grill-1.jsonl");
	assert.throws(
		() => registerTaskCorrectionPlanStart(task, "/sessions/correction-plan-1.jsonl"),
		/requires confirmed feedback/,
	);
	task = confirmTaskCorrectionFeedback(task, correctionFeedback);
	assert.deepEqual(confirmTaskCorrectionFeedback(task, structuredClone(correctionFeedback)), task);
	assert.throws(
		() => confirmTaskCorrectionFeedback(task, { ...correctionFeedback, sharedUnderstanding: "Changed." }),
		/immutable/,
	);

	task = registerTaskCorrectionPlanStart(task, "/sessions/correction-plan-1.jsonl");
	assert.equal(findTaskSession(task, { kind: "correction-plan", round: 1 })?.path,
		"/sessions/correction-plan-1.jsonl");
	assert.throws(
		() => registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl"),
		/requires an accepted correction plan/,
	);
	task = acceptTaskCorrectionPlan(task, correctionPlan);
	assert.deepEqual(acceptTaskCorrectionPlan(task, structuredClone(correctionPlan)), task);
	assert.throws(
		() => acceptTaskCorrectionPlan(task, { ...correctionPlan, goal: "Changed." }),
		/immutable/,
	);

	task = registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl");
	assert.equal(currentTaskCorrectionRound(task)?.number, 1);
	for (const kind of ["feedback-grill", "correction-plan", "correction"] as const)
		assert.ok(findTaskSession(task, { kind, round: 1 }));
	assert.throws(() => registerTaskCorrectionStart(task, "/sessions/correction-2.jsonl"), /already started/);

	const frozen = structuredClone(task.reviewRounds[0]);
	task = completeTaskCorrection(task, "Fixed the changed line.", correctionEvidence, oid("4"));
	assert.equal(task.stage, "review");
	assert.equal(task.reviewRounds.length, 2);
	assert.deepEqual(task.reviewRounds[0], {
		...frozen,
		correction: {
			...frozen.correction!,
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
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(task)), task);

	let second = registerTaskReviewerStart(task, "deviation", "/sessions/deviation-2.jsonl");
	second = completeTaskReviewer(second, "deviation", completed);
	second = registerTaskReviewerStart(second, "correctness", "/sessions/correctness-2.jsonl");
	second = completeTaskReviewer(second, "correctness", completed);
	second = decideTaskReview(second, "approve", now);
	assert.equal(second.stage, "done");
});

test("correction validation rejects skipped, mismatched-round, and mismatched-session states", () => {
	const running = correctionTask();
	const task = completeTaskCorrection(running, "Fixed.", correctionEvidence, oid("4"));
	const rounds = () => structuredClone(task.reviewRounds);
	const pending = feedbackTask();
	const skipped = structuredClone(pending);
	skipped.reviewRounds[0].correction!.correctionPlan = {
		sessionPath: "/sessions/correction-plan-1.jsonl",
		acceptedPlan: structuredClone(correctionPlan),
	};
	skipped.sessions.push({
		kind: "correction-plan",
		round: 1,
		path: "/sessions/correction-plan-1.jsonl",
	});

	for (const changed of [
		{ ...task, reviewRounds: rounds().map((round, index) => index === 1 ? { ...round, headCommit: oid("9") } : round) },
		{ ...task, reviewRounds: rounds().map((round, index) => index === 1 ? { ...round, baseCommit: oid("4") } : round) },
		{ ...task, reviewRounds: rounds().map((round, index) => index === 0 ? { ...round, correction: null } : round) },
		{ ...task, reviewRounds: [rounds()[0]] },
		{ ...task, sessions: task.sessions.filter((run) => run.kind !== "feedback-grill") },
		{ ...task, sessions: task.sessions.map((run) => run.kind === "correction-plan" ? { ...run, round: 2 } : run) },
		{
			...task,
			reviewRounds: rounds().map((round, index) => index === 0
				? { ...round, correction: { ...round.correction!, sessionPath: "/sessions/wrong.jsonl" } }
				: round),
		},
		{
			...task,
			reviewRounds: rounds().map((round, index) => index === 0
				? { ...round, correction: { ...round.correction!, result: { ...round.correction!.result!, verificationEvidence: [] } } }
				: round),
		},
		{ ...running, reviewRounds: [{ ...running.reviewRounds[0], decision: null }] },
		skipped,
	]) assert.throws(() => parseTaskDocument(JSON.stringify(changed)), /invalid/);
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(running)), running);
});

test("correction plans may expand verification while results remain exact and ordered", () => {
	let planning = registerTaskFeedbackGrillStart(feedbackTask(), "/sessions/feedback-grill-1.jsonl");
	planning = confirmTaskCorrectionFeedback(planning, correctionFeedback);
	planning = registerTaskCorrectionPlanStart(planning, "/sessions/correction-plan-1.jsonl");
	assert.throws(
		() => acceptTaskCorrectionPlan(planning, {
			...correctionPlan,
			verification: ["npm test", "npm test"],
		}),
		/invalid correction plan/,
	);
	planning = acceptTaskCorrectionPlan(planning, correctionPlan);
	assert.equal(
		planning.checkpoints.some((checkpoint) =>
			checkpoint.verification.includes("npm run correction-check")
		),
		false,
	);
	assert.deepEqual(
		currentTaskReviewRound(planning)?.correction?.correctionPlan?.acceptedPlan,
		correctionPlan,
	);
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(planning)), planning);

	const running = correctionTask();
	assert.throws(
		() => completeTaskCorrection(running, "Fixed.", [...correctionEvidence].reverse(), oid("4")),
		/invalid JURUC task document/,
	);
	const task = completeTaskCorrection(running, "Fixed.", correctionEvidence, oid("4"));
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
