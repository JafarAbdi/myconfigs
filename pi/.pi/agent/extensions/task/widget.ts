import { currentStage, stageComplete, STAGES, type Stage, type Task } from "./tasks.ts";

export type RailState = "complete" | "current" | "incomplete";

export interface RailStage {
	name: Stage;
	state: RailState;
}

/** The arrow names the open session; the other stages report their artifacts from disk. */
export function taskRail(task: Task, enteredStage: Stage | undefined): RailStage[] {
	const active = enteredStage ?? currentStage(task);
	return STAGES.map((name) => ({
		name,
		state: name === active ? "current" : stageComplete(task, name) ? "complete" : "incomplete",
	}));
}
