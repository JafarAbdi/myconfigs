import {
	confirmTaskQuestions,
	type TaskDocument,
	type TaskQuestions,
} from "./task.ts";

export const QUESTIONS_INSTRUCTION = `Resolve the task through a live, Grill-adapted interview.

First establish the intended target. Investigate repository facts with read-only tools instead of asking the operator. Ask exactly one unresolved material choice per turn, include your recommended answer and its main reason, and recompute the next question after every answer. Challenge only assumptions, scope, trade-offs, failure modes, edge cases, and success criteria that can affect the result. Do not edit files or create implementation artifacts.

When no material choice remains, present a concise shared understanding and ask the operator to confirm it. If confirmation is withheld, continue questioning. After explicit confirmation, call juruc_set_questions as the sole tool call. Put researchable factual uncertainty in researchTargets; do not leave unresolved operator choices.`;

export const QUESTIONS_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"juruc_set_questions",
] as const;

export interface SetQuestionsInput {
	sharedUnderstanding: string;
	decisions: string[];
	acceptedAssumptions: string[];
	researchTargets: string[];
}

const text = { type: "string", pattern: "\\S" } as const;
const uniqueTextList = { type: "array", items: text, uniqueItems: true } as const;

export const SET_QUESTIONS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"sharedUnderstanding",
		"decisions",
		"acceptedAssumptions",
		"researchTargets",
	],
	properties: {
		sharedUnderstanding: text,
		decisions: uniqueTextList,
		acceptedAssumptions: uniqueTextList,
		researchTargets: uniqueTextList,
	},
} as const;

function cleanList(values: readonly string[]): string[] {
	return values.map((value) => value.trim());
}

export function questionsFromInput(input: SetQuestionsInput): TaskQuestions {
	return {
		sharedUnderstanding: input.sharedUnderstanding.trim(),
		decisions: cleanList(input.decisions),
		acceptedAssumptions: cleanList(input.acceptedAssumptions),
		researchTargets: cleanList(input.researchTargets),
	};
}

export function setTaskQuestions(
	task: TaskDocument,
	input: SetQuestionsInput,
): TaskDocument {
	return confirmTaskQuestions(task, questionsFromInput(input));
}

export function questionsPrompt(request: string): string {
	return `Original request:\n${request}`;
}
