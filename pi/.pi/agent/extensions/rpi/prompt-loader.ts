import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PhasePrompt =
	| "questions"
	| "research"
	| "design"
	| "outline"
	| "build"
	| "pr";

export interface PromptContext {
	extra?: string;
	structuredPhase?: string;
	baseBranch?: string;
	baseSha?: string;
	head?: string;
	audit?: string;
}

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "prompts");
/**
 * `rpi-common.md` is prepended to every phase. Said once there because five phases said it five
 * ways, and the wordings had already drifted. Prompt text lives in Markdown, never in this file.
 */
const COMMON = "rpi-common.md";

export function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Expand only RPI's controlled placeholders; replacement text is never scanned again. */
export function loadPhasePrompt(
	phase: PhasePrompt,
	slug: string,
	context: PromptContext = {},
): string {
	const agentDirectory = realpathSync(getAgentDir());
	const taskDirectory = `${join(agentDirectory, "tasks", slug)}/`;
	const worktree = join(agentDirectory, "worktrees", slug);
	const read = (name: string): string =>
		stripFrontmatter(readFileSync(join(PROMPTS, name), "utf-8"));
	const body = `${read(COMMON)}\n\n${read(`rpi-${phase}.md`)}`;
	const replacements: Record<string, string> = {
		$1: slug,
		"${@:2}": context.extra?.trim() || "none",
		"{{RPI_WORKTREE}}": worktree,
		"{{RPI_STRUCTURED_PHASE}}": context.structuredPhase ?? "",
		"{{RPI_BASE_BRANCH}}": context.baseBranch ?? "",
		"{{RPI_BASE_SHA}}": context.baseSha ?? "",
		"{{RPI_PR_HEAD}}": context.head ?? "",
		"{{RPI_AUDIT}}": context.audit ?? "",
		"~/.pi/agent/tasks/$1/": taskDirectory,
	};
	return body.replace(
		/~\/\.pi\/agent\/tasks\/\$1\/|\$\{@:2\}|\{\{RPI_(?:WORKTREE|STRUCTURED_PHASE|BASE_BRANCH|BASE_SHA|PR_HEAD|AUDIT)\}\}|\$1/g,
		(placeholder) => replacements[placeholder],
	);
}
