import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const TASK_FILE = "TASK.md";
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-";

export const MAX_SLUG_LENGTH = 48;
export const MAX_TITLE_LENGTH = 72;

export type PhaseStatus = "open" | "done";

export interface PhaseInput {
	name: string;
	title: string;
	body: string;
}

export interface Phase extends PhaseInput {
	status: PhaseStatus;
}

export interface Task {
	directory: string;
	version: 1;
	slug: string;
	plan: string;
	repository: string;
	phases: Phase[];
}

export interface TaskProgress {
	done: number;
	total: number;
}

export type TaskState =
	| { kind: "implementation"; phase: Phase }
	| { kind: "complete" };

export interface TaskCatalog {
	tasks: Task[];
	broken: string[];
}

export interface PreparedTaskCreation {
	task: Task;
	stagedDirectory: string;
}

interface PersistedTask {
	version: 1;
	slug: string;
	plan: string;
	repository: string;
	phases: Phase[];
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

interface JsonObject {
	[key: string]: JsonValue;
}

function entry(path: string) {
	return lstatSync(path, { throwIfNoEntry: false });
}

export function isSlug(value: string): boolean {
	if (value.length === 0 || value.length > MAX_SLUG_LENGTH) return false;
	if (value.startsWith("-") || value.endsWith("-") || value.includes("--")) return false;
	return [...value].every((character) => SLUG_ALPHABET.includes(character));
}

export function taskDir(root: string, slug: string): string {
	if (!isSlug(slug)) throw new Error(`invalid task slug ${JSON.stringify(slug)}`);
	return join(root, slug);
}

export function taskPath(task: Pick<Task, "directory">): string {
	return join(task.directory, TASK_FILE);
}

export function worktreePath(task: Pick<Task, "repository" | "slug">): string {
	const repository = validateRepositoryPath("repository", task.repository);
	if (!isSlug(task.slug)) throw new Error(`invalid task slug ${JSON.stringify(task.slug)}`);
	return join(dirname(repository), `${basename(repository)}-${task.slug}`);
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
}

function requireExactKeys<Value extends object>(
	where: string,
	value: Value,
	expected: readonly string[],
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length === wanted.length && actual.every((key, index) => key === wanted[index])) {
		return;
	}
	throw new Error(
		`${where}: must contain exactly ${expected.map((key) => JSON.stringify(key)).join(", ")}`,
	);
}

function requireNonblankString(where: string, value: JsonValue | undefined): string {
	if (!isString(value) || value.trim().length === 0) {
		throw new Error(`${where}: must be a nonblank string`);
	}
	return value;
}

function validateTitle(where: string, value: JsonValue | undefined): string {
	const title = requireNonblankString(where, value);
	if (title.length > MAX_TITLE_LENGTH) {
		throw new Error(`${where}: must be at most ${MAX_TITLE_LENGTH} characters`);
	}
	if (title.includes("\n") || title.includes("\r")) {
		throw new Error(`${where}: must be a single line`);
	}
	return title;
}

function validateAbsolutePath(where: string, value: JsonValue | undefined): string {
	if (!isString(value) || !isAbsolute(value)) {
		throw new Error(`${where}: must be an absolute path`);
	}
	if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
		throw new Error(`${where}: must be a single valid path`);
	}
	return value;
}

function validateRepositoryPath(where: string, value: JsonValue | undefined): string {
	const repository = validateAbsolutePath(where, value);
	if (basename(repository).length === 0) {
		throw new Error(`${where}: must identify a repository with a basename`);
	}
	return repository;
}

function isNumberedName(name: string): boolean {
	const separator = name.indexOf("-");
	if (separator < 1) return false;
	return [...name.slice(0, separator)].every((character) => character >= "0" && character <= "9");
}

function validateUnnumberedName(where: string, value: JsonValue | undefined): string {
	if (!isString(value) || !isSlug(value)) {
		throw new Error(`${where}: must be an unnumbered slug`);
	}
	if (isNumberedName(value)) throw new Error(`${where}: must not include a numeric phase prefix`);
	return value;
}

function orderedPhaseName(index: number, name: string): string {
	return `${String(index + 1).padStart(2, "0")}-${name}`;
}

