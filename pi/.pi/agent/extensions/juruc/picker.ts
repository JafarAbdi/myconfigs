import type { TaskSummary } from "./tasks.ts";

export type TaskChoice =
	| { action: "new" }
	| { action: "cancel" }
	| { action: "select" | "remove"; slug: string };

export interface TaskOption {
	label: string;
	choice: Exclude<TaskChoice, { action: "cancel" }>;
}

export function taskOptions(tasks: readonly TaskSummary[]): TaskOption[] {
	return [
		{ label: "New task…", choice: { action: "new" } },
		...tasks.map((task) => ({
			label: `${task.title} — ${task.slug} · ${task.stage}`,
			choice: { action: "select" as const, slug: task.slug },
		})),
	];
}
