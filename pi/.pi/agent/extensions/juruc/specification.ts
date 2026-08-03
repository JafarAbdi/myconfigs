import {
	confirmTaskSpecification,
	type TaskDocument,
	type TaskQuestions,
	type TaskSpecification,
} from "./task.ts";

export const SPECIFICATION_INSTRUCTION = `Produce factual, implementation-neutral requirements from only the supplied request, confirmed Questions result, and research report. Do not inspect the repository, plan phases, choose implementation details, or infer facts from prior transcripts. Resolve the material into a concise summary, requirements, non-goals, constraints, acceptance criteria, and carried decisions. Then call juruc_set_specification as the sole tool call.`;

export const SPECIFICATION_TOOL_NAMES = ["juruc_set_specification"] as const;

export interface SetSpecificationInput {
	summary: string;
	requirements: string[];
	nonGoals: string[];
	constraints: string[];
	acceptanceCriteria: string[];
	decisions: string[];
}

const text = { type: "string", pattern: "\\S" } as const;
const uniqueTextList = { type: "array", items: text, uniqueItems: true } as const;

export const SET_SPECIFICATION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"summary",
		"requirements",
		"nonGoals",
		"constraints",
		"acceptanceCriteria",
		"decisions",
	],
	properties: {
		summary: text,
		requirements: { ...uniqueTextList, minItems: 1 },
		nonGoals: uniqueTextList,
		constraints: uniqueTextList,
		acceptanceCriteria: { ...uniqueTextList, minItems: 1 },
		decisions: uniqueTextList,
	},
} as const;

function cleanList(values: readonly string[]): string[] {
	return values.map((value) => value.trim());
}

export function specificationFromInput(
	input: SetSpecificationInput,
): TaskSpecification {
	return {
		summary: input.summary.trim(),
		requirements: cleanList(input.requirements),
		nonGoals: cleanList(input.nonGoals),
		constraints: cleanList(input.constraints),
		acceptanceCriteria: cleanList(input.acceptanceCriteria),
		decisions: cleanList(input.decisions),
	};
}

export function setTaskSpecification(
	task: TaskDocument,
	input: SetSpecificationInput,
): TaskDocument {
	return confirmTaskSpecification(task, specificationFromInput(input));
}

export function specificationPrompt(
	request: string,
	questions: TaskQuestions,
	researchText: string,
): string {
	return [
		"Original request:",
		request,
		"",
		"Confirmed Questions result:",
		JSON.stringify(questions, null, 2),
		"",
		"Research report:",
		researchText,
	].join("\n");
}
