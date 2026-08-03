import { currentTaskReviewRound, findTaskSession, type TaskDocument } from "./task.ts";

const RAIL = [
	["questions", "Q"],
	["research", "R"],
	["specification", "S"],
	["plan", "P"],
	["implementation", "I"],
] as const;

type RailStage = (typeof RAIL)[number][0];

const DISCOVERY_CONTEXT = {
	questions: "Questions",
	research: "Research",
	specification: "Specification",
	plan: "Plan",
} as const;

export type RailRole = "completed" | "ready" | "opened" | "future";

/**
 * One glyph per role, so the state of every stage reads without colour. `○` is any stage
 * whose session does not exist yet, and `●` says that session has been opened; neither
 * says anything about model streaming, which the Pi working indicator owns.
 */
const MARKERS: Record<RailRole, string> = {
	completed: "✓",
	ready: "○",
	opened: "●",
	future: "○",
};

export interface RailCell {
	marker: string;
	label: string;
	role: RailRole;
}

/** The rail stage that owns the next action, or none once the rail is wholly behind. */
function currentRailStage(task: TaskDocument): RailStage | undefined {
	// An accepted plan ends planning; only its workspace activation may still be pending.
	if (task.stage === "plan" && task.plan) return "implementation";
	if (task.stage === "review" || task.stage === "done") return undefined;
	return task.stage;
}

/** Whether this stage's own managed session already exists, which is what `●` reports. */
function stageOpened(task: TaskDocument, stage: RailStage): boolean {
	return Boolean(
		stage === "implementation"
			? findTaskSession(task, { kind: stage, phase: task.checkpoints.length + 1 })
			: findTaskSession(task, { kind: stage }),
	);
}

function reviewDetail(task: TaskDocument): string {
	const round = currentTaskReviewRound(task);
	if (!round) return "Review 1 · Ready";
	if (round.decision?.kind === "send-feedback")
		return `Correction ${round.number} · ${round.correction ? "Verifying" : "Ready"}`;
	const slots = Object.values(round.reviewers);
	if (slots.every((slot) => slot?.outcome)) return `Review ${round.number} · Awaiting decision`;
	return `Review ${round.number} · ${slots.some((slot) => slot) ? "Preparing" : "Ready"}`;
}

/** The one plain-spoken context line: what is happening, or what one Enter would start. */
export function lifecycleDetail(task: TaskDocument): string {
	if (task.stage === "done") return "Done";
	if (task.stage === "review") return reviewDetail(task);
	const stage = currentRailStage(task)!;
	const ready = !stageOpened(task, stage);
	if (stage !== "implementation")
		return ready ? `${DISCOVERY_CONTEXT[stage]} · Ready` : DISCOVERY_CONTEXT[stage];
	const phase = task.plan?.phases[task.checkpoints.length];
	if (!phase) return "Implementation";
	const position = `Phase ${task.checkpoints.length + 1}/${task.plan!.phases.length}`;
	return ready ? `${position} · Ready` : `${position} · ${phase.title}`;
}

/** The five rail cells with the role each one plays right now; the TUI colours them. */
export function lifecycleRail(task: TaskDocument): RailCell[] {
	const stage = currentRailStage(task);
	const activeIndex = stage ? RAIL.findIndex(([name]) => name === stage) : RAIL.length;
	const opened = stage !== undefined && stageOpened(task, stage);
	return RAIL.map(([, label], index) => {
		const role: RailRole = index < activeIndex
			? "completed"
			: index > activeIndex
			? "future"
			: opened
			? "opened"
			: "ready";
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
	return composeLifecycleLine(lifecycleRail(task).map(railCellText), lifecycleDetail(task));
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
