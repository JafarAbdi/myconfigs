import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const RESEARCH_INSTRUCTION = `Research the supplied subject enough to support planning.

Use delegate agents to establish the relevant facts. Decide the useful evidence, agents, and depth from the task itself. Keep the effort proportional; use repository scouts for local facts and researchers only when external or current facts matter.

When the evidence is sufficient, ask a synthesizer for a concise factual brief. Its output becomes research.md verbatim and completes research. Do not modify the repository or produce a plan.`;

export const RESEARCH_TOOL_NAMES = ["delegate"] as const;
export const RESEARCH_AGENT_NAMES = [
	"scout",
	"researcher",
	"synthesizer",
] as const;

export function researchKickoff(subject: string): string {
	return subject;
}

export function successfulResearchSynthesis(result: unknown): string | undefined {
	if (result === null || typeof result !== "object" || Array.isArray(result))
		return undefined;
	const run = result as Record<string, unknown>;
	if (
		run.agent !== "synthesizer" ||
		run.stopReason !== "stop" ||
		typeof run.output !== "string" ||
		!run.output.trim() ||
		!Array.isArray(run.steps) ||
		run.steps.length !== 0 ||
		run.termination !== undefined ||
		run.errorMessage !== undefined
	)
		return undefined;
	return run.output;
}

export function saveResearchBrief(taskDirectory: string, brief: string): void {
	if (!brief.trim())
		throw new Error("research brief must be nonempty after trimming");
	const directory = lstatSync(taskDirectory, { throwIfNoEntry: false });
	if (
		!directory?.isDirectory() ||
		directory.isSymbolicLink() ||
		realpathSync(taskDirectory) !== taskDirectory
	)
		throw new Error(`${taskDirectory} is not an exact regular task directory`);

	const path = join(taskDirectory, "research.md");
	const existing = lstatSync(path, { throwIfNoEntry: false });
	if (existing && (!existing.isFile() || existing.isSymbolicLink()))
		throw new Error(`${path} is not a regular file`);

	const temporary = join(
		taskDirectory,
		`.research.md.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporary, brief, { mode: 0o600, flag: "wx" });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}
