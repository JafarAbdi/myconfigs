import {
	acceptTaskPlan,
	type TaskDocument,
	type TaskPhase,
	type TaskPlan,
	type TaskSpecification,
} from "./task.ts";

export const PLANNING_INSTRUCTION = `Create the smallest ordered implementation plan that satisfies the supplied validated Specification.

Inspect repository facts with read-only tools. Do not inspect Research, Questions, prior transcripts, or invent requirements. Each phase must be incrementally complete after its predecessors and declare a unique kebab-case id, title, goal, safe repository-relative file scopes, ordered implementation instructions, and exact runnable verification commands. Keep phases minimal and include relevant tests.

Present the complete plan to the operator and require explicit human acceptance. The accepted plan is final and immutable. Only after acceptance, call juruc_set_plan as the sole tool call.`;

export const PLANNING_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"juruc_set_plan",
] as const;

export interface PlanPhaseInput {
	id: string;
	title: string;
	goal: string;
	fileScopes: string[];
	instructions: string[];
	verification: string[];
}

export interface SetPlanInput {
	phases: PlanPhaseInput[];
}

const text = { type: "string", pattern: "\\S" } as const;
const textList = { type: "array", items: text } as const;

export const SET_PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["phases"],
	properties: {
		phases: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"id",
					"title",
					"goal",
					"fileScopes",
					"instructions",
					"verification",
				],
				properties: {
					id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
					title: text,
					goal: text,
					fileScopes: { ...textList, minItems: 1, uniqueItems: true },
					instructions: { ...textList, minItems: 1 },
					verification: { ...textList, minItems: 1, uniqueItems: true },
				},
			},
		},
	},
} as const;

function cleanList(values: readonly string[]): string[] {
	return values.map((value) => value.trim());
}

function phaseFromInput(phase: PlanPhaseInput): TaskPhase {
	return {
		id: phase.id.trim(),
		title: phase.title.trim(),
		goal: phase.goal.trim(),
		fileScopes: cleanList(phase.fileScopes),
		instructions: cleanList(phase.instructions),
		verification: cleanList(phase.verification),
	};
}

export function planFromInput(input: SetPlanInput): TaskPlan {
	return { phases: input.phases.map(phaseFromInput) };
}

export function confirmTaskPlan(
	task: TaskDocument,
	input: SetPlanInput,
): TaskDocument {
	return acceptTaskPlan(task, planFromInput(input));
}

export function planningPrompt(specification: TaskSpecification): string {
	return [
		"Validated Specification (the only task artifact available to Plan):",
		JSON.stringify(specification, null, 2),
	].join("\n");
}