function validatePhaseInputs(value: readonly PhaseInput[]): Phase[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('"phases": must contain at least one phase');
	}
	const names = new Set<string>();
	return value.map((candidate, index) => {
		const where = `phases[${index}]`;
		requireExactKeys(where, candidate, ["name", "title", "body"]);
		const name = validateUnnumberedName(`${where}.name`, candidate.name);
		if (names.has(name)) throw new Error(`${where}.name: duplicate unnumbered name ${name}`);
		names.add(name);
		return {
			name: orderedPhaseName(index, name),
			title: validateTitle(`${where}.title`, candidate.title),
			body: requireNonblankString(`${where}.body`, candidate.body),
			status: "open",
		};
	});
}

function validatePersistedPhase(
	value: JsonValue,
	index: number,
	names: Set<string>,
): Phase {
	const where = `phases[${index}]`;
	if (!isJsonObject(value)) throw new Error(`${where}: must be an object`);
	const record = value;
	requireExactKeys(where, record, ["name", "title", "body", "status"]);
	if (!isString(record.name)) throw new Error(`${where}.name: must be a string`);
	const separator = record.name.indexOf("-");
	const prefix = separator < 0 ? "" : record.name.slice(0, separator);
	const name = separator < 0 ? "" : record.name.slice(separator + 1);
	const expectedPrefix = String(index + 1).padStart(2, "0");
	if (prefix !== expectedPrefix) {
		throw new Error(`${where}.name: expected contiguous phase index ${expectedPrefix}`);
	}
	validateUnnumberedName(`${where}.name after ${expectedPrefix}-`, name);
	if (names.has(name)) throw new Error(`${where}.name: duplicate unnumbered name ${name}`);
	names.add(name);
	if (record.status !== "open" && record.status !== "done") {
		throw new Error(`${where}.status: must be "open" or "done"`);
	}
	return {
		name: record.name,
		title: validateTitle(`${where}.title`, record.title),
		body: requireNonblankString(`${where}.body`, record.body),
		status: record.status,
	};
}

function validatePersistedTask(where: string, value: JsonValue, directorySlug: string): PersistedTask {
	if (!isJsonObject(value)) throw new Error(`${where}: structured header must be an object`);
	const record = value;
	requireExactKeys(`${where}: structured header`, record, [
		"version",
		"slug",
		"plan",
		"repository",
		"phases",
	]);
	if (record.version !== 1) throw new Error(`${where}: "version" must equal 1`);
	if (!isString(record.slug) || !isSlug(record.slug)) {
		throw new Error(`${where}: "slug" must be a valid task slug`);
	}
	if (record.slug !== directorySlug) {
		throw new Error(
			`${where}: "slug" ${JSON.stringify(record.slug)} does not match directory ` +
				JSON.stringify(directorySlug),
		);
	}
	const plan = validateAbsolutePath(`${where}: "plan"`, record.plan);
	const repository = validateRepositoryPath(`${where}: "repository"`, record.repository);
	if (!Array.isArray(record.phases) || record.phases.length === 0) {
		throw new Error(`${where}: "phases" must contain at least one phase`);
	}
	const names = new Set<string>();
	let foundOpen = false;
	const phases = record.phases.map((candidate, index) => {
		const phase = validatePersistedPhase(candidate, index, names);
		if (phase.status === "done" && foundOpen) {
			throw new Error(`${where}: "phases[${index}].status": done cannot follow an open phase`);
		}
		if (phase.status === "open") foundOpen = true;
		return phase;
	});
	return { version: 1, slug: record.slug, plan, repository, phases };
}

function parseJson(where: string, text: string): JsonValue {
	try {
		// SAFETY: JSON.parse without a reviver returns exactly the recursive JSON domain.
		return JSON.parse(text) as JsonValue;
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`${where}: is not JSON (${detail})`);
	}
}

function renderMarkdown(task: PersistedTask): string {
	const checklist = task.phases
		.map((phase) => `- [${phase.status === "done" ? "x" : " "}] ${phase.name} — ${phase.title}`)
		.join("\n");
	const sections = task.phases
		.map((phase) => `## ${phase.name} — ${phase.title}\n\n${phase.body}`)
		.join("\n\n");
	return `# ${task.slug}\n\nPlan: ${task.plan}\n\n## Phases\n\n${checklist}\n\n${sections}\n`;
}

