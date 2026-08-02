import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	createPlanEnvelope,
	loadPlanEnvelope,
	savePlanEnvelope,
	semanticSerialize,
	type PlanEnvelope,
} from "./plan.ts";
import {
	managedDeletionWorktreeSnapshot,
	removeManagedWorktree,
	worktreeStatus,
} from "./repository.ts";
import {
	requireExactDirectory,
	requireRuntimePaths,
	runtimePathsForRoot,
	type RuntimePaths,
} from "./runtime.ts";
import {
	attachResearchSession,
	creatingState,
	deletingState,
	loadExecutionState,
	parseExecutionState,
	semanticSerializeExecutionState,
	researchPlanningState,
	saveExecutionState,
	transitionExecutionState,
	type DeletionWorktreeSnapshot,
	type ExecutionState,
	sameSessionIdentity,
	STATE_VERSION,
	type PlanningReason,
	type SessionIdentity,
	type TaskIdentity,
} from "./state.ts";

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface TaskRecord {
	directory: string;
	plan: PlanEnvelope;
	state: ExecutionState;
}

export interface TaskSummary {
	slug: string;
	title: string;
	request: string;
	phase: string;
	modified: Date;
	valid: boolean;
	error?: string;
}

export interface DeletionEvidence {
	task: TaskRecord;
	worktreeSnapshot: DeletionWorktreeSnapshot;
	buildSessions: SessionIdentity[];
	status?: string;
}

export function validTaskSlug(slug: string): boolean {
	return SLUG.test(slug);
}

export function validGeneratedTitle(title: string): boolean {
	return (
		title.length > 0 &&
		title === title.trim() &&
		/^[\x20-\x7e]+$/.test(title)
	);
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.slice(0, 5)
		.join("-")
		.slice(0, 48)
		.replace(/-+$/, "");
}

export function uniqueSlug(tasks: string, base: string): string {
	requireExactDirectory(tasks);
	let slug = base;
	for (let suffix = 2; existsSync(join(tasks, slug)); suffix++)
		slug = `${base}-${suffix}`;
	return slug;
}

function exactTaskDirectory(paths: RuntimePaths, slug: string): string {
	requireRuntimePaths(paths);
	if (!SLUG.test(slug)) throw new Error(`${slug}: invalid task slug`);
	const directory = join(paths.tasks, slug);
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`${directory} is not a regular task directory`);
	if (realpathSync(directory) !== directory)
		throw new Error(`${directory} is not the exact task directory`);
	return directory;
}

function hydrateState(paths: RuntimePaths, persisted: ExecutionState): ExecutionState {
	return { ...persisted, branch: persisted.slug, worktree: join(paths.worktrees, persisted.slug) } as ExecutionState;
}

function validateTaskIdentity(paths: RuntimePaths, task: TaskRecord): void {
	const { state, directory } = task;
	if (directory !== join(paths.tasks, state.slug))
		throw new Error("task directory does not match the execution-state slug");
	if (state.branch !== state.slug || state.worktree !== join(paths.worktrees, state.slug))
		throw new Error("derived task branch or worktree is invalid");
}

function requireTaskRecord(task: TaskRecord): void {
	const paths = runtimePathsForRoot(dirname(dirname(task.directory)));
	validateTaskIdentity(paths, task);
	requireExactDirectory(task.directory);
}

export function loadTask(paths: RuntimePaths, slug: string): TaskRecord {
	const directory = exactTaskDirectory(paths, slug);
	const plan = loadPlanEnvelope(join(directory, "plan.json"));
	const persisted = loadExecutionState(join(directory, "state.json"));
	const state = hydrateState(paths, persisted);
	const task = { directory, plan, state };
	validateTaskIdentity(paths, task);
	return task;
}

export interface ScannedTask {
	task?: TaskRecord;
	summary: TaskSummary;
}

