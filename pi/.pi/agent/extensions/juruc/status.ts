import type { TaskDocument, TaskStage } from "./task.ts";

const RAIL = [
	["questions", "Q"],
	["research", "R"],
	["specification", "S"],
	["plan", "P"],
	["implementation", "I"],
] as const;

export interface LifecyclePlace {
	active: TaskStage;
	detail: string;
}

export function lifecyclePlace(task: TaskDocument): LifecyclePlace {
	if (task.stage !== "implementation" && task.stage !== "done")
		return { active: task.stage, detail: task.stage };
	if (task.stage === "done") return { active: "done", detail: "done" };
	const phase = task.plan?.phases[task.checkpoints.length];
	const total = task.plan?.phases.length ?? 0;
	return {
		active: "implementation",
		detail: phase
			? `phase ${task.checkpoints.length + 1}/${total} · ${phase.title}`
			: "implementation",
	};
}

export function lifecycleLine(task: TaskDocument): string {
	const place = lifecyclePlace(task);
	const activeIndex = RAIL.findIndex(([stage]) => stage === task.stage);
	const rail = RAIL.map(([stage, label], index) => {
		const marker = task.stage === "done" || index < activeIndex
			? "✓"
			: stage === task.stage
				? "●"
				: "·";
		return `${label}${marker}`;
	}).join(" ");
	return `${rail} · ${place.detail}`;
}
