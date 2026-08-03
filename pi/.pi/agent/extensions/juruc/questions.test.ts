import assert from "node:assert/strict";
import test from "node:test";
import {
	questionsFromInput,
	questionsPrompt,
	QUESTIONS_INSTRUCTION,
	QUESTIONS_TOOL_NAMES,
	SET_QUESTIONS_SCHEMA,
	setTaskQuestions,
} from "./questions.ts";
import { createTaskDocument } from "./task.ts";

function task() {
	return createTaskDocument({
		slug: "questions-task",
		title: "Questions task",
		request: "Resolve the task.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "questions-task",
			worktree: "/worktrees/questions-task",
		},
	});
}

const input = {
	sharedUnderstanding: " Confirm the target. ",
	decisions: [" Keep it small. "],
	acceptedAssumptions: [],
	researchTargets: [],
};

test("Questions instruction implements the one-choice Grill interview", () => {
	for (const phrase of [
		"exactly one unresolved material choice per turn",
		"recommended answer",
		"Investigate repository facts",
		"explicit confirmation",
		"sole tool call",
	]) assert.match(QUESTIONS_INSTRUCTION, new RegExp(phrase, "i"));
	assert.deepEqual(QUESTIONS_TOOL_NAMES, [
		"read",
		"grep",
		"find",
		"ls",
		"juruc_set_questions",
	]);
	assert.equal(questionsPrompt("exact request"), "Original request:\nexact request");
});

test("Questions schema and conversion are strict and trimmed", () => {
	assert.equal(SET_QUESTIONS_SCHEMA.additionalProperties, false);
	assert.deepEqual(SET_QUESTIONS_SCHEMA.required, [
		"sharedUnderstanding",
		"decisions",
		"acceptedAssumptions",
		"researchTargets",
	]);
	assert.deepEqual(questionsFromInput(input), {
		sharedUnderstanding: "Confirm the target.",
		decisions: ["Keep it small."],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	const updated = setTaskQuestions(task(), input);
	assert.equal(updated.stage, "research");
	assert.deepEqual(updated.questions, questionsFromInput(input));
	assert.throws(
		() => setTaskQuestions(task(), { ...input, decisions: ["same", " same "] }),
		/invalid/,
	);
});