export function scanTasks(paths: RuntimePaths): ScannedTask[] {
	requireRuntimePaths(paths);
	return readdirSync(paths.tasks, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
		.map((entry): ScannedTask => {
			const directory = join(paths.tasks, entry.name);
			try {
				const plan = loadPlanEnvelope(join(directory, "plan.json"));
				const persisted = loadExecutionState(join(directory, "state.json"));
				const state = hydrateState(paths, persisted);
				const task = { directory, plan, state };
				validateTaskIdentity(paths, task);
				const names = readdirSync(directory);
				return {
					task,
					summary: {
						slug: entry.name,
						title: plan.title,
						request: plan.request,
						phase: state.phase,
						modified: new Date(Math.max(lstatSync(directory).mtimeMs, ...names.map((name) => lstatSync(join(directory, name)).mtimeMs))),
						valid: true,
					},
				};
			} catch (error) {
				return {
					summary: {
						slug: entry.name,
						title: entry.name,
						request: "",
						phase: "invalid",
						modified: new Date(lstatSync(directory).mtimeMs),
						valid: false,
						error: error instanceof Error ? error.message : String(error),
					},
				};
			}
		})
		.sort((left, right) => right.summary.modified.getTime() - left.summary.modified.getTime());
}

export function listTasks(paths: RuntimePaths): TaskSummary[] {
	return scanTasks(paths).map(({ summary }) => summary);
}

export function taskIdentity(
	paths: RuntimePaths,
	slug: string,
	sourceRoot: string,
	baseBranch: string,
	sourceHead: string,
): TaskIdentity {
	requireRuntimePaths(paths);
	return {
		version: STATE_VERSION,
		slug,
		branch: slug,
		worktree: join(paths.worktrees, slug),
		sourceRoot,
		baseBranch,
		sourceHead,
		planningSession: null,
		buildSessions: [],
	};
}

export function createTask(
	paths: RuntimePaths,
	title: string,
	slug: string,
	request: string,
	identity: TaskIdentity,
): TaskRecord {
	requireRuntimePaths(paths);
	const directory = join(paths.tasks, slug);
	if (existsSync(directory))
		throw new Error(
			`${directory} already exists; remove or repair it before creating this task`,
		);
	const plan = createPlanEnvelope(title, request);
	const state = creatingState(identity);
	const task = { directory, plan, state };
	validateTaskIdentity(paths, task);
	const temporary = mkdtempSync(join(paths.tasks, `.${slug}.`));
	try {
		savePlanEnvelope(join(temporary, "plan.json"), plan);
		saveExecutionState(join(temporary, "state.json"), state);
		if (existsSync(directory))
			throw new Error(
				`${directory} already exists; remove or repair it before creating this task`,
			);
		renameSync(temporary, directory);
		return task;
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}

function requireUnchangedTask(task: TaskRecord, action: string): void {
	const currentPlan = loadPlanEnvelope(join(task.directory, "plan.json"));
	const paths = runtimePathsForRoot(dirname(dirname(task.directory)));
	const currentState = hydrateState(paths, loadExecutionState(join(task.directory, "state.json")));
	if (
		semanticSerialize(currentPlan) !== semanticSerialize(task.plan) ||
		semanticSerializeExecutionState(currentState) !== semanticSerializeExecutionState(task.state)
	)
		throw new Error(`${task.state.slug}: task changed while ${action}`);
}

export function enterPlanning(task: TaskRecord): TaskRecord {
	requireTaskRecord(task);
	if (task.state.phase !== "creating")
		throw new Error(`${task.state.slug}: task is not being created`);
	requireUnchangedTask(task, "creating its worktree");
	const state = transitionExecutionState(
		task.state,
		researchPlanningState(task.state, "initial", task.plan.request),
	);
	saveExecutionState(join(task.directory, "state.json"), state);
	return { ...task, state };
}

export function exactSessionIdentity(path: string): SessionIdentity {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
		throw new Error(`${path}: session is not an exact regular file`);
	let header: unknown;
	try {
		header = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]);
	} catch {
		throw new Error(`${path}: session header identity is unavailable`);
	}
	if (
		header === null ||
		typeof header !== "object" ||
		Array.isArray(header) ||
		(header as Record<string, unknown>).type !== "session" ||
		typeof (header as Record<string, unknown>).id !== "string"
	)
		throw new Error(`${path}: session header identity is unavailable`);
	return { path, id: (header as { id: string }).id };
}

