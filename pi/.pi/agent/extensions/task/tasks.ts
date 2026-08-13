/**
 * Task state — the task directory is the whole state, and the operator owns every file in it.
 *
 * `~/.pi/agent/tasks/<slug>/` has two halves. `task.json` (which repository, which base branch,
 * what was asked) and `phases/` are structured extension state, written once and through the
 * `phase` tool respectively; `notes/` holds submitted model prose, one file per stage —
 * `questions.md`, `research.md`, `plan.md`. Nothing here enters the repository under work: a task
 * is discarded by deleting it.
 *
 * A phase file is one JSON header line, a blank line, then prose. Reading state is therefore
 * `readdir` plus `JSON.parse` of one line — there is no markdown parsing anywhere, and a header
 * that a model or a hand edit made invalid fails loudly instead of being repaired into a guess.
 * Ordering is the `NN-` filename prefix, so phases are added, reordered, or removed with `mv` and
 * `rm` as readily as with the `phase` tool.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const TASK_FILE = "task.json";
const QUESTIONS_FILE = "questions.md";
const PLAN_FILE = "plan.md";
const RESEARCH_FILE = "research.md";
const PHASES_DIR = "phases";

/**
 * The prose half of a task directory, and the only path any brief ever names. `task.json` and
 * `phases/` are structured extension state; submitted prose reaches this directory through the
 * path-free stage tool.
 */
const NOTES_DIR = "notes";

/**
 * The five stages, in order, each one leaving behind the artifact the next one reads. The stage a
 * task is in is derived from those artifacts and nothing else, so re-entering a finished stage is
 * ordinary: the file is still there, and the stage revises it in place rather than starting over.
 */
export const STAGES = ["questions", "research", "design", "phases", "implement"] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
	return STAGES.some((stage) => stage === value);
}

/** Long enough for a descriptive branch name, short enough to read in a footer. */
export const MAX_SLUG_LENGTH = 48;
export const MAX_TITLE_LENGTH = 72;

/**
 * A slug is a branch name, a directory name, and the key of a task all at once. Restricting it to
 * this alphabet is what makes `join(tasksDir(), slug)` safe to compute from model or argument
 * input: no separator, no traversal, no shell metacharacter can survive the check.
 */
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-";

export type PhaseStatus = "open" | "done";

export interface PhaseHeader {
	title: string;
	status: PhaseStatus;
}

export interface Phase extends PhaseHeader {
	/** File stem, e.g. `01-lifecycle-broker`. The phase's identity everywhere. */
	name: string;
	file: string;
	body: string;
}

export interface TaskHeader {
	repository: string;
	/** The branch the task forked from, recorded so cleanup can report what a delete would lose. */
	base: string;
	description: string;
}

/**
 * A task without its phases: everything resolution and the read-only gate need. They run on every
 * tool call, and parsing the phases there would let one malformed phase file break every tool.
 */
export interface TaskRef {
	slug: string;
	directory: string;
	header: TaskHeader;
}

export interface Task extends TaskRef {
	phases: Phase[];
}

export interface TaskCatalog {
	tasks: Task[];
	/** Why each unreadable task was skipped, so a broken one costs only itself. */
	broken: string[];
}

export function isSlug(value: string): boolean {
	if (!value.length || value.length > MAX_SLUG_LENGTH) return false;
	if (value.startsWith("-") || value.endsWith("-")) return false;
	if (value.includes("--")) return false;
	return [...value].every((character) => SLUG_ALPHABET.includes(character));
}

/**
 * Every entry point takes the tasks root — `~/.pi/agent/tasks` in practice, resolved once by the
 * extension. Keeping that lookup at the edge is what leaves this module dependent on nothing but
 * `node:fs`, so its behaviour is testable without pi's package resolution.
 */
export function taskDir(root: string, slug: string): string {
	if (!isSlug(slug)) throw new Error(`invalid task slug ${JSON.stringify(slug)}`);
	return join(root, slug);
}

export function notesDir(task: TaskRef): string {
	return join(task.directory, NOTES_DIR);
}

export function questionsPath(task: TaskRef): string {
	return join(notesDir(task), QUESTIONS_FILE);
}

export function planPath(task: TaskRef): string {
	return join(notesDir(task), PLAN_FILE);
}

