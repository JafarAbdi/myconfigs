import { isDeepStrictEqual } from "node:util";
import {
	completeTaskPhase,
	currentTaskPhase,
	findTaskSession,
	MAX_TASK_TEXT_LENGTH,
	validTaskDocument,
	type TaskDocument,
	type VerificationEvidence,
} from "./task.ts";
import type { StoredTask } from "./tasks.ts";
import {
	commitStaged,
	inspectTaskWorktree,
	stageAll,
	stagedPathsMatchingScopes,
	unstageAll,
} from "./workspace.ts";

export const BUILD_INSTRUCTION = `Implement only the authoritative active phase supplied by JURUC. You have no shell tool. Run only the current phase's declared verification commands, exactly as written, through juruc_run_verification as a sole tool call. You may rerun them while fixing failures. Do not commit, mutate Git HEAD or history, push, open a PR, or publish anything. If verification fails, fix the phase and rerun it; leave the phase open and resumable if work cannot continue. When every command exits zero and the phase goal is satisfied, call juruc_finish_phase once with a concise resolution, commit message, and structured evidence for every command. JURUC validates evidence and file scopes, stages the changed candidate, creates the checkpoint commit, and advances.`;

export const BUILD_TOOL_NAMES = [
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"juruc_run_verification",
	"juruc_finish_phase",
] as const;

export interface RunVerificationInput {
	command: string;
}

export interface VerificationRunResult {
	command: string;
	exitCode?: number;
	output: string;
	truncated: boolean;
	cancelled: boolean;
	timedOut: boolean;
}

export interface VerificationOperations {
	exec(
		command: string,
		cwd: string,
		options: {
			onData(data: Buffer): void;
			signal?: AbortSignal;
			timeout?: number;
		},
	): Promise<{ exitCode: number | null }>;
}

export interface FinishPhaseInput {
	resolution: string;
	commitMessage: string;
	verificationEvidence: VerificationEvidence[];
}

const text = { type: "string", pattern: "\\S" } as const;

export const RUN_VERIFICATION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["command"],
	properties: { command: text },
} as const;
const persistedText = {
	type: "string",
	pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]*$",
	maxLength: MAX_TASK_TEXT_LENGTH,
} as const;

