import assert from "node:assert/strict";
import test from "node:test";
import {
	confirmTaskPlan,
	PLAN_DECISION_TITLE,
	PLAN_DECISION_UNRESOLVED,
	PLAN_DECISIONS,
	PLAN_REVISION_TITLE,
	planFromInput,
	planningPrompt,
	PLANNING_INSTRUCTION,
	PLANNING_RESUME_INSTRUCTION,
	PLANNING_TOOL_NAMES,
	planRevisionRequest,
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
	for (const phrase of ["validated Specification", "decision selector", "final and immutable"])
		assert.match(PLANNING_INSTRUCTION, new RegExp(phrase, "i"));
	const prompt = planningPrompt(specification);
	assert.match(prompt, /Validated Specification/);
	assert.match(prompt, /Advance through each phase/);
	assert.doesNotMatch(prompt, /research\.md|sharedUnderstanding|Original request/i);
});

test("the selector owns acceptance and no prompt asks for a typed acceptance phrase", () => {
	assert.deepEqual(Object.values(PLAN_DECISIONS), ["Accept plan", "Revise plan", "Cancel"]);
	assert.match(PLAN_DECISION_TITLE, /final/i);
	assert.match(PLAN_DECISION_TITLE, /immutable/i);
	const feedback = "Split the migration phase and verify each half.";
	const revision = planRevisionRequest(feedback);
	assert.ok(revision.includes(feedback));
	assert.match(revision, /call juruc_set_plan again/);
	assert.match(PLAN_DECISION_UNRESOLVED, /Nothing was persisted/);
	for (const prompt of [
		PLANNING_INSTRUCTION,
		PLANNING_RESUME_INSTRUCTION,
		PLAN_DECISION_TITLE,
		PLAN_REVISION_TITLE,
		PLAN_DECISION_UNRESOLVED,
		revision,
	]) {
		assert.doesNotMatch(prompt, /only after (explicit )?acceptance|require explicit human acceptance/i);
		// Every sentence that mentions typing, saying, or replying must forbid it, never ask for it.
		for (const sentence of prompt.split(/(?<=\.)\s+/u))
			if (/\btyped?\b|\bsays?\b|\breply\b/iu.test(sentence))
				assert.match(sentence, /never/i, `prompt asks for a typed acceptance: ${sentence}`);
	}
	for (const prompt of [PLANNING_INSTRUCTION, PLANNING_RESUME_INSTRUCTION])
		assert.match(prompt, /never ask the operator to type an acceptance phrase/i);
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
	assert.equal(updated.stage, "plan");
	assert.deepEqual(updated.plan, planFromInput(input));
	assert.deepEqual(confirmTaskPlan(updated, input), updated);
	assert.throws(
		() => confirmTaskPlan(updated, {
			phases: [{ ...input.phases[0], goal: "A changed accepted plan." }],
		}),
		/immutable/,
	);
	assert.throws(
		() => confirmTaskPlan(planningTask(), { phases: [{ ...input.phases[0], fileScopes: ["../bad"] }] }),
		/invalid/,
	);
});
