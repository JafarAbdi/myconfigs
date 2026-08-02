import type { TaskSummary } from "./tasks.ts";

export type TaskChoice =
	| { action: "new" | "cancel" }
	| { action: "select" | "remove"; slug: string };

export interface RpcTaskOption {
	label: string;
	choice: Exclude<TaskChoice, { action: "cancel" }>;
}

const SESSION_DELETION_NOTICE =
	"Persisted exact JURUC build sessions are removed; planning and all other sessions remain.";

export function deletionConfirmationDetail(status: string | undefined): string {
	if (status)
		return `Delete its exact JURUC worktree and task state? The branch and commits remain. ${SESSION_DELETION_NOTICE} This will discard:\n\n${status}`;
	return status === undefined
		? `Delete the stale JURUC task state? Its worktree is absent; the branch and commits remain. ${SESSION_DELETION_NOTICE}`
		: `Delete its exact clean JURUC worktree and task state? The branch and commits remain. ${SESSION_DELETION_NOTICE}`;
}

export function rpcTaskOptions(tasks: readonly TaskSummary[]): RpcTaskOption[] {
	return [
		{ label: "New task…", choice: { action: "new" } },
		...tasks.flatMap((task) => [
			{
				label: `Open ${task.title} — ${task.slug} · ${task.phase}`,
				choice: { action: "select" as const, slug: task.slug },
			},
			{
				label: `Delete ${task.title} — ${task.slug} · ${task.phase}`,
				choice: { action: "remove" as const, slug: task.slug },
			},
		]),
	];
}