export function recordPlanningSession(
	task: TaskRecord,
	planningSession: SessionIdentity,
): TaskRecord {
	requireTaskRecord(task);
	if (task.state.phase !== "planning")
		throw new Error(`${task.state.slug}: task is not planning`);
	const actual = exactSessionIdentity(planningSession.path);
	if (!sameSessionIdentity(planningSession, actual))
		throw new Error(`${planningSession.path}: planning session identity changed`);
	if (task.state.planningSession !== null) {
		if (sameSessionIdentity(task.state.planningSession, planningSession)) return task;
		throw new Error(`${task.state.slug}: planning session is already owned`);
	}
	requireUnchangedTask(task, "recording its planning session");
	const state = { ...task.state, planningSession };
	if (!parseExecutionState(state))
		throw new Error(`${planningSession.path}: invalid planning session identity`);
	saveExecutionState(join(task.directory, "state.json"), state);
	return { ...task, state };
}

export function recordResearchSession(
	task: TaskRecord,
	researchSession: SessionIdentity,
): TaskRecord {
	requireTaskRecord(task);
	if (task.state.phase !== "planning" || task.state.step !== "research")
		throw new Error(`${task.state.slug}: task is not researching`);
	const actual = exactSessionIdentity(researchSession.path);
	if (!sameSessionIdentity(researchSession, actual))
		throw new Error(`${researchSession.path}: research session identity changed`);
	const header = JSON.parse(readFileSync(researchSession.path, "utf8").split("\n", 1)[0]) as Record<string, unknown>;
	if (header.cwd !== task.state.worktree)
		throw new Error(`${researchSession.path}: research session cwd differs from the task worktree`);
	if (task.state.researchSession !== null) {
		if (sameSessionIdentity(task.state.researchSession, researchSession)) return task;
		throw new Error(`${task.state.slug}: research session is already owned`);
	}
	if (task.state.planningSession && sameSessionIdentity(task.state.planningSession, researchSession))
		throw new Error(`${researchSession.path}: planning session cannot be reused for research`);
	if (task.state.buildSessions.some((session) => sameSessionIdentity(session, researchSession)))
		throw new Error(`${researchSession.path}: build session cannot be reused for research`);
	requireUnchangedTask(task, "recording its research session");
	const state = attachResearchSession(task.state, researchSession);
	saveExecutionState(join(task.directory, "state.json"), state);
	return { ...task, state };
}

export function recordBuildSession(
	task: TaskRecord,
	buildSession: SessionIdentity,
): TaskRecord {
	requireTaskRecord(task);
	if (task.state.phase !== "starting")
		throw new Error(`${task.state.slug}: task is not starting a build phase`);
	const actual = exactSessionIdentity(buildSession.path);
	if (!sameSessionIdentity(buildSession, actual))
		throw new Error(`${buildSession.path}: build session identity changed`);
	const header = JSON.parse(readFileSync(buildSession.path, "utf8").split("\n", 1)[0]) as Record<string, unknown>;
	if (header.cwd !== task.state.worktree)
		throw new Error(`${buildSession.path}: build session cwd differs from the task worktree`);
	if (task.state.phaseSession !== null) {
		if (sameSessionIdentity(task.state.phaseSession, buildSession)) return task;
		throw new Error(`${task.state.slug}: build phase session is already owned`);
	}
	if (task.state.planningSession && sameSessionIdentity(task.state.planningSession, buildSession))
		throw new Error(`${buildSession.path}: planning session cannot be reused for building`);
	const existing = task.state.buildSessions.find((session) => session.path === buildSession.path);
	if (existing)
		throw new Error(`${buildSession.path}: build session was already used by another phase`);
	requireUnchangedTask(task, "recording a build session");
	const state = {
		...task.state,
		buildSessions: [...task.state.buildSessions, buildSession].sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		),
		phaseSession: buildSession,
	};
	if (!parseExecutionState(state))
		throw new Error(`${buildSession.path}: invalid build session identity`);
	saveExecutionState(join(task.directory, "state.json"), state);
	return { ...task, state };
}

export function returnToPlanning(
	task: TaskRecord,
	reason: Exclude<PlanningReason, "initial">,
	subject: string,
): TaskRecord {
	requireTaskRecord(task);
	if (
		task.state.phase !== "building" &&
		task.state.phase !== "staging" &&
		task.state.phase !== "committing" &&
		task.state.phase !== "done"
	)
		throw new Error(`${task.state.slug}: task cannot return to planning`);
	requireUnchangedTask(task, "returning to planning");
	const state = transitionExecutionState(
		task.state,
		researchPlanningState(task.state, reason, subject),
	);
	saveExecutionState(join(task.directory, "state.json"), state);
	return { ...task, state };
}

