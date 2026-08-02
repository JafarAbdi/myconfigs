import { completedPhaseMatches } from "./plan.ts";
import type { TaskRecord } from "./tasks.ts";

export type TaskActionId =
	| "recover-creation"
	| "continue-planning"
	| "build-candidate"
	| "revise-candidate"
	| "resume-build"
	| "amend-phase"
	| "revise-plan"
	| "recover-transaction"
	| "show-completion"
	| "view-handoff"
	| "extend-plan"
	| "recover-deletion";

export interface TaskAction {
	id: TaskActionId;
	label: string;
	consequence: string;
}

const ACTIONS: Record<TaskActionId, TaskAction> = {
	"recover-creation": {
		id: "recover-creation",
		label: "Finish creating worktree",
		consequence: "Create or validate the exact task branch and managed worktree.",
	},
	"continue-planning": {
		id: "continue-planning",
		label: "Continue planning",
		consequence: "Open the task's persistent planning session.",
	},
	"build-candidate": {
		id: "build-candidate",
		label: "Build",
		consequence: "Promote the candidate and start its first build phase.",
	},
	"revise-candidate": {
		id: "revise-candidate",
		label: "Revise",
		consequence: "Return feedback to the same planning session.",
	},
	"resume-build": {
		id: "resume-build",
		label: "Resume the active phase",
		consequence: "Continue the interrupted build in its owning session.",
	},
	"amend-phase": {
		id: "amend-phase",
		label: "Amend a phase",
		consequence: "Persist an amendment; resume the active phase in its existing session.",
	},
	"revise-plan": {
		id: "revise-plan",
		label: "Revise the plan",
		consequence:
			"Return dirty active work to the persistent planning session without changing it.",
	},
	"recover-transaction": {
		id: "recover-transaction",
		label: "Recover transaction",
		consequence: "Resume the persisted mechanical transaction.",
	},
	"show-completion": {
		id: "show-completion",
		label: "Return to completed task",
		consequence: "Open the persistent planning session with its authoritative done status.",
	},
	"view-handoff": {
		id: "view-handoff",
		label: "View reviewer handoff",
		consequence: "Put the derived, copyable handoff in the editor; no PR or push is performed.",
	},
	"extend-plan": {
		id: "extend-plan",
		label: "Revise and add work",
		consequence: "Return the completed task to its planning session.",
	},
	"recover-deletion": {
		id: "recover-deletion",
		label: "Finish deletion",
		consequence:
			"Revalidate the confirmed snapshot, then remove only persisted JURUC metadata, worktree, and build-session paths.",
	},
};

export function availableActions(task: TaskRecord | undefined): TaskAction[] {
	if (!task) return [];
	switch (task.state.phase) {
		case "creating":
			return [ACTIONS["recover-creation"]];
		case "planning":
			return task.plan.candidate
				? [ACTIONS["build-candidate"], ACTIONS["revise-candidate"]]
				: [ACTIONS["continue-planning"]];
		case "starting":
		case "revising":
		case "amending":
			return [ACTIONS["recover-transaction"]];
		case "building":
			return task.state.audit || completedPhaseMatches(task.plan, task.state.phaseSnapshot)
				? [ACTIONS["recover-transaction"]]
				: [ACTIONS["resume-build"], ACTIONS["amend-phase"], ACTIONS["revise-plan"]];
		case "promoting":
		case "discarding":
		case "staging":
		case "committing":
		case "accepting":
			return [ACTIONS["recover-transaction"]];
		case "done":
			return [ACTIONS["show-completion"], ACTIONS["view-handoff"], ACTIONS["extend-plan"]];
		case "deleting":
			return [ACTIONS["recover-deletion"]];
	}
}

export type DispatchResult = "none" | "cancelled" | "performed";

export async function dispatchActions(
	actions: readonly TaskAction[],
	select: (actions: readonly TaskAction[]) => Promise<TaskActionId | undefined>,
	perform: (action: TaskAction) => Promise<void>,
): Promise<DispatchResult> {
	if (actions.length === 0) return "none";
	if (actions.length === 1) {
		await perform(actions[0]);
		return "performed";
	}
	const selected = await select(actions);
	if (!selected) return "cancelled";
	const action = actions.find((candidate) => candidate.id === selected);
	if (!action) throw new Error(`selected action ${selected} is no longer valid`);
	await perform(action);
	return "performed";
}
