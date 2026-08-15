import {
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { finishPhase, taskPath, type Phase, type Task } from "./tasks.ts";

export const FINISH_PHASE_TOOL = "finish_phase";
export const ADVANCE_TASK_COMMAND = "task-next";

interface TaskToolDependencies {
	resolveImplementation(ctx: ExtensionContext): { task: Task; phase: Phase };
}

export function taskTools(active: readonly string[], enabled: boolean): string[] {
	const ordinary = active.filter((name) => name !== FINISH_PHASE_TOOL);
	return enabled ? [...ordinary, FINISH_PHASE_TOOL] : ordinary;
}

export function registerTaskTools(pi: ExtensionAPI, dependencies: TaskToolDependencies): void {
	pi.registerTool({
		name: FINISH_PHASE_TOOL,
		label: "Finish Phase",
		description:
			"Mark the current implementation phase complete and automatically open the next phase " +
			"in a fresh foreground session.",
		promptSnippet: "Finish the current task phase after implementation and verification",
		promptGuidelines: [
			"Call finish_phase only after the current phase is implemented and verified, and call it alone as the final tool.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
			const { task, phase } = dependencies.resolveImplementation(ctx);
			const file = taskPath(task);
			await withFileMutationQueue(file, async () => finishPhase(task, phase.name));
			pi.sendUserMessage(`/${ADVANCE_TASK_COMMAND}`, {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
			return {
				content: [{ type: "text", text: `${phase.name} marked done; continuation queued.` }],
				details: { phase: phase.name },
				terminate: true,
			};
		},
	});
}
