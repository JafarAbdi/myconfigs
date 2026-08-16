import type { Phase, Task } from "./tasks.ts";

export function taskGenerationPrompt(excludedSlug?: string): string {
	const exclusion = excludedSlug === undefined
		? ""
		: ` Do not use ${JSON.stringify(excludedSlug)} because it is already occupied.`;
	return `Turn a user-approved software plan into a task name and ordered implementation phases.${exclusion}

Call define_task exactly once. Use a short two- or three-word lower-case kebab-case task slug. Use the
fewest useful vertical phases, defaulting to one. Every phase must be self-contained for a fresh
implementation session, keep verification with the behavior it verifies, and state concrete scope
and completion criteria. Do not add planning, approval, cleanup, or release phases not required by
the supplied plan.`;
}

export function implementationBrief(task: Task, phase: Phase, plan: string): string {
	return `Implement ${phase.name} — ${phase.title} for task "${task.slug}".

Current user-owned plan:
--- BEGIN PLAN ---
${plan}
--- END PLAN ---

Current phase:
--- BEGIN PHASE ---
${phase.body}
--- END PHASE ---

Work in the current worktree. Inspect repository instructions and relevant code before editing. Keep
changes within this phase and run its relevant verification. The session is visible and the user may
steer it. After implementation and verification, summarize the result and wait for the user to
review it. Address reported issues and wait again. Only after the user explicitly accepts the phase
and asks to continue, call finish_phase alone as the final tool call.`;
}
