import {
	expectedTaskHead,
	runAuthoritativeVerification,
	runVerificationCommand,
	stageScopedCandidate,
	type VerificationOperations,
	type VerificationRunResult,
} from "./execution.ts";
import {
	completeTaskCorrection,
	currentTaskCorrectionRound,
	findTaskSession,
	MAX_TASK_TEXT_LENGTH,
	type TaskCorrectionFeedback,
	type TaskCorrectionPlan,
	type TaskDocument,
	type TaskReviewRound,
	type VerificationEvidence,
} from "./task.ts";
import { commitStaged, inspectTaskWorktree } from "./workspace.ts";

export const CORRECTION_INSTRUCTION = `Implement only the supplied accepted correction plan and confirmed feedback in the current worktree candidate. You have no shell tool. Do not commit, mutate Git HEAD or history, push, open a PR, or publish anything. Run every verification command in the accepted correction plan exactly as written and in accepted order through juruc_run_verification as a sole tool call; do not omit, reorder, duplicate, or invent commands. When every command exits zero and the accepted correction plan is complete, call juruc_finish_correction once with a concise resolution, commit message, and structured evidence containing every accepted command exactly once in accepted order. JURUC authoritatively reruns the full accepted command list, validates the correction-plan file scopes, stages the complete candidate, creates the local correction commit, and starts the next cumulative review round.`;

export const CORRECTION_TOOL_NAMES = [
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"juruc_run_verification",
	"juruc_finish_correction",
] as const;

const text = { type: "string", pattern: "\\S" } as const;
const persistedText = {
	type: "string",
	pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]*$",
	maxLength: MAX_TASK_TEXT_LENGTH,
} as const;

export const FINISH_CORRECTION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["resolution", "commitMessage", "verificationEvidence"],
	properties: {
		resolution: persistedText,
		commitMessage: text,
		verificationEvidence: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["command", "exitCode", "summary"],
				properties: {
					command: text,
					exitCode: { type: "integer" },
					summary: { ...text, maxLength: 1_000 },
				},
			},
		},
	},
} as const;

export interface FinishCorrectionInput {
	resolution: string;
	commitMessage: string;
	verificationEvidence: VerificationEvidence[];
}

export interface CorrectionCompletionResult {
	task: TaskDocument;
	commit: string;
}

interface CorrectionAuthority {
	round: TaskReviewRound;
	feedback: TaskCorrectionFeedback;
	plan: TaskCorrectionPlan;
}

function correctionAuthority(task: TaskDocument): CorrectionAuthority {
	const round = currentTaskCorrectionRound(task);
	if (!round) throw new Error("task has no running correction");
	const feedback = round.correction?.feedbackGrill?.confirmedFeedback;
	const plan = round.correction?.correctionPlan?.acceptedPlan;
	if (!feedback || !plan)
		throw new Error("running correction lacks confirmed feedback or an accepted correction plan");
	return { round, feedback, plan };
}

/** Exact verification commands from the current round's accepted correction plan. */
export function acceptedVerificationCommands(task: TaskDocument): string[] {
	return [...correctionAuthority(task).plan.verification];
}

/** Exact Git pathspec scopes from the current round's accepted correction plan. */
export function acceptedFileScopes(task: TaskDocument): string[] {
	return [...correctionAuthority(task).plan.fileScopes];
}