export function researchPath(task: TaskRef): string {
	return join(notesDir(task), RESEARCH_FILE);
}

/** The stage marker, not model input, chooses where submitted prose is written. */
export function artifactPath(task: TaskRef, stage: Stage): string {
	if (stage === "questions") return questionsPath(task);
	if (stage === "research") return researchPath(task);
	if (stage === "design") return planPath(task);
	throw new Error(`the ${stage} stage has no Markdown artifact; use the phase tool instead`);
}

export function submitArtifact(task: TaskRef, stage: Stage, content: string): string {
	const text = content.trim();
	if (!text) throw new Error("artifact content must not be blank");
	const path = artifactPath(task, stage);
	writeFileSync(path, `${text}\n`);
	return path;
}

/** Whether this stage's artifact exists on disk; the final stage completes when every phase does. */
export function stageComplete(task: Task, stage: Stage): boolean {
	if (stage === "questions") return existsSync(questionsPath(task));
	if (stage === "research") return existsSync(researchPath(task));
	if (stage === "design") return existsSync(planPath(task));
	if (stage === "phases") return task.phases.length > 0;
	return task.phases.length > 0 && task.phases.every((phase) => phase.status === "done");
}

/** Which stage a task is in: the first incomplete artifact, or implementation once phases exist. */
export function currentStage(task: Task): Stage {
	return STAGES.find((stage) => stage === "implement" || !stageComplete(task, stage)) ?? "implement";
}

function phasesDir(task: Task): string {
	return join(task.directory, PHASES_DIR);
}

/**
 * Headers are read field by field so a hand-edited file is told what to fix, not merely that it is
 * malformed. Model-produced structure never arrives here unchecked: it comes through the `phase`
 * tool, whose JSON Schema pi validates before this module sees it.
 */
function readHeaderField(where: string, field: string, value: unknown, expected: string): string {
	if (typeof value !== "string" || !value) throw new Error(`${where}: "${field}" must be ${expected}`);
	return value;
}

function parseTaskHeader(where: string, text: string): TaskHeader {
	let parsed: Partial<TaskHeader> | null;
	try {
		parsed = JSON.parse(text) as Partial<TaskHeader> | null;
	} catch (error) {
		throw new Error(`${where}: is not JSON (${error instanceof Error ? error.message : error})`);
	}
	return {
		repository: readHeaderField(where, "repository", parsed?.repository, "an absolute path"),
		base: readHeaderField(where, "base", parsed?.base, "a branch name"),
		description: readHeaderField(where, "description", parsed?.description, "the task as it was asked"),
	};
}

function parsePhaseHeader(where: string, text: string): PhaseHeader {
	let parsed: Partial<PhaseHeader> | null;
	try {
		parsed = JSON.parse(text) as Partial<PhaseHeader> | null;
	} catch (error) {
		throw new Error(`${where}: first line is not JSON (${error instanceof Error ? error.message : error})`);
	}
	const status = parsed?.status;
	if (status !== "open" && status !== "done") throw new Error(`${where}: "status" must be "open" or "done"`);
	return { title: readHeaderField(where, "title", parsed?.title, "a short prose title"), status };
}

export function serializePhase(header: PhaseHeader, body: string): string {
	return `${JSON.stringify({ title: header.title, status: header.status })}\n\n${body.trim()}\n`;
}

/**
 * The header is the first line, exactly. Everything after the line that follows it is the body,
 * kept verbatim — the extension never reads it, the implementer does.
 */
export function parsePhase(file: string, text: string): Phase {
	const newline = text.indexOf("\n");
	const header = parsePhaseHeader(file, newline === -1 ? text : text.slice(0, newline));
	const rest = newline === -1 ? "" : text.slice(newline + 1);
	return { ...header, name: file.slice(0, -3), file, body: rest.startsWith("\n") ? rest.slice(1) : rest };
}

