import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { taskProgress, type Task } from "./tasks.ts";

export function taskLabel(task: Task): string {
	const progress = taskProgress(task);
	const suffix = progress.done === progress.total ? " complete" : "";
	return `${task.slug} · ${progress.done}/${progress.total}${suffix}`;
}

export async function pickTask(
	ctx: ExtensionContext,
	tasks: readonly Task[],
): Promise<Task | undefined> {
	if (tasks.length === 0) {
		ctx.ui.notify("No tasks. Create one with /task <plan-file>.", "info");
		return undefined;
	}
	const byLabel = new Map(tasks.map((task) => [taskLabel(task), task]));
	const selected = await ctx.ui.select("Tasks", [...byLabel.keys()]);
	if (selected === undefined) return undefined;
	const task = byLabel.get(selected);
	if (!task) throw new Error(`task picker returned unknown option ${JSON.stringify(selected)}`);
	return task;
}