export function runCorrectionVerification(
	task: TaskDocument,
	command: string,
	operations: VerificationOperations,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<VerificationRunResult> {
	if (!acceptedVerificationCommands(task).includes(command))
		throw new Error("verification command is not in the accepted correction plan");
	return runVerificationCommand(
		command,
		task.repository.worktree,
		operations,
		signal,
		timeoutMs,
	);
}

export function correctionPrompt(task: TaskDocument, round: TaskReviewRound): string {
	if (!task.specification) throw new Error("correction requires a validated Specification");
	const authority = correctionAuthority(task);
	if (round.number !== authority.round.number)
		throw new Error("correction prompt round is not the current correction round");
	return [
		"Validated Specification:",
		JSON.stringify(task.specification, null, 2),
		"",
		"Confirmed TaskCorrectionFeedback:",
		JSON.stringify(authority.feedback, null, 2),
		"",
		"Accepted TaskCorrectionPlan:",
		JSON.stringify(authority.plan, null, 2),
		"",
		"The repository at this session's working directory is the current worktree candidate. It has not been committed. Do not commit.",
	].join("\n");
}

function validatedCorrectionEvidence(
	plan: TaskCorrectionPlan,
	reported: readonly VerificationEvidence[],
): VerificationEvidence[] {
	if (!Array.isArray(reported)) throw new Error("verification evidence must be an array");
	for (const evidence of reported) {
		if (
			evidence === null ||
			typeof evidence !== "object" ||
			Array.isArray(evidence) ||
			Object.keys(evidence).length !== 3 ||
			!Object.hasOwn(evidence, "command") ||
			!Object.hasOwn(evidence, "exitCode") ||
			!Object.hasOwn(evidence, "summary") ||
			typeof evidence.command !== "string" ||
			!evidence.command.trim() ||
			!Number.isInteger(evidence.exitCode) ||
			typeof evidence.summary !== "string" ||
			!evidence.summary.trim() ||
			evidence.summary.includes("\0") ||
			evidence.summary.length > 1_000
		) throw new Error("verification evidence is malformed");
	}
	if (reported.length !== plan.verification.length)
		throw new Error(`verification evidence count differs from the ${plan.verification.length} accepted commands`);
	for (const [index, command] of plan.verification.entries()) {
		if (reported[index].command !== command)
			throw new Error(`verification evidence command ${index + 1} must exactly equal: ${command}`);
	}
	const failed = reported.find((evidence) => evidence.exitCode !== 0);
	if (failed)
		throw new Error(`verification command exited with code ${failed.exitCode}: ${failed.command}`);
	return reported.map((evidence) => ({
		command: evidence.command,
		exitCode: evidence.exitCode,
		summary: evidence.summary.trim(),
	}));
}

export async function finishCorrection(
	task: TaskDocument,
	input: FinishCorrectionInput,
	operations: VerificationOperations,
	signal?: AbortSignal,
): Promise<CorrectionCompletionResult> {
	const { round, plan } = correctionAuthority(task);
	if (!findTaskSession(task, { kind: "correction", round: round.number }))
		throw new Error("running correction has no correction session");
	const resolution = input.resolution;
	const commitMessage = input.commitMessage.trim();
	if (
		typeof resolution !== "string" ||
		!resolution ||
		resolution !== resolution.trim() ||
		resolution.includes("\0") ||
		resolution.length > MAX_TASK_TEXT_LENGTH
	) throw new Error("correction resolution must be trimmed, nonempty, NUL-free, and within the task text limit");
	if (!commitMessage) throw new Error("commit message must be nonempty");
	const verificationEvidence = validatedCorrectionEvidence(plan, input.verificationEvidence);
	completeTaskCorrection(task, resolution, verificationEvidence, "0".repeat(40));
	const before = await inspectTaskWorktree(task.repository);
	if (before.head !== expectedTaskHead(task))
		throw new Error("correction session changed Git HEAD outside JURUC");
	await runAuthoritativeVerification(
		plan.verification,
		task.repository.worktree,
		operations,
		signal,
	);
	const verified = await inspectTaskWorktree(task.repository);
	if (verified.head !== expectedTaskHead(task))
		throw new Error("verification command changed Git HEAD outside JURUC");
	await stageScopedCandidate(
		task.repository,
		plan.fileScopes,
		"accepted correction-plan file scopes",
	);
	const commit = await commitStaged(task.repository, commitMessage);
	return {
		task: completeTaskCorrection(task, resolution, verificationEvidence, commit),
		commit,
	};
}