function serializeTask(task: PersistedTask): string {
	const persisted: PersistedTask = {
		version: task.version,
		slug: task.slug,
		plan: task.plan,
		repository: task.repository,
		phases: task.phases,
	};
	return `---\n${JSON.stringify(persisted)}\n---\n${renderMarkdown(persisted)}`;
}

function parseTaskDocument(where: string, text: string, directorySlug: string): PersistedTask {
	if (!text.startsWith("---\n")) {
		throw new Error(`${where}: must start with the exact front matter delimiter "---\\n"`);
	}
	const jsonEnd = text.indexOf("\n", 4);
	if (jsonEnd < 0) throw new Error(`${where}: structured header must be exactly one JSON line`);
	if (text.slice(jsonEnd + 1, jsonEnd + 5) !== "---\n") {
		throw new Error(`${where}: JSON line must be followed by the exact delimiter "---\\n"`);
	}
	const jsonLine = text.slice(4, jsonEnd);
	const task = validatePersistedTask(where, parseJson(`${where}: structured header`, jsonLine), directorySlug);
	if (jsonLine !== JSON.stringify(task)) {
		throw new Error(`${where}: structured header is not canonical JSON`);
	}
	const markdown = text.slice(jsonEnd + 5);
	if (markdown !== renderMarkdown(task)) {
		throw new Error(`${where}: Markdown projection does not match structured state`);
	}
	return task;
}

function requireDirectory(path: string, where: string): void {
	const stats = entry(path);
	if (stats === undefined) throw new Error(`${where}: directory does not exist`);
	if (!stats.isDirectory()) throw new Error(`${where}: must be a directory`);
}

function requireRegularFile(path: string, where: string): void {
	const stats = entry(path);
	if (stats === undefined) throw new Error(`${where}: file does not exist`);
	if (!stats.isFile()) throw new Error(`${where}: must be a regular file`);
}

function readTaskDirectory(directory: string, slug: string): Task {
	requireDirectory(directory, directory);
	const path = join(directory, TASK_FILE);
	requireRegularFile(path, path);
	const persisted = parseTaskDocument(path, readFileSync(path, "utf8"), slug);
	return { directory, ...persisted };
}

export function readTask(root: string, slug: string): Task {
	return readTaskDirectory(taskDir(root, slug), slug);
}

export function readPlanFile(plan: string): string {
	const path = validateAbsolutePath('"plan"', plan);
	requireRegularFile(path, path);
	return requireNonblankString(`${path}: plan`, readFileSync(path, "utf8"));
}

export function readPlan(task: Pick<Task, "plan">): string {
	return readPlanFile(task.plan);
}

export function listTasks(root: string): TaskCatalog {
	const stats = entry(root);
	if (stats === undefined) return { tasks: [], broken: [] };
	if (!stats.isDirectory()) throw new Error(`${root}: must be a directory`);
	const tasks: Task[] = [];
	const broken: string[] = [];
	const entries = readdirSync(root, { withFileTypes: true })
		.filter((item) => isSlug(item.name))
		.sort((left, right) => left.name.localeCompare(right.name));
	for (const item of entries) {
		try {
			tasks.push(readTask(root, item.name));
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			broken.push(`${item.name}: ${detail}`);
		}
	}
	return { tasks, broken };
}

function temporarySibling(path: string): string {
	return `${path}.${randomUUID()}.tmp`;
}

function writeAtomic(path: string, content: string): void {
	const temporary = temporarySibling(path);
	try {
		writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
		renameSync(temporary, path);
	} catch (cause) {
		rmSync(temporary, { force: true });
		throw cause;
	}
}

