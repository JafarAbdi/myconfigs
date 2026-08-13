import type { Stage } from "./tasks.ts";

export const PHASE_TOOL = "phase";
export const SUBMIT_STAGE_TOOL = "submit_stage";

const TASK_TOOLS = new Set<string>([PHASE_TOOL, SUBMIT_STAGE_TOOL]);

export function taskToolForStage(stage?: Stage): string | undefined {
	if (stage === "questions" || stage === "research" || stage === "design") return SUBMIT_STAGE_TOOL;
	if (stage === "phases") return PHASE_TOOL;
	return undefined;
}

/** Preserve every unrelated tool while exposing only the tool owned by this planning stage. */
export function activeToolsForTaskStage(activeTools: readonly string[], stage?: Stage): string[] {
	const next = activeTools.filter((name) => !TASK_TOOLS.has(name));
	const taskTool = taskToolForStage(stage);
	if (taskTool) next.push(taskTool);
	return next;
}
