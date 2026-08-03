import assert from "node:assert/strict";
import test from "node:test";
import {
	acceptCorrectionPlan,
	CORRECTION_PLAN_DECISION_TITLE,
	CORRECTION_PLAN_DECISION_UNRESOLVED,
	CORRECTION_PLAN_DECISIONS,
	CORRECTION_PLAN_REVISION_TITLE,
	correctionPlanFromInput,
	correctionPlanningPrompt,
	CORRECTION_PLANNING_INSTRUCTION,
	CORRECTION_PLANNING_TOOL_NAMES,
	correctionPlanRevisionRequest,
	decideCorrectionPlan,
	SET_CORRECTION_PLAN_SCHEMA,
	type SetCorrectionPlanInput,
} from "./correction-planning.ts";
import { PLAN_DECISIONS } from "./planning.ts";
import {
	acceptTaskPlan,
	activateTaskPlan,
	addTaskReviewComment,
	appendTaskSession,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskCorrectionFeedback,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	currentTaskReviewRound,
	decideTaskReview,
	registerTaskCorrectionPlanStart,
	registerTaskFeedbackGrillStart,
	registerTaskReviewerStart,
	type TaskCorrectionFeedback,
	type TaskDocument,
	type TaskSpecification,
} from "./task.ts";

const specification: TaskSpecification = {
	summary: "INCLUDED_SPECIFICATION",
	requirements: ["Correct the behavior."],
	nonGoals: [],
	constraints: [],
	acceptanceCriteria: ["Correction verification passes."],
	decisions: [],
};
const feedback: TaskCorrectionFeedback = {
	sharedUnderstanding: "INCLUDED_CONFIRMED_FEEDBACK",
	corrections: ["Correct the reviewed behavior."],
	decisions: ["Keep the public interface."],
	acceptedAssumptions: [],
};
const input: SetCorrectionPlanInput = {
	goal: " Correct the behavior. ",
	fileScopes: [" src/** ", " test/** "],
	dependencies: [" Existing parser. "],
	instructions: [" Update the implementation. ", " Add a regression test. "],
	verification: [" npm test "],
};

function correctionPlanningTask(): TaskDocument {
	let task = createTaskDocument({
		slug: "correction-plan-task",
		title: "Correction plan task",
		request: "EXCLUDED_ORIGINAL_REQUEST",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "correction-plan-task",
			worktree: "/worktrees/correction-plan-task",
		},
	});
	task = confirmTaskQuestions(task, {
		sharedUnderstanding: "EXCLUDED_QUESTIONS",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	task = completeTaskResearch(task);
	task = confirmTaskSpecification(task, specification);
	task = activateTaskPlan(acceptTaskPlan(task, { phases: [{
		id: "implement",
		title: "Implement",
		goal: "EXCLUDED_ORIGINAL_PLAN",
		fileScopes: ["src/old.ts"],
		instructions: ["EXCLUDED_PLAN_INSTRUCTION"],
		verification: ["old verification"],
	}] }));
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/EXCLUDED_TRANSCRIPT.jsonl",
	});
	task = completeTaskPhase(task, "Implemented.", [{
		command: "old verification",
		exitCode: 0,
		summary: "EXCLUDED_EVIDENCE",
	}], "2".repeat(40));
	task = registerTaskReviewerStart(task, "deviation", "/sessions/deviation.jsonl");
	task = completeTaskReviewer(task, "deviation", {
		status: "completed",
		annotations: [{
			filePath: "src/old.ts",
			side: "additions",
			line: 1,
			summary: "EXCLUDED_REVIEWER_OUTPUT",
		}],
	});
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness.jsonl");
	task = completeTaskReviewer(task, "correctness", { status: "completed", annotations: [] });
	task = addTaskReviewComment(task, {
		filePath: "src/old.ts",
		side: "additions",
		startLine: 1,
		endLine: 1,
		body: "EXCLUDED_HUMAN_COMMENT",
	}, "12345678-1234-4234-8234-123456789abc", "2026-08-01T00:00:00.000Z");
	task = decideTaskReview(task, "send-feedback", "2026-08-02T00:00:00.000Z");
	task = registerTaskFeedbackGrillStart(task, "/sessions/feedback.jsonl");
	task = confirmTaskCorrectionFeedback(task, feedback);
	return registerTaskCorrectionPlanStart(task, "/sessions/correction-plan.jsonl");
}

