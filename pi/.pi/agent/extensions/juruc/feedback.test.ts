import assert from "node:assert/strict";
import test from "node:test";
import {
	feedbackFromInput,
	feedbackPrompt,
	FEEDBACK_INSTRUCTION,
	FEEDBACK_TOOL_NAMES,
	orderedFeedbackComments,
	SET_FEEDBACK_SCHEMA,
	setTaskFeedback,
	type SetFeedbackInput,
} from "./feedback.ts";
import {
	acceptTaskPlan,
	activateTaskPlan,
	addTaskReviewComment,
	appendTaskSession,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	currentTaskReviewRound,
	decideTaskReview,
	registerTaskFeedbackGrillStart,
	registerTaskReviewerStart,
	type HumanComment,
	type TaskDocument,
	type TaskSpecification,
} from "./task.ts";

const specification: TaskSpecification = {
	summary: "INCLUDED_SPECIFICATION",
	requirements: ["Keep behavior correct."],
	nonGoals: [],
	constraints: [],
	acceptanceCriteria: ["Focused tests pass."],
	decisions: [],
};
const input: SetFeedbackInput = {
	sharedUnderstanding: " Resolve the comments. ",
	corrections: [" First correction. ", " Second correction. "],
	decisions: [" Preserve the interface. "],
	acceptedAssumptions: [],
};
const uuid = (digit: string): string => `${digit.repeat(8)}-1234-4234-8234-123456789abc`;

function feedbackTask(): TaskDocument {
	let task = createTaskDocument({
		slug: "feedback-task",
		title: "Feedback task",
		request: "EXCLUDED_ORIGINAL_REQUEST",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "feedback-task",
			worktree: "/worktrees/feedback-task",
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
		fileScopes: ["src/**"],
		instructions: ["Implement."],
		verification: ["npm test"],
	}] }));
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/EXCLUDED_TRANSCRIPT.jsonl",
	});
	task = completeTaskPhase(task, "Implemented.", [{
		command: "npm test",
		exitCode: 0,
		summary: "EXCLUDED_EVIDENCE",
	}], "2".repeat(40));
	task = registerTaskReviewerStart(task, "deviation", "/sessions/deviation.jsonl");
	task = completeTaskReviewer(task, "deviation", {
		status: "completed",
		annotations: [{
			filePath: "src/a.ts",
			side: "additions",
			line: 1,
			summary: "EXCLUDED_REVIEWER_OUTPUT",
		}],
	});
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness.jsonl");
	task = completeTaskReviewer(task, "correctness", { status: "completed", annotations: [] });
	task = addTaskReviewComment(task, {
		filePath: "src/a.ts",
		side: "additions",
		startLine: 1,
		endLine: 1,
		body: "INCLUDED_HUMAN_COMMENT",
	}, uuid("1"), "2026-08-01T00:00:00.000Z");
	task = decideTaskReview(task, "send-feedback", "2026-08-02T00:00:00.000Z");
	return registerTaskFeedbackGrillStart(task, "/sessions/feedback.jsonl");
}

function comment(
	id: string,
	filePath: string,
	side: "deletions" | "additions",
	startLine: number,
	endLine: number,
): HumanComment {
	return {
		id,
		filePath,
		side,
		startLine,
		endLine,
		body: id,
		createdAt: "2026-08-01T00:00:00.000Z",
	};
}

test("Feedback Grill has the exact tools and one-choice confirmation protocol", () => {
	assert.deepEqual(FEEDBACK_TOOL_NAMES, [
		"read", "grep", "find", "ls", "juruc_set_feedback",
	]);
	for (const phrase of [
		"fresh, durable",
		"Investigate current repository facts",
		"exactly one unresolved material choice per turn",
		"recommended answer",
		"conflict between a saved human comment and the validated Specification",
		"Do not edit files or create implementation artifacts",
		"concise confirmed correction intent",
		"explicit confirmation",
		"sole tool call",
	]) assert.match(FEEDBACK_INSTRUCTION, new RegExp(phrase, "i"));
});

test("feedback schema, conversion, and persistence enforce TaskCorrectionFeedback", () => {
	assert.equal(SET_FEEDBACK_SCHEMA.additionalProperties, false);
	assert.deepEqual(SET_FEEDBACK_SCHEMA.required, [
		"sharedUnderstanding", "corrections", "decisions", "acceptedAssumptions",
	]);
	assert.equal(SET_FEEDBACK_SCHEMA.properties.corrections.minItems, 1);
	assert.deepEqual(feedbackFromInput(input), {
		sharedUnderstanding: "Resolve the comments.",
		corrections: ["First correction.", "Second correction."],
		decisions: ["Preserve the interface."],
		acceptedAssumptions: [],
	});
	const updated = setTaskFeedback(feedbackTask(), input);
	assert.deepEqual(
		currentTaskReviewRound(updated)?.correction?.feedbackGrill?.confirmedFeedback,
		feedbackFromInput(input),
	);
	assert.throws(
		() => setTaskFeedback(feedbackTask(), { ...input, decisions: ["same", " same "] }),
		/invalid/,
	);
});

test("feedback prompt sorts comments by every target key and excludes all other artifacts", () => {
	const comments = [
		comment("d", "z.ts", "additions", 1, 1),
		comment("c", "a.ts", "additions", 2, 4),
		comment("s", "a.ts", "additions", 1, 1),
		comment("b", "a.ts", "additions", 2, 3),
		comment("0", "a.ts", "additions", 2, 3),
		comment("a", "a.ts", "deletions", 2, 3),
	];
	assert.deepEqual(
		orderedFeedbackComments(comments).map(({ id }) => id),
		["a", "s", "0", "b", "c", "d"],
	);

	const task = feedbackTask();
	const prompt = feedbackPrompt(task.specification!, currentTaskReviewRound(task)!.humanComments);
	assert.match(prompt, /INCLUDED_SPECIFICATION/);
	assert.match(prompt, /INCLUDED_HUMAN_COMMENT/);
	for (const excluded of [
		"EXCLUDED_ORIGINAL_REQUEST",
		"EXCLUDED_QUESTIONS",
		"EXCLUDED_RESEARCH",
		"EXCLUDED_ORIGINAL_PLAN",
		"EXCLUDED_REVIEWER_OUTPUT",
		"EXCLUDED_EVIDENCE",
		"EXCLUDED_TRANSCRIPT",
	]) assert.doesNotMatch(prompt, new RegExp(excluded));
	assert.throws(() => feedbackPrompt(specification, []), /at least one saved human comment/);
});