export function listPhases(directory: string): Phase[] {
	const phases = join(directory, PHASES_DIR);
	if (!existsSync(phases)) return [];
	return readdirSync(phases, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
		.map((file) => parsePhase(file, readFileSync(join(phases, file), "utf-8")));
}

export function readTaskRef(root: string, slug: string): TaskRef {
	const directory = taskDir(root, slug);
	const header = parseTaskHeader(`${slug}/${TASK_FILE}`, readFileSync(join(directory, TASK_FILE), "utf-8"));
	return { slug, directory, header };
}

export function readTask(root: string, slug: string): Task {
	const reference = readTaskRef(root, slug);
	return { ...reference, phases: listPhases(reference.directory) };
}

export function listTasks(root: string): TaskCatalog {
	if (!existsSync(root)) return { tasks: [], broken: [] };
	const tasks: Task[] = [];
	const broken: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !isSlug(entry.name)) continue;
		try {
			tasks.push(readTask(root, entry.name));
		} catch (error) {
			broken.push(`${entry.name}: ${error instanceof Error ? error.message : error}`);
		}
	}
	return { tasks: tasks.sort((left, right) => left.slug.localeCompare(right.slug)), broken };
}

/** Fails on an existing slug rather than reusing it: the directory is also a branch name. */
export function createTask(root: string, slug: string, header: TaskHeader): Task {
	const directory = taskDir(root, slug);
	mkdirSync(root, { recursive: true });
	mkdirSync(directory, { recursive: false });
	mkdirSync(join(directory, PHASES_DIR), { recursive: true });
	mkdirSync(join(directory, NOTES_DIR), { recursive: true });
	writeTaskHeader(directory, header);
	return { slug, directory, header, phases: [] };
}

/**
 * Written once, when the task is created, and never again. A field that is updated later is a field
 * two sessions can race over and a dialog can revert; the one thing that used to change — where the
 * worktree is — is computed instead, from the repository and the slug.
 */
function writeTaskHeader(directory: string, header: TaskHeader): void {
	writeFileSync(join(directory, TASK_FILE), `${JSON.stringify(header, undefined, "\t")}\n`, { flag: "wx" });
}

/** Always `../<repository>-<slug>`, so it is knowable without being recorded. */
export function worktreePath(task: TaskRef): string {
	return join(dirname(task.header.repository), `${basename(task.header.repository)}-${task.slug}`);
}

/** A task is being planned until its worktree exists; nothing else distinguishes the two halves. */
export function hasWorktree(task: TaskRef): boolean {
	return existsSync(worktreePath(task));
}

export function removeTaskDir(root: string, slug: string): void {
	rmSync(taskDir(root, slug), { recursive: true, force: true });
}

/** `NN-name`, numbered so the filename alone orders the plan. */
export function phaseFileName(index: number, name: string): string {
	return `${String(index).padStart(2, "0")}-${name}.md`;
}

/**
 * The number after the last one on disk — not the count of phases, which collides the moment a
 * phase is deleted with an editor. A name that is already taken is not checked for: two phases may
 * reasonably describe the same area, their numbers make them distinct, and `wx` is what actually
 * guarantees nothing is overwritten.
 */
function nextPhaseNumber(task: Task): number {
	const last = task.phases.at(-1);
	if (!last) return 1;
	const parsed = Number(last.name.slice(0, last.name.indexOf("-")));
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed + 1 : task.phases.length + 1;
}

export function createPhase(task: Task, name: string, title: string, body: string): Phase {
	if (!isSlug(name)) throw new Error(`invalid phase name ${JSON.stringify(name)}`);
	const file = phaseFileName(nextPhaseNumber(task), name);
	writeFileSync(join(phasesDir(task), file), serializePhase({ title, status: "open" }, body), { flag: "wx" });
	return parsePhase(file, readFileSync(join(phasesDir(task), file), "utf-8"));
}

export function setPhaseStatus(task: Task, name: string, status: PhaseStatus): Phase {
	const phase = task.phases.find((candidate) => candidate.name === name);
	if (!phase) {
		const known = task.phases.map((candidate) => candidate.name).join(", ") || "none";
		throw new Error(`unknown phase ${name}; phases are: ${known}`);
	}
	writeFileSync(join(phasesDir(task), phase.file), serializePhase({ title: phase.title, status }, phase.body));
	return { ...phase, status };
}

export function nextOpenPhase(task: Task): Phase | undefined {
	return task.phases.find((phase) => phase.status === "open");
}

export function taskProgress(task: Task): { done: number; total: number } {
	return { done: task.phases.filter((phase) => phase.status === "done").length, total: task.phases.length };
}
