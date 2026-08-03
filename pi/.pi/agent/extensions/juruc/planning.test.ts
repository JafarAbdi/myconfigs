import assert from "node:assert/strict";
import test from "node:test";
import {
	confirmTaskPlan,
	planFromInput,
	planningPrompt,
	PLANNING_INSTRUCTION,
	PLANNING_TOOL_NAMES,
	SET_PLAN_SCHEMA,
	type SetPlanInput,
} from "./planning.ts";
import {
	completeTaskResearch,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	type TaskSpecification,
} from "./task.ts";

const specification: TaskSpecification = {
	summary: "Implement the workflow.",
	requirements: ["Advance through each phase."],
	nonGoals: [],
	constraints: ["Keep strict state."],
	acceptanceCriteria: ["Tests pass."],
	decisions: [],
};
const input: SetPlanInput = {
	phases: [{
		id: " implement-core ",
		title: " Implement core ",
		goal: " Add the core. ",
		fileScopes: [" src/** "],
		instructions: [" Add behavior. ", " Add tests. "],
		verification: [" node --test core.test.ts "],
	}],
};

function planningTask() {
	let task = createTaskDocument({
		slug: "plan-task",
		title: "Plan task",
		request: "Plan it.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "plan-task",
			worktree: "/worktrees/plan-task",
		},
	});
	task = confirmTaskQuestions(task, {
		sharedUnderstanding: "Plan it.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	task = completeTaskResearch(task);
	return confirmTaskSpecification(task, specification);
}

test("Plan receives only Specification and read-only repository tools", () => {
	assert.deepEqual(PLANNING_TOOL_NAMES, ["read", "grep", "find", "ls", "juruc_set_plan"]);
	for (const phrase of ["validated Specification", "explicit human acceptance", "final and immutable"])
		assert.match(PLANNING_INSTRUCTION, new RegExp(phrase, "i"));
	const prompt = planningPrompt(specification);
	assert.match(prompt, /Validated Specification/);
	assert.match(prompt, /Advance through each phase/);
	assert.doesNotMatch(prompt, /research\.md|sharedUnderstanding|Original request/i);
});

test("accepted plan uses final exact phase schema", () => {
	assert.deepEqual(SET_PLAN_SCHEMA.required, ["phases"]);
	assert.equal(SET_PLAN_SCHEMA.additionalProperties, false);
	assert.deepEqual(SET_PLAN_SCHEMA.properties.phases.items.required, [
		"id",
		"title",
		"goal",
		"fileScopes",
		"instructions",
		"verification",
	]);
	assert.deepEqual(planFromInput(input), {
		phases: [{
			id: "implement-core",
			title: "Implement core",
			goal: "Add the core.",
			fileScopes: ["src/**"],
			instructions: ["Add behavior.", "Add tests."],
			verification: ["node --test core.test.ts"],
		}],
	});
	const updated = confirmTaskPlan(planningTask(), input);
	assert.equal(updated.stage, "implementation");
	assert.deepEqual(updated.plan, planFromInput(input));
	assert.throws(
		() => confirmTaskPlan(planningTask(), { phases: [{ ...input.phases[0], fileScopes: ["../bad"] }] }),
		/invalid/,
	);
});
