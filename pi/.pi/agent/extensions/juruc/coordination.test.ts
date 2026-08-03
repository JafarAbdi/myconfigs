import assert from "node:assert/strict";
import test from "node:test";
import { setTaskQuestions } from "./questions.ts";
import { confirmTaskPlan } from "./planning.ts";
import { setTaskSpecification } from "./specification.ts";
import {
	activateTaskPlan,
	appendTaskSession,
	completeTaskResearch,
	createTaskDocument,
	findTaskSession,
} from "./task.ts";

function task() {
	return createTaskDocument({
		slug: "coordinated-task",
		title: "Coordinated task",
		request: "Coordinate discovery.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "coordinated-task",
			worktree: "/worktrees/coordinated-task",
		},
	});
}

test("discovery transitions preserve one fresh typed run per stage", () => {
	let current = appendTaskSession(task(), {
		kind: "questions",
		path: "/sessions/questions.jsonl",
	});
	current = setTaskQuestions(current, {
		sharedUnderstanding: "Confirmed target.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	current = appendTaskSession(current, {
		kind: "research",
		path: "/sessions/research.jsonl",
	});
	current = completeTaskResearch(current);
	current = appendTaskSession(current, {
		kind: "specification",
		path: "/sessions/specification.jsonl",
	});
	current = setTaskSpecification(current, {
		summary: "Specified target.",
		requirements: ["Implement it."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["It works."],
		decisions: [],
	});
	current = appendTaskSession(current, {
		kind: "plan",
		path: "/sessions/plan.jsonl",
	});
	current = confirmTaskPlan(current, {
		phases: [{
			id: "implement",
			title: "Implement",
			goal: "Implement it.",
			fileScopes: ["src/**"],
			instructions: ["Implement the requirement."],
			verification: ["npm test"],
		}],
	});
	assert.equal(current.stage, "plan");
	assert.ok(current.plan);
	current = activateTaskPlan(current);
	assert.equal(current.stage, "implementation");
	assert.equal(current.sessions.length, 4);
	assert.equal(findTaskSession(current, { kind: "plan" })?.path, "/sessions/plan.jsonl");
	assert.throws(
		() => appendTaskSession(current, { kind: "plan", path: "/sessions/other-plan.jsonl" }),
		/already recorded/,
	);
});