export const FINISH_PHASE_SCHEMA = {
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

export interface PhaseCompletionResult {
	task: TaskDocument;
	commit: string;
}

export interface CheckpointPersistenceOperations {
	save(task: StoredTask, document: TaskDocument): StoredTask;
	reload(): StoredTask;
	recover(): Promise<void>;
}

export async function persistCheckpointTask(
	oldTask: StoredTask,
	newDocument: TaskDocument,
	operations: CheckpointPersistenceOperations,
): Promise<StoredTask> {
	if (!validTaskDocument(oldTask.document) || !validTaskDocument(newDocument))
		throw new Error("checkpoint persistence requires valid task documents");
	try {
		return operations.save(oldTask, newDocument);
	} catch (saveError) {
		let installed: StoredTask;
		try {
			installed = operations.reload();
			if (!validTaskDocument(installed.document))
				throw new Error("reloaded task.json is invalid");
		} catch (reloadError) {
			throw new AggregateError(
				[saveError, reloadError],
				"task persistence failed and installed task.json state is ambiguous; Git history was not changed",
			);
		}
		if (isDeepStrictEqual(installed.document, newDocument)) {
			try {
				return operations.save(installed, newDocument);
			} catch (retryError) {
				throw new AggregateError(
					[saveError, retryError],
					"checkpoint task.json is installed but its durability retry failed; aligned Git commit was retained",
				);
			}
		}
		if (isDeepStrictEqual(installed.document, oldTask.document)) {
			try {
				await operations.recover();
			} catch (recoveryError) {
				throw new AggregateError(
					[saveError, recoveryError],
					"task persistence failed and its unrecorded commit could not be recovered",
				);
			}
			throw saveError;
		}
		throw new AggregateError(
			[saveError],
			"task persistence failed and installed task.json state is ambiguous; Git history was not changed",
		);
	}
}

export function expectedTaskHead(task: TaskDocument): string {
	return task.reviewRounds.at(-1)?.headCommit ??
		task.checkpoints.at(-1)?.commit ??
		task.repository.sourceHead;
}

const VERIFICATION_TIMEOUT_MS = 120_000;
const MAX_VERIFICATION_OUTPUT_BYTES = 50 * 1024;

export function runVerificationCommand(
	command: string,
	cwd: string,
	operations: VerificationOperations,
	signal?: AbortSignal,
	timeoutMs = VERIFICATION_TIMEOUT_MS,
): Promise<VerificationRunResult> {
	if (signal?.aborted)
		return Promise.resolve({ command, output: "", truncated: false, cancelled: true, timedOut: false });

	const chunks: Buffer[] = [];
	let retainedBytes = 0;
	let truncated = false;
	const append = (chunk: Buffer): void => {
		const remaining = MAX_VERIFICATION_OUTPUT_BYTES - retainedBytes;
		if (remaining > 0) {
			const kept = chunk.subarray(0, remaining);
			chunks.push(kept);
			retainedBytes += kept.length;
		}
		if (chunk.length > remaining) truncated = true;
	};
	return operations.exec(
		command,
		cwd,
		{
			onData: append,
			signal,
			timeout: timeoutMs / 1_000,
		},
	).then(
		(result) => ({
			command,
			exitCode: result.exitCode ?? 1,
			output: Buffer.concat(chunks).toString("utf8"),
			truncated,
			cancelled: false,
			timedOut: false,
		}),
		(error: unknown) => {
			const output = Buffer.concat(chunks).toString("utf8");
			if (signal?.aborted)
				return { command, output, truncated, cancelled: true, timedOut: false };
			if (error instanceof Error && error.message.startsWith("timeout:"))
				return { command, output, truncated, cancelled: false, timedOut: true };
			throw error;
		},
	);
}

export function runDeclaredVerification(
	task: TaskDocument,
	command: string,
	operations: VerificationOperations,
	signal?: AbortSignal,
	timeoutMs = VERIFICATION_TIMEOUT_MS,
): Promise<VerificationRunResult> {
	const phase = currentTaskPhase(task);
	if (task.stage !== "implementation" || !phase)
		throw new Error("task has no active implementation phase");
	if (!phase.verification.includes(command))
		throw new Error("verification command is not declared by the active phase");
	return runVerificationCommand(
		command,
		task.repository.worktree,
		operations,
		signal,
		timeoutMs,
	);
}

export async function runAuthoritativeVerification(
	commands: readonly string[],
	cwd: string,
	operations: VerificationOperations,
	signal?: AbortSignal,
): Promise<void> {
	for (const command of commands) {
		const result = await runVerificationCommand(command, cwd, operations, signal);
		if (result.cancelled)
			throw new Error(`authoritative verification was cancelled: ${command}`);
		if (result.timedOut)
			throw new Error(`authoritative verification timed out: ${command}`);
		if (result.exitCode === undefined)
			throw new Error(`authoritative verification returned no exit code: ${command}`);
		if (result.exitCode !== 0)
			throw new Error(`authoritative verification exited with code ${result.exitCode}: ${command}`);
	}
}

/** Stages the complete worktree candidate and keeps it only if Git matches every scope. */
export async function stageScopedCandidate(
	repository: TaskDocument["repository"],
	fileScopes: readonly string[],
	scopeLabel: string,
): Promise<void> {
	const stagedPaths = await stageAll(repository);
	if (stagedPaths.length === 0)
		throw new Error("unchanged candidate; refusing an empty commit");
	const staged = new Set(stagedPaths);
	try {
		const matched = new Set(await stagedPathsMatchingScopes(repository, fileScopes));
		const outside = stagedPaths.filter((path) => !matched.has(path));
		if (outside.length)
			throw new Error(`candidate paths outside ${scopeLabel}: ${outside.join(", ")}`);
		const candidate = await inspectTaskWorktree(repository);
		const unstagedPaths = candidate.paths.filter((path) => !staged.has(path));
		if (unstagedPaths.length)
			throw new Error(`git add -A could not stage the complete candidate: ${unstagedPaths.join(", ")}`);
	} catch (error) {
		await unstageAll(repository);
		throw error;
	}
}

function validatedVerificationEvidence(
	task: TaskDocument,
	reported: readonly VerificationEvidence[],
): VerificationEvidence[] {
	const declared = currentTaskPhase(task)?.verification;
	if (!declared) throw new Error("task has no active implementation phase");
	if (!Array.isArray(reported)) throw new Error("verification evidence must be an array");
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
		) throw new Error("verification evidence is malformed");
		if (commands.has(evidence.command))
			throw new Error(`verification evidence duplicates command: ${evidence.command}`);
		commands.add(evidence.command);
	}
	if (reported.length !== declared.length)
		throw new Error(`verification evidence count differs from the ${declared.length} declared commands`);
	for (const [index, command] of declared.entries()) {
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

export async function finishCurrentPhase(
	task: TaskDocument,
	input: FinishPhaseInput,
	operations: VerificationOperations,
	signal?: AbortSignal,
): Promise<PhaseCompletionResult> {
	if (task.stage !== "implementation" || !currentTaskPhase(task))
		throw new Error("task has no active implementation phase");
	const phaseNumber = task.checkpoints.length + 1;
	const phase = currentTaskPhase(task)!;
	if (!findTaskSession(task, { kind: "implementation", phase: phaseNumber }))
		throw new Error("active phase has no implementation session");
	const resolution = input.resolution;
	const commitMessage = input.commitMessage.trim();
	if (
		typeof resolution !== "string" ||
		!resolution ||
		resolution !== resolution.trim() ||
		resolution.includes("\0") ||
		resolution.length > MAX_TASK_TEXT_LENGTH
	) throw new Error("phase resolution must be trimmed, nonempty, NUL-free, and within the task text limit");
	if (!commitMessage) throw new Error("commit message must be nonempty");
	const verificationEvidence = validatedVerificationEvidence(task, input.verificationEvidence);
	completeTaskPhase(task, resolution, verificationEvidence, "0".repeat(40));
	const before = await inspectTaskWorktree(task.repository);
	if (before.head !== expectedTaskHead(task))
		throw new Error("implementation session changed Git HEAD outside JURUC");
	await runAuthoritativeVerification(
		phase.verification,
		task.repository.worktree,
		operations,
		signal,
	);
	const verified = await inspectTaskWorktree(task.repository);
	if (verified.head !== expectedTaskHead(task))
		throw new Error("verification command changed Git HEAD outside JURUC");
	await stageScopedCandidate(task.repository, phase.fileScopes, "active phase file scopes");
	const commit = await commitStaged(task.repository, commitMessage);
	return {
		task: completeTaskPhase(task, resolution, verificationEvidence, commit),
		commit,
	};
}
