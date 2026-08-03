import {
	confirmTaskCorrectionFeedback,
	type HumanComment,
	type TaskCorrectionFeedback,
	type TaskDocument,
	type TaskSpecification,
} from "./task.ts";

export const FEEDBACK_INSTRUCTION = `Resolve every saved human review comment in this fresh, durable Feedback Grill session.

Investigate current repository facts with read-only tools instead of asking the operator. Ask exactly one unresolved material choice per turn, include your recommended answer and its main reason, and recompute the next question after every answer. Explicitly surface any conflict between a saved human comment and the validated Specification. Do not edit files or create implementation artifacts.

When no material choice remains, present a concise confirmed correction intent that resolves all saved comments and ask the operator for explicit confirmation. If confirmation is withheld, continue questioning. Only after explicit confirmation, call juruc_set_feedback as the sole tool call. Record the shared understanding, nonempty ordered corrections, unique decisions, and unique accepted assumptions. Do not leave unresolved operator choices.`;

export const FEEDBACK_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"juruc_set_feedback",
] as const;

export interface SetFeedbackInput {
	sharedUnderstanding: string;
	corrections: string[];
	decisions: string[];
	acceptedAssumptions: string[];
}

const text = { type: "string", pattern: "\\S" } as const;
const uniqueTextList = { type: "array", items: text, uniqueItems: true } as const;

export const SET_FEEDBACK_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"sharedUnderstanding",
		"corrections",
		"decisions",
		"acceptedAssumptions",
	],
	properties: {
		sharedUnderstanding: text,
		corrections: { type: "array", items: text, minItems: 1 },
		decisions: uniqueTextList,
		acceptedAssumptions: uniqueTextList,
	},
} as const;

function cleanList(values: readonly string[]): string[] {
	return values.map((value) => value.trim());
}

export function feedbackFromInput(input: SetFeedbackInput): TaskCorrectionFeedback {
	return {
		sharedUnderstanding: input.sharedUnderstanding.trim(),
		corrections: cleanList(input.corrections),
		decisions: cleanList(input.decisions),
		acceptedAssumptions: cleanList(input.acceptedAssumptions),
	};
}

export function setTaskFeedback(
	task: TaskDocument,
	input: SetFeedbackInput,
): TaskDocument {
	return confirmTaskCorrectionFeedback(task, feedbackFromInput(input));
}

const SIDE_ORDER = { deletions: 0, additions: 1 } as const;

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function orderedFeedbackComments(comments: readonly HumanComment[]): HumanComment[] {
	return [...comments].sort((left, right) =>
		compareText(left.filePath, right.filePath) ||
		SIDE_ORDER[left.side] - SIDE_ORDER[right.side] ||
		left.startLine - right.startLine ||
		left.endLine - right.endLine ||
		compareText(left.id, right.id));
}

export function feedbackPrompt(
	specification: TaskSpecification,
	comments: readonly HumanComment[],
): string {
	const orderedComments = orderedFeedbackComments(comments);
	if (!orderedComments.length)
		throw new Error("feedback grill requires at least one saved human comment");
	return [
		"Validated Specification:",
		JSON.stringify(specification, null, 2),
		"",
		"Saved human comments:",
		JSON.stringify(orderedComments, null, 2),
	].join("\n");
}
