import { join } from "node:path";
import { canonicalPrompt } from "./prompts.ts";
import {
	setTaskPlan,
	type TaskDocument,
	type TaskPhase,
	type TaskPlanInput,
} from "./task.ts";

export const PLANNING_INSTRUCTION = `Plan under the canonical /grill prompt using the working directory and JURUC planning context.

Read research.md first as non-authoritative evidence; task.json is authoritative. Do not modify the worktree and do not invent missing facts.

Classify confirmed material as task-specific or durable project context. Before /grill's single final confirmation, show each durable change's exact target path and exact entries under Objective, Requirements, Invariants, Constraints, Assumptions, and Non-Goals, or state "Durable project context: None." Use the narrowest governing existing file; reserve Git-root AGENTS.md for project-wide rules. Preserve an existing context file's format.

Before final confirmation, present assumptions, accepted risks, deferred non-goals, and every blocker with its disposition. An unresolved blocker means do not call juruc_set_plan. Represent every confirmed context edit in the earliest affected phase's success criteria. Only after human confirmation, call juruc_set_plan once with the complete ordered remaining plan. Phases must be minimal, incrementally complete, independently verifiable after their predecessors, include relevant tests, and not depend on later phases for validity.`;

export const PLANNING_TOOL_NAMES = ["read", "juruc_set_plan"] as const;

export interface PlanPhaseInput {
	title: string;
	objective: string;
	successCriteria: string[];
	hints?: string[];
}

export interface SetPlanInput {
	objective: string;
	constraints: string[];
	assumptions: string[];
	nonGoals: string[];
	successCriteria: string[];
	futurePhases: PlanPhaseInput[];
}

const text = { type: "string", pattern: "\\S" } as const;
const textList = { type: "array", items: text } as const;

export const SET_PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"objective",
		"constraints",
		"assumptions",
		"nonGoals",
		"successCriteria",
		"futurePhases",
	],
	properties: {
		objective: text,
		constraints: textList,
		assumptions: textList,
		nonGoals: textList,
		successCriteria: { ...textList, minItems: 1 },
		futurePhases: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["title", "objective", "successCriteria"],
				properties: {
					title: text,
					objective: text,
					successCriteria: { ...textList, minItems: 1 },
					hints: textList,
				},
			},
		},
	},
} as const;

function cleanText(value: string): string {
	return value.trim();
}

function cleanList(values: readonly string[]): string[] {
	return values.map(cleanText);
}

function phaseFromInput(phase: PlanPhaseInput): TaskPhase {
	return {
		title: cleanText(phase.title),
		objective: cleanText(phase.objective),
		successCriteria: cleanList(phase.successCriteria),
		hints: cleanList(phase.hints ?? []),
	};
}

export function taskPlanInput(input: SetPlanInput): TaskPlanInput {
	return {
		objective: cleanText(input.objective),
		constraints: cleanList(input.constraints),
		assumptions: cleanList(input.assumptions),
		nonGoals: cleanList(input.nonGoals),
		successCriteria: cleanList(input.successCriteria),
		remaining: input.futurePhases.map(phaseFromInput),
	};
}

export function confirmTaskPlan(
	task: TaskDocument,
	input: SetPlanInput,
): TaskDocument {
	return setTaskPlan(task, taskPlanInput(input));
}

export function planningSessionInstruction(taskDirectory: string): string {
	return [
		PLANNING_INSTRUCTION,
		`Task state: ${join(taskDirectory, "task.json")}`,
		`Task research: ${join(taskDirectory, "research.md")}`,
	].join("\n\n");
}

interface PromptCommand {
	name: string;
	source: string;
	sourceInfo: { path: string };
}

export function planningPrompt(
	commands: readonly PromptCommand[],
	subject: string,
): string {
	return canonicalPrompt(commands, "grill", subject);
}
