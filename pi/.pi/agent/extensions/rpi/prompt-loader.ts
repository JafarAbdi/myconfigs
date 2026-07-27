import { readFileSync } from "node:fs";
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
	phaseLine?: string;
	baseBranch?: string;
	baseSha?: string;
	head?: string;
}

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "prompts");
const CONTROL =
	"Workflow state belongs to the RPI extension. Do not read or edit state.json in the task directory, and do not run /rpi yourself.";

export function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Expand only RPI's controlled placeholders; replacement text is never scanned again. */
export function loadPhasePrompt(
	phase: PhasePrompt,
	slug: string,
	context: PromptContext = {},
): string {
	const taskDirectory = `${join(getAgentDir(), "tasks", slug)}/`;
	const worktree = join(getAgentDir(), "worktrees", slug);
	const instructions = stripFrontmatter(
		readFileSync(join(PROMPTS, `rpi-${phase}.md`), "utf-8"),
	);
	const body = `${CONTROL} The canonical repository root for this phase is ${worktree}; stop on any cwd or branch mismatch.\n\n${instructions}`;
	const replacements: Record<string, string> = {
		$1: slug,
		"${@:2}": context.extra ?? "",
		"{{RPI_PHASE_LINE}}": context.phaseLine ?? "",
		"{{RPI_BASE_BRANCH}}": context.baseBranch ?? "",
		"{{RPI_BASE_SHA}}": context.baseSha ?? "",
		"{{RPI_PR_HEAD}}": context.head ?? "",
		"~/.pi/agent/tasks/$1/": taskDirectory,
	};
	return body.replace(
		/~\/\.pi\/agent\/tasks\/\$1\/|\$\{@:2\}|\{\{RPI_(?:PHASE_LINE|BASE_BRANCH|BASE_SHA|PR_HEAD)\}\}|\$1/g,
		(placeholder) => replacements[placeholder],
	);
}
