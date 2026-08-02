import {
	blockTaskPhase,
	completeTaskPhase,
	type TaskDocument,
	type VerificationEvidence,
} from "./task.ts";
import {
	commitStaged,
	inspectTaskWorktree,
	stageAll,
	unstageAll,
} from "./workspace.ts";

export const BUILD_INSTRUCTION = `Implement only the active phase in task.json and run every declared verification command exactly as written, in order. Do not run other verification commands and do not run git commit. Preserve dirty work when blocked. When every command exits zero and the phase criteria are satisfied, call juruc_finish_phase once with a concise resolution, commit message, and structured evidence for every command. JURUC validates the evidence, stages the complete changed candidate, creates the checkpoint commit, and advances. If a command fails, fix the phase and rerun its declared verification before reporting completion. If a material decision prevents completion, call juruc_block_phase with the reason.`;

export const BUILD_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"juruc_finish_phase",
	"juruc_block_phase",
] as const;

export interface FinishPhaseInput {
	resolution: string;
	commitMessage: string;
	verificationEvidence: VerificationEvidence[];
}

const text = { type: "string", pattern: "\\S" } as const;

export const FINISH_PHASE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["resolution", "commitMessage", "verificationEvidence"],
	properties: {
		resolution: text,
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

export const BLOCK_PHASE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["reason"],
	properties: { reason: text },
} as const;

export interface PhaseCompletionResult {
	task: TaskDocument;
	commit: string;
}

export function expectedTaskHead(task: TaskDocument): string {
	if (!task.plan) return task.repository.sourceHead;
	return task.plan.completed.at(-1)?.commit ?? task.repository.sourceHead;
}

function validatedVerificationEvidence(
	task: TaskDocument,
	reported: readonly VerificationEvidence[],
): VerificationEvidence[] {
	const declared = task.plan?.remaining[0]?.verification;
	if (!declared) throw new Error("task has no active build phase");
	if (!Array.isArray(reported))
		throw new Error("verification evidence must be an array");
	const commands = new Set<string>();
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
		)
			throw new Error("verification evidence is malformed");
		if (commands.has(evidence.command))
			throw new Error(`verification evidence duplicates command: ${evidence.command}`);
		commands.add(evidence.command);
	}
	if (reported.length !== declared.length)
		throw new Error(
			`verification evidence count differs from the ${declared.length} declared commands`,
		);
	for (const [index, command] of declared.entries()) {
		if (reported[index].command !== command)
			throw new Error(
				`verification evidence command ${index + 1} must exactly equal: ${command}`,
			);
	}
	const failed = reported.find((evidence) => evidence.exitCode !== 0);
	if (failed)
		throw new Error(
			`verification command exited with code ${failed.exitCode}: ${failed.command}`,
		);
	return reported.map((evidence) => ({
		command: evidence.command,
		exitCode: evidence.exitCode,
		summary: evidence.summary.trim(),
	}));
}

export async function finishCurrentPhase(
	task: TaskDocument,
	input: FinishPhaseInput,
): Promise<PhaseCompletionResult> {
	if (task.stage !== "building" || !task.plan?.remaining.length)
		throw new Error("task has no active build phase");
	if (!task.sessions.build)
		throw new Error("active phase has no build session");
	const resolution = input.resolution.trim();
	const commitMessage = input.commitMessage.trim();
	if (!resolution || !commitMessage)
		throw new Error("phase resolution and commit message must be nonempty");
	const verificationEvidence = validatedVerificationEvidence(
		task,
		input.verificationEvidence,
	);
	const before = await inspectTaskWorktree(task.repository);
	const expectedHead = expectedTaskHead(task);
	if (before.head !== expectedHead)
		throw new Error("implementation session changed Git HEAD outside JURUC");

	const stagedPaths = await stageAll(task.repository);
	if (stagedPaths.length === 0)
		throw new Error("unchanged candidate; refusing an empty checkpoint commit");
	const staged = new Set(stagedPaths);
	const candidate = await inspectTaskWorktree(task.repository);
	const unstagedPaths = candidate.paths.filter((path) => !staged.has(path));
	if (unstagedPaths.length) {
		await unstageAll(task.repository);
		throw new Error(
			`git add -A could not stage the complete candidate: ${unstagedPaths.join(", ")}`,
		);
	}
	const commit = await commitStaged(task.repository, commitMessage);
	return {
		task: completeTaskPhase(task, resolution, verificationEvidence, commit),
		commit,
	};
}

export async function blockCurrentPhase(
	task: TaskDocument,
	reason: string,
): Promise<TaskDocument> {
	if (task.stage !== "building") throw new Error("task is not building");
	const status = await inspectTaskWorktree(task.repository);
	if (status.head !== expectedTaskHead(task))
		throw new Error("implementation session changed Git HEAD outside JURUC");
	await unstageAll(task.repository);
	return blockTaskPhase(task, reason.trim());
}
