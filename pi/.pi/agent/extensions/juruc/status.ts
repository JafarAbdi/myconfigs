import type { TaskDocument } from "./task.ts";

export const LIFECYCLE_STAGES = ["research", "plan", "build", "done"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface LifecyclePlace {
	active: LifecycleStage;
	detail: string;
}

export function lifecyclePlace(
	task: TaskDocument,
	activity?: "synthesizing",
): LifecyclePlace {
	if (task.stage === "research")
		return {
			active: "research",
			detail: activity === "synthesizing" ? "synthesizing" : "researching",
		};
	if (task.stage === "planning")
		return {
			active: "plan",
			detail: task.blockReason ? "replanning blocked phase" : "planning",
		};
	if (task.stage === "done") {
		const completed = task.plan?.completed.length ?? 0;
		return { active: "done", detail: `${completed}/${completed} phases` };
	}
	const completed = task.plan?.completed.length ?? 0;
	const total = completed + (task.plan?.remaining.length ?? 0);
	const progress = total ? `P${completed + 1}/${total}` : "";
	const state = task.stage === "blocked"
		? `blocked${task.blockReason ? `: ${task.blockReason}` : ""}`
		: "building";
	return { active: "build", detail: [progress, state].filter(Boolean).join(" · ") };
}

export function lifecycleLine(
	task: TaskDocument,
	activity?: "synthesizing",
): string {
	const place = lifecyclePlace(task, activity);
	const active = LIFECYCLE_STAGES.indexOf(place.active);
	return LIFECYCLE_STAGES.map((stage, index) => {
		const marker = task.stage === "done" || index < active
			? "✓"
			: index === active
				? "●"
				: "○";
		return `${marker} ${stage}${index === active && place.detail ? ` · ${place.detail}` : ""}`;
	}).join("  ");
}