function sameDeletionWorktreeSnapshot(
	left: DeletionWorktreeSnapshot,
	right: DeletionWorktreeSnapshot,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "absent" || right.kind === "absent") return true;
	return (
		left.head === right.head &&
		left.paths.length === right.paths.length &&
		left.paths.every((path, index) => path === right.paths[index])
	);
}

export async function deletionEvidence(
	paths: RuntimePaths,
	slug: string,
): Promise<DeletionEvidence> {
	const task = loadTask(paths, slug);
	const worktreeSnapshot = await managedDeletionWorktreeSnapshot(task.state);
	const status = await worktreeStatus(task.state);
	if (
		!sameDeletionWorktreeSnapshot(
			worktreeSnapshot,
			await managedDeletionWorktreeSnapshot(task.state),
		)
	)
		throw new Error(`${slug}: worktree changed while preparing deletion`);
	return {
		task,
		worktreeSnapshot,
		buildSessions: task.state.buildSessions.map((session) => ({ ...session })),
		status,
	};
}

export async function beginTaskDeletion(
	evidence: DeletionEvidence,
): Promise<TaskRecord> {
	const { task } = evidence;
	requireTaskRecord(task);
	const currentPlan = loadPlanEnvelope(join(task.directory, "plan.json"));
	const paths = runtimePathsForRoot(dirname(dirname(task.directory)));
	const currentState = hydrateState(paths, loadExecutionState(join(task.directory, "state.json")));
	if (
		semanticSerialize(currentPlan) !== semanticSerialize(task.plan) ||
		semanticSerializeExecutionState(currentState) !== semanticSerializeExecutionState(task.state)
	)
		throw new Error(`${task.state.slug}: task changed before deletion`);
	if (
		!sameDeletionWorktreeSnapshot(
			evidence.worktreeSnapshot,
			await managedDeletionWorktreeSnapshot(currentState),
		)
	)
		throw new Error(`${task.state.slug}: worktree changed after deletion confirmation`);
	if (
		evidence.buildSessions.length !== currentState.buildSessions.length ||
		evidence.buildSessions.some(
			(session, index) =>
				!sameSessionIdentity(session, currentState.buildSessions[index]),
		)
	)
		throw new Error(`${task.state.slug}: owned build sessions changed after deletion confirmation`);
	const deleting = deletingState(currentState, evidence.worktreeSnapshot);
	const state =
		currentState.phase === "deleting"
			? deleting
			: transitionExecutionState(currentState, deleting);
	saveExecutionState(join(task.directory, "state.json"), state);
	return { ...task, state };
}

export async function recoverTaskDeletion(task: TaskRecord): Promise<void> {
	requireTaskRecord(task);
	if (task.state.phase !== "deleting")
		throw new Error(`${task.state.slug}: deletion has not been confirmed`);
	const currentPlan = loadPlanEnvelope(join(task.directory, "plan.json"));
	const paths = runtimePathsForRoot(dirname(dirname(task.directory)));
	const currentState = hydrateState(paths, loadExecutionState(join(task.directory, "state.json")));
	if (
		currentState.phase !== "deleting" ||
		semanticSerialize(currentPlan) !== semanticSerialize(task.plan) ||
		semanticSerializeExecutionState(currentState) !== semanticSerializeExecutionState(task.state)
	)
		throw new Error(`${task.state.slug}: deletion transaction changed`);
	const currentSnapshot = await managedDeletionWorktreeSnapshot(currentState);
	const removalAlreadyCompleted =
		currentState.worktreeSnapshot.kind === "present" &&
		currentSnapshot.kind === "absent";
	if (
		!removalAlreadyCompleted &&
		!sameDeletionWorktreeSnapshot(
			currentState.worktreeSnapshot,
			currentSnapshot,
		)
	)
		throw new Error(
			`${task.state.slug}: managed worktree changed since deletion confirmation; use the picker delete action to review and reconfirm`,
		);
	await removeManagedWorktree(currentState);
	for (const owned of currentState.buildSessions) {
		let actual: SessionIdentity;
		try {
			actual = exactSessionIdentity(owned.path);
		} catch {
			continue;
		}
		if (!sameSessionIdentity(owned, actual)) continue;
		try {
			unlinkSync(owned.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	rmSync(task.directory, { recursive: true });
}
