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
	if (task.stage === "plan" && task.plan)
		return { active: "plan", detail: "plan accepted · activation pending" };
	if (task.stage === "review") {
		const round = task.reviewRounds.at(-1);
		const number = round?.number ?? 1;
		if (round?.decision?.kind === "send-feedback")
			return { active: "review", detail: `correction ${number} · verifying` };
		const reviewersReady = round && Object.values(round.reviewers).every((slot) => slot?.outcome);
		return {
			active: "review",
			detail: `review ${number} · ${reviewersReady ? "awaiting decision" : "preparing"}`,
		};
	}
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

export function lifecycleRail(task: TaskDocument): string {
	const activeIndex = RAIL.findIndex(([stage]) => stage === task.stage);
	return RAIL.map(([stage, label], index) => {
		const marker = task.stage === "review" || task.stage === "done" || index < activeIndex
			? "✓"
			: stage === task.stage
				? "●"
				: "·";
		return `${label}${marker}`;
	}).join(" ");
}

export function lifecycleLine(task: TaskDocument): string {
	return `${lifecycleRail(task)} · ${lifecyclePlace(task).detail}`;
}

/** The single muted picker context: the one authoritative next action, without titles. */
export function taskContext(task: TaskDocument): string {
	if (task.stage === "implementation") {
		const total = task.plan?.phases.length ?? 0;
		return total ? `implement ${task.checkpoints.length + 1}/${total}` : "implement";
	}
	if (task.stage === "review") {
		const round = task.reviewRounds.at(-1);
		const number = round?.number ?? 1;
		return round?.decision?.kind === "send-feedback" ? `correction ${number}` : `review ${number}`;
	}
	return task.stage;
}
