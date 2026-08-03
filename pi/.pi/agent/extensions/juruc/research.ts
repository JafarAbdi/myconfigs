import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskQuestions } from "./task.ts";

export const RESEARCH_INSTRUCTION = `Research the supplied task enough to support a factual specification.

Use delegate agents to establish relevant facts. Decide the useful evidence, agents, and depth from the task itself. Keep effort proportional; use repository scouts for local facts and researchers only when external or current facts matter. Research always runs, even when the supplied target list is empty.

When evidence is sufficient, ask a synthesizer for a concise factual brief. Its exact output completes Research. Do not modify the repository, ask product questions, produce requirements, or plan implementation.`;

export const RESEARCH_TOOL_NAMES = ["delegate"] as const;
export const RESEARCH_AGENT_NAMES = ["scout", "researcher", "synthesizer"] as const;

export function researchKickoff(
	request: string,
	questions: TaskQuestions,
	sourceRoot: string,
): string {
	return [
		"Original request:",
		request,
		"",
		"Confirmed Questions result:",
		JSON.stringify(questions, null, 2),
		"",
		"Factual research targets:",
		questions.researchTargets.length
			? questions.researchTargets.map((target) => `- ${target}`).join("\n")
			: "None declared; still inspect enough evidence to ground the specification.",
		"",
		`Source repository: ${sourceRoot}`,
	].join("\n");
}

export function successfulResearchSynthesis(result: unknown): string | undefined {
	if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
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
	) return undefined;
	return run.output;
}

function exactTaskDirectory(taskDirectory: string): void {
	const directory = lstatSync(taskDirectory, { throwIfNoEntry: false });
	if (
		!directory?.isDirectory() ||
		directory.isSymbolicLink() ||
		realpathSync(taskDirectory) !== taskDirectory
	) throw new Error(`${taskDirectory} is not an exact regular task directory`);
}

export function saveResearchBrief(taskDirectory: string, brief: string): void {
	if (!brief.trim()) throw new Error("research brief must be nonempty after trimming");
	exactTaskDirectory(taskDirectory);
	const path = join(taskDirectory, "research.md");
	const existing = lstatSync(path, { throwIfNoEntry: false });
	if (existing && (!existing.isFile() || existing.isSymbolicLink()))
		throw new Error(`${path} is not a regular file`);
	const temporary = join(taskDirectory, `.research.md.${process.pid}.${randomUUID()}.tmp`);
	try {
		const file = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(file, brief, "utf8");
			fchmodSync(file, 0o600);
			fsyncSync(file);
		} finally {
			closeSync(file);
		}
		renameSync(temporary, path);
		const directory = openSync(taskDirectory, "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

export function loadResearchBrief(taskDirectory: string): string {
	exactTaskDirectory(taskDirectory);
	const path = join(taskDirectory, "research.md");
	let file;
	try {
		file = lstatSync(path, { throwIfNoEntry: false });
	} catch (error) {
		throw new Error(`unable to inspect ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!file) throw new Error(`${path} is missing`);
	if (!file.isFile() || file.isSymbolicLink())
		throw new Error(`${path} is not a regular file`);
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
