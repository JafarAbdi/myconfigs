import type { AuditResult } from "../subagent/runtimes.ts";
import {
	blockTaskPhase,
	completeTaskPhase,
	type TaskDocument,
} from "./task.ts";
import {
	commitStaged,
	inspectTaskWorktree,
	stageAll,
	unstageAll,
} from "./workspace.ts";

export const BUILD_INSTRUCTION = `Implement and verify only the active phase in task.json. Do not run git commit. Preserve dirty work when blocked. When the phase criteria are satisfied, call juruc_finish_phase once with a concise resolution and commit message. JURUC stages the complete candidate, runs the independent audit, and commits only on success. If a material decision prevents completion, call juruc_block_phase with the reason.`;

export const BUILD_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"delegate",
	"juruc_finish_phase",
	"juruc_block_phase",
] as const;

export interface FinishPhaseInput {
	resolution: string;
	commitMessage: string;
}

export interface PhaseAuditRequest {
	task: string;
	worktree: string;
	baseRef: string;
	phase: {
		position: number;
		total: number;
		title: string;
		objective: string;
		successCriteria: string[];
	};
	overallCriteria: string[];
	stagedPaths: string[];
}

const text = { type: "string", pattern: "\\S" } as const;

export const FINISH_PHASE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["resolution", "commitMessage"],
	properties: {
		resolution: text,
		commitMessage: text,
	},
} as const;

export const BLOCK_PHASE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["reason"],
	properties: { reason: text },
} as const;

export type AuditRunner = (
	request: PhaseAuditRequest,
) => Promise<AuditResult>;

export type PhaseCompletionResult =
	| {
			kind: "audit-failed";
			task: TaskDocument;
			audit: Extract<AuditResult, { verdict: "fail" }>;
			feedback: string;
	  }
	| {
			kind: "completed";
			task: TaskDocument;
			audit: Extract<AuditResult, { verdict: "pass" }>;
			commit: string | null;
	  };

export function expectedTaskHead(task: TaskDocument): string {
	if (!task.plan) return task.repository.sourceHead;
	for (let index = task.plan.completed.length - 1; index >= 0; index--) {
		const commit = task.plan.completed[index].commit;
		if (commit) return commit;
	}
	return task.repository.sourceHead;
}

export function currentAuditRequest(
	task: TaskDocument,
	stagedPaths: string[],
): PhaseAuditRequest {
	if (task.stage !== "building" || !task.plan?.remaining.length)
		throw new Error("task has no active build phase");
	const current = task.plan.remaining[0];
	const final = task.plan.remaining.length === 1;
	return {
		task: task.slug,
		worktree: task.repository.worktree,
		baseRef: final ? task.repository.sourceHead : expectedTaskHead(task),
		phase: {
			position: task.plan.completed.length + 1,
			total: task.plan.completed.length + task.plan.remaining.length,
			title: current.title,
			objective: current.objective,
			successCriteria: [...current.successCriteria],
		},
		overallCriteria: final ? [...task.plan.successCriteria] : [],
		stagedPaths: [...stagedPaths],
	};
}

function auditFeedback(
	audit: Extract<AuditResult, { verdict: "fail" }>,
): string {
	return audit.findings
		.map((finding, index) => {
			const basis = finding.basis.source === "context"
				? `${finding.basis.path}: ${finding.basis.rule}`
				: `${finding.basis.source} criterion ${finding.basis.criterion}`;
			return `${index + 1}. [${basis}] ${finding.path}: ${finding.failure}\nEvidence: ${finding.evidence}`;
		})
		.join("\n\n");
}

async function unstageAfterAudit(repository: TaskDocument["repository"]): Promise<void> {
	await unstageAll(repository);
}

export async function finishCurrentPhase(
	task: TaskDocument,
	input: FinishPhaseInput,
	runAudit: AuditRunner,
): Promise<PhaseCompletionResult> {
	if (task.stage !== "building" || !task.plan?.remaining.length)
		throw new Error("task has no active build phase");
	if (!task.sessions.build)
		throw new Error("active phase has no build session");
	const resolution = input.resolution.trim();
	const commitMessage = input.commitMessage.trim();
	if (!resolution || !commitMessage)
		throw new Error("phase resolution and commit message must be nonempty");
	const before = await inspectTaskWorktree(task.repository);
	const expectedHead = expectedTaskHead(task);
	if (before.head !== expectedHead)
		throw new Error("implementation session changed Git HEAD outside JURUC");

	const stagedPaths = await stageAll(task.repository);
	const staged = new Set(stagedPaths);
	const candidate = await inspectTaskWorktree(task.repository);
	const unstagedPaths = candidate.paths.filter((path) => !staged.has(path));
	if (unstagedPaths.length) {
		await unstageAll(task.repository);
		throw new Error(
			`git add -A could not stage the complete candidate: ${unstagedPaths.join(", ")}`,
		);
	}
	let audit: AuditResult;
	try {
		audit = await runAudit(currentAuditRequest(task, stagedPaths));
	} catch (error) {
		await unstageAfterAudit(task.repository);
		throw error;
	}
	if (audit.verdict === "fail") {
		await unstageAfterAudit(task.repository);
		return {
			kind: "audit-failed",
			task: structuredClone(task),
			audit,
			feedback: auditFeedback(audit),
		};
	}

	const commit = stagedPaths.length
		? await commitStaged(task.repository, commitMessage)
		: null;
	return {
		kind: "completed",
		task: completeTaskPhase(task, resolution, commit),
		audit,
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
