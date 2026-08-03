import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleLine, lifecyclePlace } from "./status.ts";
import {
	acceptTaskPlan,
	activateTaskPlan,
	completeTaskPhase,
	completeTaskResearch,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
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

test("implementation and done spell out the active phase", () => {
	let current = implementationTask();
	assert.equal(lifecyclePlace(current).detail, "phase 1/1 · Show status");
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I● · phase 1/1 · Show status");
	current = completeTaskPhase(
		current,
		"Done.",
		[{ command: "test status", exitCode: 0, summary: "Passed." }],
		"2".repeat(40),
	);
	assert.equal(lifecycleLine(current), "Q✓ R✓ S✓ P✓ I✓ · done");
});
