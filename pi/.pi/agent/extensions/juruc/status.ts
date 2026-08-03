import type { TaskDocument, TaskStage } from "./task.ts";

const RAIL = [
	["questions", "Q"],
	["research", "R"],
	["specification", "S"],
	["plan", "P"],
	["implementation", "I"],
] as const;

const DISCOVERY_CONTEXT = {
	questions: "Questions",
	research: "Research",
	specification: "Specification",
	plan: "Plan",
} as const;

export type RailRole = "completed" | "current" | "future";

/** One glyph per role, so the state of every stage reads without colour. */
const MARKERS: Record<RailRole, string> = { completed: "✓", current: "●", future: "○" };

export interface RailCell {
	marker: string;
	label: string;
	role: RailRole;
}

export interface LifecyclePlace {
	active: TaskStage;
	detail: string;
}

export function lifecyclePlace(task: TaskDocument): LifecyclePlace {
	if (task.stage === "plan" && task.plan) return { active: "plan", detail: "Plan · Ready" };
	if (task.stage === "review") {
		const round = task.reviewRounds.at(-1);
		const number = round?.number ?? 1;
		if (round?.decision?.kind === "send-feedback")
			return { active: "review", detail: `Correction ${number} · Verifying` };
		const reviewersReady = round && Object.values(round.reviewers).every((slot) => slot?.outcome);
		return {
			active: "review",
			detail: `Review ${number} · ${reviewersReady ? "Awaiting decision" : "Preparing"}`,
		};
	}
	if (task.stage === "done") return { active: "done", detail: "Done" };
	if (task.stage !== "implementation")
		return { active: task.stage, detail: DISCOVERY_CONTEXT[task.stage] };
	const phase = task.plan?.phases[task.checkpoints.length];
	const total = task.plan?.phases.length ?? 0;
	return {
		active: "implementation",
		detail: phase
			? `Phase ${task.checkpoints.length + 1}/${total} · ${phase.title}`
			: "Implementation",
	};
}

/** The five rail cells with the role each one plays right now; the TUI colours them. */
export function lifecycleRail(task: TaskDocument): RailCell[] {
	const activeIndex = RAIL.findIndex(([stage]) => stage === task.stage);
	const past = task.stage === "review" || task.stage === "done";
	return RAIL.map(([stage, label], index) => {
		const role: RailRole = past || index < activeIndex
			? "completed"
			: stage === task.stage
			? "current"
			: "future";
		return { marker: MARKERS[role], label, role };
	});
}

/** One cell is its state marker, one space, and its stage label. */
export function railCellText(cell: RailCell): string {
	return `${cell.marker} ${cell.label}`;
}

/** Whitespace carries the whole hierarchy: two columns between cells, three before the context. */
export function composeLifecycleLine(cells: readonly string[], detail: string): string {
	return `${cells.join("  ")}   ${detail}`;
}

export function lifecycleLine(task: TaskDocument): string {
	return composeLifecycleLine(lifecycleRail(task).map(railCellText), lifecyclePlace(task).detail);
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
