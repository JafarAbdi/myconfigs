import assert from "node:assert/strict";
import test from "node:test";
import {
	SET_SPECIFICATION_SCHEMA,
	setTaskSpecification,
	SPECIFICATION_INSTRUCTION,
	SPECIFICATION_TOOL_NAMES,
	specificationFromInput,
	specificationPrompt,
} from "./specification.ts";
import {
	completeTaskResearch,
	confirmTaskQuestions,
	createTaskDocument,
	type TaskQuestions,
} from "./task.ts";

const questions: TaskQuestions = {
	sharedUnderstanding: "Build the target.",
	decisions: [],
	acceptedAssumptions: [],
	researchTargets: [],
};

function task() {
	let value = createTaskDocument({
		slug: "spec-task",
		title: "Spec task",
		request: "Specify the task.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "spec-task",
			worktree: "/worktrees/spec-task",
		},
	});
	value = confirmTaskQuestions(value, questions);
	return completeTaskResearch(value);
}

const input = {
	summary: " Exact behavior. ",
	requirements: [" Required behavior. "],
	nonGoals: [],
	constraints: [" Keep it strict. "],
	acceptanceCriteria: [" Tests pass. "],
	decisions: [],
};

test("Specification is implementation-neutral and has no repository tools", () => {
	assert.deepEqual(SPECIFICATION_TOOL_NAMES, ["juruc_set_specification"]);
	for (const phrase of ["implementation-neutral", "Do not inspect the repository", "sole tool call"])
		assert.match(SPECIFICATION_INSTRUCTION, new RegExp(phrase, "i"));
	const prompt = specificationPrompt("request", questions, "verified facts\n");
	assert.match(prompt, /Original request:\nrequest/);
	assert.match(prompt, /Confirmed Questions result/);
	assert.match(prompt, /Research report:\nverified facts/);
	assert.doesNotMatch(prompt, /phase|implementation plan/i);
});

test("Specification schema requires strict nonempty requirements and criteria", () => {
	assert.equal(SET_SPECIFICATION_SCHEMA.additionalProperties, false);
	assert.equal(SET_SPECIFICATION_SCHEMA.properties.requirements.minItems, 1);
	assert.equal(SET_SPECIFICATION_SCHEMA.properties.acceptanceCriteria.minItems, 1);
	assert.deepEqual(specificationFromInput(input), {
		summary: "Exact behavior.",
		requirements: ["Required behavior."],
		nonGoals: [],
		constraints: ["Keep it strict."],
		acceptanceCriteria: ["Tests pass."],
		decisions: [],
	});
	const updated = setTaskSpecification(task(), input);
	assert.equal(updated.stage, "plan");
	assert.throws(
		() => setTaskSpecification(task(), { ...input, acceptanceCriteria: [] }),
		/invalid/,
	);
});
