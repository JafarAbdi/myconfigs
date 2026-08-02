import type { BaseReadiness } from "./execution.ts";
import type { TaskRecord } from "./tasks.ts";

export type AcceptanceReadiness = "accepted" | "not-ready";
export type RiskReadiness = "clear" | "accepted-risks";
export interface ReadinessDimensions {
	acceptance: AcceptanceReadiness;
	risk: RiskReadiness;
	base: BaseReadiness;
}

export function readinessDimensions(task: TaskRecord, base: BaseReadiness): ReadinessDimensions {
	return {
		acceptance: task.state.phase === "done" ? "accepted" : "not-ready",
		risk: task.plan.approved?.risks.length ? "accepted-risks" : "clear",
		base,
	};
}

export const LIFECYCLE_STAGES = ["research", "plan", "build", "done"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface LifecyclePlace {
	active: LifecycleStage;
	detail: string;
}

export interface PhasePosition {
	position: number;
	total: number;
}

export function phasePosition(
	task: TaskRecord,
	phaseId?: string,
): PhasePosition | undefined {
	const completed = task.plan.approved?.completed ?? [];
	const future = "candidate" in task.state
		? task.state.candidate.future
		: task.plan.approved?.future ?? [];
	const phases = [...completed, ...future];
	const index = phaseId === undefined
		? completed.length
		: phases.findIndex((phase) => phase.id === phaseId);
	if (index < 0 || index >= phases.length) return undefined;
	return { position: index + 1, total: phases.length };
}

function phaseProgress(task: TaskRecord): string {
	const progress = phasePosition(task);
	return progress ? `P${progress.position}/${progress.total}` : "";
}

function buildDetail(task: TaskRecord, activity: string): string {
	return [phaseProgress(task), activity].filter(Boolean).join(" · ");
}

export interface LifecycleActivity {
	auditing?: boolean;
	synthesizing?: boolean;
}

export function lifecyclePlace(
	task: TaskRecord,
	activity: LifecycleActivity = {},
): LifecyclePlace | undefined {
	switch (task.state.phase) {
		case "creating":
			return { active: "research", detail: "setting up" };
		case "planning":
			if (task.state.step === "research")
				return {
					active: "research",
					detail: activity.synthesizing ? "synthesizing" : task.state.researchProgress,
				};
			return {
				active: "plan",
				detail: task.plan.candidate ? "awaiting Build/Revise" : "grilling",
			};
		case "revising":
			return { active: "plan", detail: "revising" };
		case "promoting":
			return { active: "build", detail: buildDetail(task, "promoting") };
		case "discarding":
			return { active: "build", detail: buildDetail(task, "discarding work") };
		case "starting":
			return { active: "build", detail: buildDetail(task, "starting") };
		case "building": {
			const state = activity.auditing
				? "auditing"
				: task.state.audit
					? task.state.audit.snapshot.paths.length === 0
						? "audited · no-code recovery"
						: "audited · recovery ready"
					: "building";
			return { active: "build", detail: buildDetail(task, state) };
		}
		case "amending":
			return { active: "build", detail: buildDetail(task, "amending") };
		case "staging":
			return { active: "build", detail: buildDetail(task, "staging") };
		case "committing":
			return {
				active: "build",
				detail: buildDetail(
					task,
					task.state.commitMessage ? "commit recovery ready" : "generating commit message",
				),
			};
		case "accepting":
			return { active: "build", detail: buildDetail(task, "accepting") };
		case "done": {
			const completed = task.plan.approved?.completed.length ?? 0;
			return { active: "done", detail: completed ? `${completed}/${completed}` : "" };
		}
		case "deleting":
			return undefined;
	}
}
