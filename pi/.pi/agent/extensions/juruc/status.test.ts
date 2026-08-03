import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleLine, lifecyclePlace, taskContext } from "./status.ts";
import {
	acceptTaskPlan,
	activateTaskPlan,
	addTaskReviewComment,
	completeTaskCorrection,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	decideTaskReview,
	registerTaskCorrectionStart,
	registerTaskReviewerStart,
} from "./task.ts";

function task() {
	return createTaskDocument({
		slug: "status-task",
		title: "Status task",
		request: "Show status.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "status-task",
			worktree: "/worktrees/status-task",
		},
	});
}

function implementationTask() {
	let current = confirmTaskQuestions(task(), {
		sharedUnderstanding: "Show status.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	current = completeTaskResearch(current);
	current = confirmTaskSpecification(current, {
		summary: "Show it.",
		requirements: ["Show stage."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["Rail is exact."],
		decisions: [],
	});
	return activateTaskPlan(acceptTaskPlan(current, {
		phases: [{
			id: "show-status",
			title: "Show status",
			goal: "Show status.",
			fileScopes: ["status.ts"],
			instructions: ["Render status."],
			verification: ["test status"],
		}],
	}));
}

test("status renders the exact compact QRSPI rail and context", () => {
	let current = task();
	assert.equal(lifecycleLine(current), "Q● R· S· P· I· · questions");
	current = confirmTaskQuestions(current, {
		sharedUnderstanding: "Show status.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	assert.equal(lifecycleLine(current), "Q✓ R● S· P· I· · research");
	current = completeTaskResearch(current);
	assert.equal(lifecycleLine(current), "Q✓ R✓ S● P· I· · specification");
	current = confirmTaskSpecification(current, {
		summary: "Show it.",
		requirements: ["Show stage."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["Rail is exact."],
		decisions: [],
	});
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P● I· · plan");
	current = acceptTaskPlan(current, {
		phases: [{
			id: "show-status",
			title: "Show status",
			goal: "Show status.",
			fileScopes: ["status.ts"],
			instructions: ["Render status."],
			verification: ["test status"],
		}],
	});
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P● I· · plan accepted · activation pending");
});

test("implementation and review spell out the active phase", () => {
	let current = implementationTask();
	assert.equal(lifecyclePlace(current).detail, "phase 1/1 · Show status");
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I● · phase 1/1 · Show status");
	current = completeTaskPhase(
		current,
		"Done.",
		[{ command: "test status", exitCode: 0, summary: "Passed." }],
		"2".repeat(40),
	);
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I✓ · review 1 · preparing");
	current = completeTaskReviewer(
		registerTaskReviewerStart(current, "deviation", "/sessions/deviation.jsonl"),
		"deviation",
		{ status: "completed", annotations: [] },
	);
	current = completeTaskReviewer(
		registerTaskReviewerStart(current, "correctness", "/sessions/correctness.jsonl"),
		"correctness",
		{ status: "completed", annotations: [] },
	);
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I✓ · review 1 · awaiting decision");
});

test("a pending or running correction and a fresh round spell out their own context", () => {
	let current = completeTaskReviewer(
		registerTaskReviewerStart(
			completeTaskReviewer(
				registerTaskReviewerStart(
					completeTaskPhase(
						implementationTask(),
						"Done.",
						[{ command: "test status", exitCode: 0, summary: "Passed." }],
						"2".repeat(40),
					),
					"deviation",
					"/sessions/deviation.jsonl",
				),
				"deviation",
				{ status: "completed", annotations: [] },
			),
			"correctness",
			"/sessions/correctness.jsonl",
		),
		"correctness",
		{ status: "completed", annotations: [] },
	);
	current = addTaskReviewComment(current, {
		filePath: "status.ts",
		side: "additions",
		startLine: 1,
		endLine: 1,
		body: "Rename the rail helper.",
	}, "12345678-1234-4234-8234-123456789abc", "2026-08-03T00:00:00.000Z");
	current = decideTaskReview(current, "send-feedback", "2026-08-03T00:00:00.000Z");
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I✓ · correction 1 · verifying");

	current = registerTaskCorrectionStart(current, "/sessions/correction-1.jsonl");
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I✓ · correction 1 · verifying");

	current = completeTaskCorrection(
		current,
		"Renamed it.",
		[{ command: "test status", exitCode: 0, summary: "Passed." }],
		"3".repeat(40),
	);
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I✓ · review 2 · preparing");
});

test("the picker context names only the single next action", () => {
	const evidence = [{ command: "test status", exitCode: 0, summary: "Passed." }];
	const phase = (id: string, title: string) => ({
		id,
		title,
		goal: "Show status.",
		fileScopes: ["status.ts"],
		instructions: ["Render status."],
		verification: ["test status"],
	});
	const finishReviewers = (document: ReturnType<typeof task>, round: number) =>
		completeTaskReviewer(
			registerTaskReviewerStart(
				completeTaskReviewer(
					registerTaskReviewerStart(document, "deviation", `/sessions/deviation-${round}.jsonl`),
					"deviation",
					{ status: "completed", annotations: [] },
				),
				"correctness",
				`/sessions/correctness-${round}.jsonl`,
			),
			"correctness",
			{ status: "completed", annotations: [] },
		);

	let current = task();
	assert.equal(taskContext(current), "questions");
	current = confirmTaskQuestions(current, {
		sharedUnderstanding: "Show status.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	assert.equal(taskContext(current), "research");
	current = completeTaskResearch(current);
	assert.equal(taskContext(current), "specification");
	current = confirmTaskSpecification(current, {
		summary: "Show it.",
		requirements: ["Show stage."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["Context is exact."],
		decisions: [],
	});
	assert.equal(taskContext(current), "plan");
	current = acceptTaskPlan(current, {
		phases: [phase("show-status", "Show status"), phase("connect-status", "Connect status")],
	});
	assert.equal(taskContext(current), "plan");
	current = activateTaskPlan(current);
	assert.equal(taskContext(current), "implement 1/2");
	current = completeTaskPhase(current, "Done.", evidence, "2".repeat(40));
	assert.equal(taskContext(current), "implement 2/2");
	current = completeTaskPhase(current, "Done.", evidence, "3".repeat(40));
	assert.equal(taskContext(current), "review 1");
	current = finishReviewers(current, 1);
	assert.equal(taskContext(current), "review 1");
	current = decideTaskReview(
		addTaskReviewComment(current, {
			filePath: "status.ts",
			side: "additions",
			startLine: 1,
			endLine: 1,
			body: "Rename the rail helper.",
		}, "12345678-1234-4234-8234-123456789abc", "2026-08-03T00:00:00.000Z"),
		"send-feedback",
		"2026-08-03T00:00:00.000Z",
	);
	assert.equal(taskContext(current), "correction 1");
	current = registerTaskCorrectionStart(current, "/sessions/correction-1.jsonl");
	assert.equal(taskContext(current), "correction 1");
	current = completeTaskCorrection(current, "Renamed it.", evidence, "4".repeat(40));
	assert.equal(taskContext(current), "review 2");
	current = decideTaskReview(finishReviewers(current, 2), "approve", "2026-08-03T00:00:00.000Z");
	assert.equal(taskContext(current), "done");
});