export function prepareTaskCreation(
	root: string,
	slug: string,
	plan: string,
	repository: string,
	phaseInputs: readonly PhaseInput[],
): PreparedTaskCreation {
	const directory = taskDir(root, slug);
	const validatedPlan = validateAbsolutePath('"plan"', plan);
	const validatedRepository = validateRepositoryPath('"repository"', repository);
	const phases = validatePhaseInputs(phaseInputs);
	readPlan({ plan: validatedPlan });
	const task: Task = {
		directory,
		version: 1,
		slug,
		plan: validatedPlan,
		repository: validatedRepository,
		phases,
	};
	const document = serializeTask(task);
	const rootEntry = entry(root);
	if (rootEntry !== undefined && !rootEntry.isDirectory()) {
		throw new Error(`${root}: must be a directory`);
	}
	if (entry(directory) !== undefined) {
		throw new Error(`task slug ${JSON.stringify(slug)} already exists`);
	}

	mkdirSync(root, { recursive: true });
	const stagedDirectory = join(root, `.${slug}.claim`);
	let claimed = false;
	try {
		mkdirSync(stagedDirectory);
		claimed = true;
		writeFileSync(join(stagedDirectory, TASK_FILE), document, { encoding: "utf8", flag: "wx" });
	} catch (cause) {
		if (claimed) rmSync(stagedDirectory, { recursive: true, force: true });
		throw cause;
	}
	return { task, stagedDirectory };
}

function validatePreparedPaths(prepared: PreparedTaskCreation): void {
	const parent = dirname(prepared.task.directory);
	const expectedDirectory = taskDir(parent, prepared.task.slug);
	if (prepared.task.directory !== expectedDirectory) {
		throw new Error("prepared task directory does not match its slug");
	}
	const expectedStaged = join(parent, `.${prepared.task.slug}.claim`);
	if (prepared.stagedDirectory !== expectedStaged) {
		throw new Error("prepared staging directory does not match its slug claim");
	}
}

export function commitTaskCreation(prepared: PreparedTaskCreation): Task {
	validatePreparedPaths(prepared);
	if (entry(prepared.task.directory) !== undefined) {
		throw new Error(`task slug ${JSON.stringify(prepared.task.slug)} already exists`);
	}
	const staged = readTaskDirectory(prepared.stagedDirectory, prepared.task.slug);
	if (serializeTask(staged) !== serializeTask(prepared.task)) {
		throw new Error("prepared task does not match staged TASK.md");
	}
	renameSync(prepared.stagedDirectory, prepared.task.directory);
	return { ...staged, directory: prepared.task.directory };
}

export function discardTaskCreation(prepared: PreparedTaskCreation): void {
	validatePreparedPaths(prepared);
	rmSync(prepared.stagedDirectory, { recursive: true, force: true });
}

export function createTask(
	root: string,
	slug: string,
	plan: string,
	repository: string,
	phaseInputs: readonly PhaseInput[],
): Task {
	const prepared = prepareTaskCreation(root, slug, plan, repository, phaseInputs);
	try {
		return commitTaskCreation(prepared);
	} catch (cause) {
		discardTaskCreation(prepared);
		throw cause;
	}
}

export function nextOpenPhase(task: Task): Phase | undefined {
	return task.phases.find((phase) => phase.status === "open");
}

export function taskState(task: Task): TaskState {
	const phase = nextOpenPhase(task);
	return phase === undefined ? { kind: "complete" } : { kind: "implementation", phase };
}

export function finishPhase(task: Task, phaseName: string): Phase {
	const current = readTaskDirectory(task.directory, task.slug);
	const phase = current.phases.find((candidate) => candidate.name === phaseName);
	if (phase === undefined) throw new Error(`unknown phase ${JSON.stringify(phaseName)}`);
	if (phase.status === "done") throw new Error(`phase ${phase.name} is already done`);
	const next = nextOpenPhase(current);
	if (next === undefined) throw new Error("cannot finish a phase: task is complete");
	if (phase.name !== next.name) {
		throw new Error(`phase ${phase.name} is out of order; finish ${next.name} first`);
	}
	const finished: Phase = { ...phase, status: "done" };
	const phases = current.phases.map((candidate) =>
		candidate.name === phase.name ? finished : candidate,
	);
	const updated: PersistedTask = {
		version: current.version,
		slug: current.slug,
		plan: current.plan,
		repository: current.repository,
		phases,
	};
	writeAtomic(taskPath(current), serializeTask(updated));
	return finished;
}

export function taskProgress(task: Task): TaskProgress {
	return {
		done: task.phases.filter((phase) => phase.status === "done").length,
		total: task.phases.length,
	};
}
