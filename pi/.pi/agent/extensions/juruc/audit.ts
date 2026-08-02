import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runConfiguredAgent } from "../subagent/index.ts";
import {
	type AuditResult,
	childSessionDir,
	classifyResult,
	type RunResult,
} from "../subagent/runtimes.ts";
import type { PhaseAuditRequest } from "./execution.ts";

function numbered(items: readonly string[]): string {
	return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function phaseAuditPrompt(request: PhaseAuditRequest): string {
	const final = request.phase.position === request.phase.total;
	return [
		`JURUC task: ${request.task}`,
		`Worktree: ${request.worktree}`,
		`Phase ${request.phase.position}/${request.phase.total}: ${request.phase.title}`,
		`Objective: ${request.phase.objective}`,
		`Staged paths: ${request.stagedPaths.length ? request.stagedPaths.join(", ") : "none"}`,
		"",
		"Phase criteria:",
		numbered(request.phase.successCriteria),
		...(final
			? [
					"",
					`Overall base ref: ${request.baseRef}`,
					"Overall criteria:",
					numbered(request.overallCriteria),
				]
			: []),
	].join("\n");
}

function validatePhaseAudit(
	request: PhaseAuditRequest,
	audit: AuditResult,
): string | undefined {
	if (audit.verdict === "pass") return undefined;
	for (const finding of audit.findings) {
		if (finding.basis.source === "phase") {
			if (finding.basis.criterion > request.phase.successCriteria.length)
				return `audit cites absent phase criterion ${finding.basis.criterion}`;
			continue;
		}
		if (finding.basis.source === "overall") {
			if (request.phase.position !== request.phase.total)
				return "overall findings are only valid for the final phase";
			if (finding.basis.criterion > request.overallCriteria.length)
				return `audit cites absent overall criterion ${finding.basis.criterion}`;
		}
	}
	return undefined;
}

interface AuditRuntime {
	runAgent: typeof runConfiguredAgent;
	agentDir: string;
}

export async function runIndependentAudit(
	request: PhaseAuditRequest,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onProgress?: (result: RunResult) => void,
	runtime: AuditRuntime = {
		runAgent: runConfiguredAgent,
		agentDir: getAgentDir(),
	},
): Promise<AuditResult> {
	const result = await runtime.runAgent({
		agent: "audit",
		task: phaseAuditPrompt(request),
		cwd: request.worktree,
		auditBaseRef: request.baseRef,
		inherited: {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: ctx.thinkingLevel,
			sessionDir: childSessionDir(
				ctx.sessionManager.getSessionDir(),
				ctx.sessionManager.getSessionId(),
				runtime.agentDir,
			),
			sessionId: randomUUID(),
		},
		signal,
		onProgress,
	});
	const outcome = classifyResult(result);
	if (outcome.kind !== "success" || !result.audit)
		throw new Error(outcome.message ?? "independent audit failed");
	const invalid = validatePhaseAudit(request, result.audit);
	if (invalid) throw new Error(invalid);
	return result.audit;
}