test("Correction Planning has the exact read-only tools, diet, and nested authority", () => {
	assert.deepEqual(CORRECTION_PLANNING_TOOL_NAMES, [
		"read", "grep", "find", "ls", "juruc_set_correction_plan",
	]);
	for (const phrase of [
		"fresh read-only session",
		"smallest bounded correction plan",
		"repository-relative file scopes",
		"dependencies",
		"verification commands",
		"may deliberately expand the original Plan's scopes, dependencies, or commands",
		"accepted correction plan becomes the authority",
		"Present the complete correction plan",
		"sole tool call",
	]) assert.match(CORRECTION_PLANNING_INSTRUCTION, new RegExp(phrase, "i"));

	const task = correctionPlanningTask();
	const confirmed = currentTaskReviewRound(task)!.correction!.feedbackGrill!.confirmedFeedback!;
	const prompt = correctionPlanningPrompt(task.specification!, confirmed);
	assert.match(prompt, /INCLUDED_SPECIFICATION/);
	assert.match(prompt, /INCLUDED_CONFIRMED_FEEDBACK/);
	for (const excluded of [
		"EXCLUDED_ORIGINAL_REQUEST",
		"EXCLUDED_QUESTIONS",
		"EXCLUDED_RESEARCH",
		"EXCLUDED_ORIGINAL_PLAN",
		"EXCLUDED_PLAN_INSTRUCTION",
		"EXCLUDED_HUMAN_COMMENT",
		"EXCLUDED_REVIEWER_OUTPUT",
		"EXCLUDED_EVIDENCE",
		"EXCLUDED_TRANSCRIPT",
	]) assert.doesNotMatch(prompt, new RegExp(excluded));
});

test("correction-plan schema, conversion, and acceptance match TaskCorrectionPlan", () => {
	assert.equal(SET_CORRECTION_PLAN_SCHEMA.additionalProperties, false);
	assert.deepEqual(SET_CORRECTION_PLAN_SCHEMA.required, [
		"goal", "fileScopes", "dependencies", "instructions", "verification",
	]);
	assert.deepEqual(correctionPlanFromInput(input), {
		goal: "Correct the behavior.",
		fileScopes: ["src/**", "test/**"],
		dependencies: ["Existing parser."],
		instructions: ["Update the implementation.", "Add a regression test."],
		verification: ["npm test"],
	});
	const updated = acceptCorrectionPlan(correctionPlanningTask(), input);
	assert.deepEqual(
		currentTaskReviewRound(updated)?.correction?.correctionPlan?.acceptedPlan,
		correctionPlanFromInput(input),
	);
	assert.throws(
		() => acceptCorrectionPlan(correctionPlanningTask(), { ...input, fileScopes: ["../bad"] }),
		/invalid/,
	);
});

test("native correction-plan decision handling accepts, revises exactly, or persists nothing", () => {
	assert.strictEqual(CORRECTION_PLAN_DECISIONS, PLAN_DECISIONS);
	assert.deepEqual(Object.values(CORRECTION_PLAN_DECISIONS), [
		"Accept plan", "Revise plan", "Cancel",
	]);
	assert.match(CORRECTION_PLAN_DECISION_TITLE, /correction plan/i);
	assert.match(CORRECTION_PLAN_DECISION_TITLE, /final/i);
	assert.match(CORRECTION_PLAN_REVISION_TITLE, /correction plan/i);
	assert.match(CORRECTION_PLAN_DECISION_UNRESOLVED, /Nothing was persisted/);

	const task = correctionPlanningTask();
	const accepted = decideCorrectionPlan(task, input, CORRECTION_PLAN_DECISIONS.accept);
	assert.equal(accepted.kind, "accept");
	if (accepted.kind === "accept") assert.deepEqual(
		currentTaskReviewRound(accepted.task)?.correction?.correctionPlan?.acceptedPlan,
		correctionPlanFromInput(input),
	);

	const exactFeedback = "  Keep the new verification command exact.  ";
	const revised = decideCorrectionPlan(
		task,
		input,
		CORRECTION_PLAN_DECISIONS.revise,
		exactFeedback,
	);
	assert.deepEqual(revised.kind === "revise" && revised.feedback, exactFeedback);
	assert.ok(revised.kind === "revise" && revised.message.includes(exactFeedback));
	assert.match(correctionPlanRevisionRequest(exactFeedback), /juruc_set_correction_plan again/);
	assert.throws(() => correctionPlanRevisionRequest(" \t "), /nonblank/);

	for (const [decision, revision] of [
		[CORRECTION_PLAN_DECISIONS.cancel, undefined],
		[undefined, undefined],
		[CORRECTION_PLAN_DECISIONS.revise, "   "],
	] as const) {
		const unresolved = decideCorrectionPlan(task, input, decision, revision);
		assert.deepEqual(unresolved, {
			kind: "unresolved",
			message: CORRECTION_PLAN_DECISION_UNRESOLVED,
		});
		assert.equal(
			currentTaskReviewRound(task)?.correction?.correctionPlan?.acceptedPlan,
			null,
		);
	}
});
