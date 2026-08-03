import { PLAN_DECISIONS } from "./planning.ts";
import {
	acceptTaskCorrectionPlan,
	type TaskCorrectionFeedback,
	type TaskCorrectionPlan,
	type TaskDocument,
	type TaskSpecification,
} from "./task.ts";

export const CORRECTION_PLANNING_INSTRUCTION = `Create the smallest bounded correction plan that satisfies the validated Specification and confirmed correction feedback in this fresh read-only session.

Inspect repository facts with read-only tools. The correction plan must declare its goal, safe repository-relative file scopes, dependencies, ordered implementation instructions, and exact runnable verification commands. It may deliberately expand the original Plan's scopes, dependencies, or commands because this accepted correction plan becomes the authority for correction implementation. Do not edit files or create implementation artifacts.

Present the complete correction plan to the operator, then call juruc_set_correction_plan as the sole tool call. That tool opens JURUC's correction-plan decision selector, which owns human acceptance: never ask the operator to type an acceptance phrase or confirm the plan in chat. When the operator asks to revise, address the returned feedback, present the complete replacement correction plan, and call juruc_set_correction_plan again. An accepted correction plan is final and immutable.`;

export const CORRECTION_PLANNING_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"juruc_set_correction_plan",
] as const;

export const CORRECTION_PLAN_DECISIONS = PLAN_DECISIONS;
export const CORRECTION_PLAN_DECISION_TITLE =
	"Accept this correction plan? Acceptance is final and the accepted correction plan is immutable.";
export const CORRECTION_PLAN_REVISION_TITLE =
	"What should the revised correction plan change?";
export const CORRECTION_PLAN_DECISION_UNRESOLVED =
	"The operator did not accept the correction plan. Nothing was persisted and the task is unchanged. Stop and wait for the operator.";

export interface SetCorrectionPlanInput {
	goal: string;
	fileScopes: string[];
	dependencies: string[];
	instructions: string[];
	verification: string[];
}

const text = { type: "string", pattern: "\\S" } as const;
const textList = { type: "array", items: text } as const;

export const SET_CORRECTION_PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"goal",
		"fileScopes",
		"dependencies",
		"instructions",
		"verification",
	],
	properties: {
		goal: text,
		fileScopes: { ...textList, minItems: 1, uniqueItems: true },
		dependencies: { ...textList, uniqueItems: true },
		instructions: { ...textList, minItems: 1 },
		verification: { ...textList, minItems: 1, uniqueItems: true },
	},
} as const;

function cleanList(values: readonly string[]): string[] {
	return values.map((value) => value.trim());
}

export function correctionPlanFromInput(
	input: SetCorrectionPlanInput,
): TaskCorrectionPlan {
	return {
		goal: input.goal.trim(),
		fileScopes: cleanList(input.fileScopes),
		dependencies: cleanList(input.dependencies),
		instructions: cleanList(input.instructions),
		verification: cleanList(input.verification),
	};
}

export function acceptCorrectionPlan(
	task: TaskDocument,
	input: SetCorrectionPlanInput,
): TaskDocument {
	return acceptTaskCorrectionPlan(task, correctionPlanFromInput(input));
}

export function correctionPlanningPrompt(
	specification: TaskSpecification,
	feedback: TaskCorrectionFeedback,
): string {
	return [
		"Validated Specification:",
		JSON.stringify(specification, null, 2),
		"",
		"Confirmed correction feedback:",
		JSON.stringify(feedback, null, 2),
	].join("\n");
}

export function correctionPlanRevisionRequest(feedback: string): string {
	if (!feedback.trim()) throw new Error("correction plan revision feedback must be nonblank");
	return [
		"The operator chose Revise plan. Nothing was persisted and the task is unchanged.",
		"",
		"Operator revision feedback:",
		feedback,
		"",
		"Revise the correction plan accordingly, present the complete replacement correction plan, and call juruc_set_correction_plan again to reopen the decision selector. Never ask the operator to type an acceptance phrase.",
	].join("\n");
}

export type CorrectionPlanDecisionResult =
	| { kind: "accept"; task: TaskDocument }
	| { kind: "revise"; feedback: string; message: string }
	| { kind: "unresolved"; message: string };

export function decideCorrectionPlan(
	task: TaskDocument,
	input: SetCorrectionPlanInput,
	decision: string | undefined,
	feedback?: string,
): CorrectionPlanDecisionResult {
	const accepted = acceptCorrectionPlan(task, input);
	if (decision === CORRECTION_PLAN_DECISIONS.accept)
		return { kind: "accept", task: accepted };
	if (decision === CORRECTION_PLAN_DECISIONS.revise && feedback?.trim())
		return {
			kind: "revise",
			feedback,
			message: correctionPlanRevisionRequest(feedback),
		};
	return { kind: "unresolved", message: CORRECTION_PLAN_DECISION_UNRESOLVED };
}
