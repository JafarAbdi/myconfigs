import { taskProgress, taskState, type Task } from "./tasks.ts";

export type TaskStatusTone = "active" | "complete";

export interface TaskStatus {
	text: string;
	tone: TaskStatusTone;
}

export function taskStatus(task: Task): TaskStatus {
	const progress = taskProgress(task);
	const state = taskState(task);
	if (state.kind === "complete") {
		return {
			text: `${task.slug} · complete · ${progress.done}/${progress.total} phases`,
			tone: "complete",
		};
	}
	return {
		text: `${task.slug} · phase ${progress.done + 1}/${progress.total} · ${state.phase.name}`,
		tone: "active",
	};
}
