import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleDetail, lifecycleLine, lifecycleRail, taskContext } from "./status.ts";
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
	decideTaskReview,
	registerTaskCorrectionStart,
	registerTaskReviewerStart,
	type TaskDocument,
	type TaskSessionRun,
} from "./task.ts";

/** Opening a stage is exactly one typed session run; nothing else records it. */
const opened = (document: TaskDocument, run: TaskSessionRun) => appendTaskSession(document, run);

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
	let current = confirmTaskQuestions(
		opened(task(), { kind: "questions", path: "/sessions/questions.jsonl" }),
		{
			sharedUnderstanding: "Show status.",
			decisions: [],
			acceptedAssumptions: [],
			researchTargets: [],
		},
	);
	current = completeTaskResearch(
		opened(current, { kind: "research", path: "/sessions/research.jsonl" }),
	);
	current = confirmTaskSpecification(
		opened(current, { kind: "specification", path: "/sessions/specification.jsonl" }),
		{
			summary: "Show it.",
			requirements: ["Show stage."],
			nonGoals: [],
			constraints: [],
			acceptanceCriteria: ["Rail is exact."],
			decisions: [],
		},
	);
	current = opened(current, { kind: "plan", path: "/sessions/plan.jsonl" });
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

/** The markers already show the states; the roles are what the TUI paints. */
const roles = (document: TaskDocument) =>
	lifecycleRail(document).map((entry) => entry.role).join(" ");

test("every stage is ready before its session exists and opened once it does", () => {
	let current = task();
	assert.equal(lifecycleLine(current), "○ Q  ○ R  ○ S  ○ P  ○ I   Questions · Ready");
	assert.equal(roles(current), "ready future future future future");
	current = opened(current, { kind: "questions", path: "/sessions/questions.jsonl" });
	assert.equal(lifecycleLine(current), "● Q  ○ R  ○ S  ○ P  ○ I   Questions");
	assert.equal(roles(current), "opened future future future future");
	current = confirmTaskQuestions(current, {
		sharedUnderstanding: "Show status.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	assert.equal(lifecycleLine(current), "✓ Q  ○ R  ○ S  ○ P  ○ I   Research · Ready");
	assert.equal(roles(current), "completed ready future future future");
	current = opened(current, { kind: "research", path: "/sessions/research.jsonl" });
	assert.equal(lifecycleLine(current), "✓ Q  ● R  ○ S  ○ P  ○ I   Research");
	current = completeTaskResearch(current);
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ○ S  ○ P  ○ I   Specification · Ready");
	current = opened(current, { kind: "specification", path: "/sessions/specification.jsonl" });
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ● S  ○ P  ○ I   Specification");
	current = confirmTaskSpecification(current, {
		summary: "Show it.",
		requirements: ["Show stage."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["Rail is exact."],
		decisions: [],
	});
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ○ P  ○ I   Plan · Ready");
	current = opened(current, { kind: "plan", path: "/sessions/plan.jsonl" });
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ● P  ○ I   Plan");
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
	// An accepted plan whose workspace activation has not run yet still reads as the
	// implementation phase one Enter would open.
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ✓ P  ○ I   Phase 1/1 · Ready");
	assert.equal(roles(current), "completed completed completed completed ready");
	assert.equal(lifecycleLine(activateTaskPlan(current)), lifecycleLine(current));
});

test("implementation and review spell out the active phase", () => {
	let current = implementationTask();
	assert.equal(lifecycleDetail(current), "Phase 1/1 · Ready");
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ✓ P  ○ I   Phase 1/1 · Ready");
	current = opened(current, { kind: "implementation", phase: 1, path: "/sessions/phase-1.jsonl" });
	assert.equal(lifecycleDetail(current), "Phase 1/1 · Show status");
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ✓ P  ● I   Phase 1/1 · Show status");
	current = completeTaskPhase(
		current,
		"Done.",
		[{ command: "test status", exitCode: 0, summary: "Passed." }],
		"2".repeat(40),
	);
	// The final checkpoint only creates the round; opening Review is what starts reviewers.
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 1 · Ready");
	assert.equal(
		lifecycleLine(registerTaskReviewerStart(current, "deviation", "/sessions/pending.jsonl")),
		"✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 1 · Preparing",
	);
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
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 1 · Awaiting decision");
	// Review and done leave the rail entirely behind.
	assert.equal(roles(current), "completed completed completed completed completed");
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
	const decided = decideTaskReview(current, "send-feedback", "2026-08-03T00:00:00.000Z");
	assert.equal(lifecycleLine(decided), "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction 1 · Ready");

	current = registerTaskCorrectionStart(decided, "/sessions/correction-1.jsonl");
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction 1 · Verifying");

	current = completeTaskCorrection(
		current,
		"Renamed it.",
		[{ command: "test status", exitCode: 0, summary: "Passed." }],
		"3".repeat(40),
	);
	assert.equal(lifecycleLine(current), "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 2 · Ready");

	const approved = decideTaskReview(
		completeTaskReviewer(
			registerTaskReviewerStart(
				completeTaskReviewer(
					registerTaskReviewerStart(current, "deviation", "/sessions/deviation-2.jsonl"),
					"deviation",
					{ status: "completed", annotations: [] },
				),
				"correctness",
				"/sessions/correctness-2.jsonl",
			),
			"correctness",
			{ status: "completed", annotations: [] },
		),
		"approve",
		"2026-08-03T00:00:00.000Z",
	);
	assert.equal(lifecycleLine(approved), "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Done");
	assert.equal(roles(approved), "completed completed completed completed completed");
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
