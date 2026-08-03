import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	createTaskDocument,
	findTaskSessionByPath,
	loadTaskDocument,
	saveTaskDocument,
	type NewTaskInput,
	type TaskDocument,
} from "./task.ts";
import {
	requireExactDirectory,
	requireRuntimePaths,
	type RuntimePaths,
} from "./runtime.ts";

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface StoredTask {
	directory: string;
	document: TaskDocument;
}

export interface TaskSummary {
	slug: string;
	title: string;
	request: string;
	stage: string;
	modified: Date;
	valid: boolean;
	error?: string;
}

export function validTaskSlug(slug: string): boolean {
	return SLUG.test(slug);
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean)
		.slice(0, 6)
		.join("-")
		.slice(0, 48)
		.replace(/-+$/u, "");
}

export function uniqueSlug(tasks: string, base: string): string {
	requireExactDirectory(tasks);
	let slug = base;
	for (let suffix = 2; existsSync(join(tasks, slug)); suffix++)
		slug = `${base}-${suffix}`;
	return slug;
}

export function taskDirectory(paths: RuntimePaths, slug: string): string {
	requireRuntimePaths(paths);
	if (!validTaskSlug(slug)) throw new Error(`${slug}: invalid task slug`);
	return join(paths.tasks, slug);
}

function requireOwnedRepository(document: TaskDocument, expectedWorktree: string): void {
	if (document.repository.branch !== document.slug)
		throw new Error("task repository branch differs from task slug");
	if (document.repository.worktree !== expectedWorktree)
		throw new Error("task repository worktree is outside the managed task path");
}

function storedTaskWorktree(task: StoredTask): string {
	if (basename(task.directory) !== task.document.slug)
		throw new Error("task directory differs from task slug");
	return join(dirname(dirname(task.directory)), "worktrees", task.document.slug);
}

function syncDirectory(path: string): void {
	const directory = openSync(path, "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

export function loadTask(paths: RuntimePaths, slug: string): StoredTask {
	const directory = taskDirectory(paths, slug);
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`${directory}: invalid task directory`);
	const document = loadTaskDocument(join(directory, "task.json"));
	if (document.slug !== slug)
		throw new Error(`${directory}: task slug differs from task.json`);
	requireOwnedRepository(document, join(paths.worktrees, slug));
	return { directory, document };
}

export function createTask(
	paths: RuntimePaths,
	input: NewTaskInput,
): StoredTask {
	const directory = taskDirectory(paths, input.slug);
	if (existsSync(directory)) throw new Error(`${directory}: task already exists`);
	const document = createTaskDocument(input);
	requireOwnedRepository(document, join(paths.worktrees, input.slug));
	const temporary = mkdtempSync(join(paths.tasks, `.${input.slug}.`));
	let installed = false;
	try {
		saveTaskDocument(join(temporary, "task.json"), document);
		renameSync(temporary, directory);
		installed = true;
	} catch (error) {
		if (!installed) rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
	try {
		syncDirectory(paths.tasks);
	} catch (firstError) {
		try {
			syncDirectory(paths.tasks);
		} catch (retryError) {
			throw new AggregateError(
				[firstError, retryError],
				`${directory}: task directory is installed but parent durability remains uncertain`,
			);
		}
	}
	return { directory, document };
}

export function saveTask(task: StoredTask, document: TaskDocument): StoredTask {
	if (task.document.slug !== document.slug)
		throw new Error("cannot change a persisted task slug");
	const expectedWorktree = storedTaskWorktree(task);
	requireOwnedRepository(task.document, expectedWorktree);
	requireOwnedRepository(document, expectedWorktree);
	saveTaskDocument(join(task.directory, "task.json"), document);
	return { directory: task.directory, document };
}

function removeExactTaskDirectory(directory: string): void {
	const stat = lstatSync(directory, { throwIfNoEntry: false });
	if (!stat?.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
		throw new Error(`${directory}: invalid task directory`);
	rmSync(directory, { recursive: true });
	syncDirectory(dirname(directory));
}

export function removeTaskRecord(task: StoredTask): void {
	requireOwnedRepository(task.document, storedTaskWorktree(task));
	removeExactTaskDirectory(task.directory);
}

export function removeInvalidTaskRecord(paths: RuntimePaths, slug: string): void {
	removeExactTaskDirectory(taskDirectory(paths, slug));
}

export interface ScannedTask {
	task?: StoredTask;
	summary: TaskSummary;
}

export function scanTasks(paths: RuntimePaths): ScannedTask[] {
	requireRuntimePaths(paths);
	return readdirSync(paths.tasks, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && validTaskSlug(entry.name))
		.map((entry): ScannedTask => {
			const directory = join(paths.tasks, entry.name);
			try {
				const task = loadTask(paths, entry.name);
				const names = readdirSync(directory);
				return {
					task,
					summary: {
						slug: task.document.slug,
						title: task.document.title,
						request: task.document.request,
						stage: task.document.stage,
						modified: new Date(
							Math.max(
								lstatSync(directory).mtimeMs,
								...names.map((name) => lstatSync(join(directory, name)).mtimeMs),
							),
						),
						valid: true,
					},
				};
			} catch (error) {
				let title = entry.name;
				let request = "";
				try {
					const raw = JSON.parse(
						readFileSync(join(directory, "task.json"), "utf8"),
					) as Record<string, unknown>;
					if (typeof raw.title === "string") title = raw.title;
					if (typeof raw.request === "string") request = raw.request;
				} catch {}
				return {
					summary: {
						slug: entry.name,
						title,
						request,
						stage: "invalid",
						modified: new Date(lstatSync(directory).mtimeMs),
						valid: false,
						error: error instanceof Error ? error.message : String(error),
					},
				};
			}
		})
		.sort(
			(left, right) =>
				right.summary.modified.getTime() - left.summary.modified.getTime(),
		);
}

export function listTasks(paths: RuntimePaths): TaskSummary[] {
	return scanTasks(paths).map(({ summary }) => summary);
}

export function findTaskBySession(
	paths: RuntimePaths,
	sessionPath: string,
): StoredTask | undefined {
	const matches = scanTasks(paths).flatMap(({ task }) =>
		task && findTaskSessionByPath(task.document, sessionPath) ? [task] : []
	);
	if (matches.length > 1)
		throw new Error("current session belongs to multiple JURUC tasks");
	return matches[0];
}
