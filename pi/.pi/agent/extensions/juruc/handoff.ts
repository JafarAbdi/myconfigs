import { git } from "./repository.ts";
import { classifyBase } from "./execution.ts";
import { readinessDimensions, type AcceptanceReadiness, type ReadinessDimensions, type RiskReadiness } from "./status.ts";
import type { BaseReadiness } from "./execution.ts";
import type { AcceptanceReceipt } from "./state.ts";
import type { TaskRecord } from "./tasks.ts";

export interface ReadinessHandoff extends ReadinessDimensions {
	acceptance: AcceptanceReadiness;
	risk: RiskReadiness;
	base: BaseReadiness;
	clean: boolean;
	paths: string[];
	text: string;
	concise: string;
}


async function changedPaths(task: TaskRecord, receipt: AcceptanceReceipt): Promise<string[]> {
	const result = await git(task.state.worktree, ["diff", "--name-status", "--no-renames", "-z", receipt.sourceHead, receipt.finalCommit, "--"]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "could not derive changed paths");
	const fields = result.stdout.split("\0").filter(Boolean);
	const paths: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		const status = fields[index];
		const path = fields[++index];
		if (!path) continue;
		paths.push(`${status}\t${path}`);
	}
	return paths;
}

function list(title: string, values: readonly string[]): string[] {
	return values.length ? [title, ...values.map((value) => `- ${value}`)] : [title, "- none"];
}

export async function deriveReadinessHandoff(task: TaskRecord): Promise<ReadinessHandoff> {
	if (task.state.phase !== "done") throw new Error("readiness handoff requires a completed task");
	const receipt = task.state.acceptance;
	const paths = await changedPaths(task, receipt);
	const status = await git(task.state.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.code !== 0) throw new Error(status.stderr.trim() || "could not inspect final cleanliness");
	const base = await classifyBase(task.state, receipt.baseHead);
	const clean = status.stdout.length === 0;
	const approved = task.plan.approved;
	if (!approved) throw new Error("completed task has no approved plan");
	const coverage = approved.successCriteria.map((criterion, index) => `[x] ${index + 1}. ${criterion}`);
	const phases = approved.completed.map((phase) => `${phase.id}: ${phase.title} — ${phase.resolution}${phase.commit ? ` (${phase.commit})` : " (no commit)"}`);
	const decisions = approved.decisions.map(({ decision, rationale, alternatives }) => `${decision} — ${rationale}${alternatives.length ? ` (alternatives: ${alternatives.join("; ")})` : ""}`);
	const risks = approved.risks.map(({ risk, consequence, mitigation }) => `${risk} — consequence: ${consequence}; mitigation: ${mitigation}`);
	const amendments = approved.completed.flatMap((phase) => phase.amendments.map((amendment) => `${phase.id}: ${amendment}`));
	const baseLabel = base === "current" ? "current" : base === "moved" ? "moved" : "deleted or rewritten";
	const dimensions = readinessDimensions(task, base);
	const { acceptance, risk } = dimensions;
	const concise = `Accepted (${risk}; ${baseLabel} base; ${clean ? "clean" : "not clean"}) — ${task.plan.title}: ${approved.objective}`;
	const text = [
		`# Reviewer handoff: ${task.plan.title}`,
		"",
		`Objective: ${approved.objective}`,
		`Desired end state: ${approved.desiredEndState}`,
		"",
		"## Git identity",
		`Source: ${receipt.sourceHead}`,
		`Base (${task.state.baseBranch}): ${receipt.baseHead} (${baseLabel})`,
		`Final parent: ${receipt.finalParent}`,
		`Final commit: ${receipt.finalCommit}`,
		`Final tree: ${receipt.finalTree}`,
		"",
		`## Aggregate audit (${approved.successCriteria.length}/${approved.successCriteria.length} criteria accepted)`,
		`Acceptance: ${acceptance}`,
		`Risk: ${risk}`,
		receipt.auditSummary,
		...coverage,
		"",
		...list("## Completed phases", phases),
		"",
		...list("## Decisions", decisions),
		"",
		...list("## Assumptions", approved.assumptions),
		"",
		...list("## Accepted risks", risks),
		"",
		...list("## Non-goals", approved.nonGoals),
		"",
		...list("## Retained amendments", amendments),
		"",
		...list("## Changed paths", paths),
		`Cleanliness: ${clean ? "clean" : `not clean\n${status.stdout.trimEnd()}`}`,
		`Base readiness: ${baseLabel}`,
	].join("\n");
	return { ...dimensions, clean, paths, text, concise };
}
