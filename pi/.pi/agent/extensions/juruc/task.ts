import { randomUUID } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const TASK_VERSION = 2 as const;
export const TASK_STAGES = [
	"research",
	"planning",
	"building",
	"blocked",
	"done",
] as const;

export type TaskStage = (typeof TASK_STAGES)[number];
export type DiscoverySessionKind =
	| "questions"
	| "research"
	| "specification"
	| "plan";
export type ReviewerSessionKind = "deviation-review" | "correctness-review";

export type TaskSessionRun =
	| { kind: DiscoverySessionKind; path: string }
	| { kind: "implementation"; phase: number; path: string }
	| { kind: ReviewerSessionKind; round: number; path: string }
	| { kind: "correction"; round: number; path: string };

export type TaskSessionKey =
	| { kind: DiscoverySessionKind }
	| { kind: "implementation"; phase: number }
	| { kind: ReviewerSessionKind; round: number }
	| { kind: "correction"; round: number };

export interface TaskRepository {
	sourceRoot: string;
	baseBranch: string;
	sourceHead: string;
	branch: string;
	worktree: string;
}

export interface TaskPhase {
	title: string;
	objective: string;
	successCriteria: string[];
	verification: string[];
	hints: string[];
}

export interface VerificationEvidence {
	command: string;
	exitCode: number;
	summary: string;
}

export interface CompletedTaskPhase extends TaskPhase {
	resolution: string;
	verificationEvidence: VerificationEvidence[];
	commit: string;
}

export interface TaskPlan {
	objective: string;
	constraints: string[];
	assumptions: string[];
	nonGoals: string[];
	successCriteria: string[];
	completed: CompletedTaskPhase[];
	remaining: TaskPhase[];
}

export interface TaskDocument {
	version: typeof TASK_VERSION;
	slug: string;
	title: string;
	request: string;
	repository: TaskRepository;
	stage: TaskStage;
	sessions: TaskSessionRun[];
	plan: TaskPlan | null;
	blockReason: string | null;
}

export interface TaskPlanInput {
	objective: string;
	constraints: string[];
	assumptions: string[];
	nonGoals: string[];
	successCriteria: string[];
	remaining: TaskPhase[];
}

export interface NewTaskInput {
	slug: string;
	title: string;
	request: string;
	repository: TaskRepository;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_TEXT_LENGTH = 100_000;
const MAX_VERIFICATION_SUMMARY_LENGTH = 1_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validText(value: unknown, nonempty = true): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAX_TEXT_LENGTH &&
		(!nonempty || value.trim().length > 0) &&
		!value.includes("\0")
	);
}

function validTextList(value: unknown, nonempty = false): value is string[] {
	return (
		Array.isArray(value) &&
		(!nonempty || value.length > 0) &&
		value.every((item) => validText(item))
	);
}

function validRepository(value: unknown): value is TaskRepository {
	const repository = record(value);
	return Boolean(
		repository &&
			exactKeys(repository, [
				"sourceRoot",
				"baseBranch",
				"sourceHead",
				"branch",
				"worktree",
			]) &&
			validText(repository.sourceRoot) &&
			isAbsolute(repository.sourceRoot) &&
			validText(repository.baseBranch) &&
			validText(repository.sourceHead) &&
			OBJECT_ID.test(repository.sourceHead as string) &&
			validText(repository.branch) &&
			validText(repository.worktree) &&
			isAbsolute(repository.worktree as string) &&
			repository.worktree !== repository.sourceRoot,
	);
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function validSessionRun(value: unknown): value is TaskSessionRun {
	const run = record(value);
	if (!run || !validText(run.kind) || !validText(run.path) || !isAbsolute(run.path))
		return false;
	switch (run.kind) {
		case "questions":
		case "research":
		case "specification":
		case "plan":
			return exactKeys(run, ["kind", "path"]);
		case "implementation":
			return exactKeys(run, ["kind", "phase", "path"]) && positiveInteger(run.phase);
		case "deviation-review":
		case "correctness-review":
		case "correction":
			return exactKeys(run, ["kind", "round", "path"]) && positiveInteger(run.round);
		default:
			return false;
	}
}

function sessionLogicalKey(run: TaskSessionRun | TaskSessionKey): string {
	switch (run.kind) {
		case "implementation":
			return `${run.kind}:${run.phase}`;
		case "deviation-review":
		case "correctness-review":
		case "correction":
			return `${run.kind}:${run.round}`;
		default:
			return run.kind;
	}
}

function validSessions(value: unknown): value is TaskSessionRun[] {
	if (!Array.isArray(value) || !value.every(validSessionRun)) return false;
	const paths = value.map(({ path }) => path);
	const keys = value.map(sessionLogicalKey);
	return new Set(paths).size === paths.length && new Set(keys).size === keys.length;
}

function validPhase(value: unknown): value is TaskPhase {
	const phase = record(value);
	return Boolean(
		phase &&
			exactKeys(phase, [
				"title",
				"objective",
				"successCriteria",
				"verification",
				"hints",
			]) &&
			validText(phase.title) &&
			validText(phase.objective) &&
			validTextList(phase.successCriteria, true) &&
			validTextList(phase.verification, true) &&
			new Set(phase.verification as string[]).size ===
				(phase.verification as string[]).length &&
			validTextList(phase.hints),
	);
}

function validVerificationEvidence(
	value: unknown,
): value is VerificationEvidence {
	const evidence = record(value);
	return Boolean(
		evidence &&
			exactKeys(evidence, ["command", "exitCode", "summary"]) &&
			validText(evidence.command) &&
			Number.isInteger(evidence.exitCode) &&
			validText(evidence.summary) &&
			(evidence.summary as string).length <= MAX_VERIFICATION_SUMMARY_LENGTH,
	);
}

function validCompletedPhase(value: unknown): value is CompletedTaskPhase {
	const phase = record(value);
	if (
		!phase ||
		!exactKeys(phase, [
			"title",
			"objective",
			"successCriteria",
			"verification",
			"hints",
			"resolution",
			"verificationEvidence",
			"commit",
		])
	)
		return false;
	const content = {
		title: phase.title,
		objective: phase.objective,
		successCriteria: phase.successCriteria,
		verification: phase.verification,
		hints: phase.hints,
	};
	return (
		validPhase(content) &&
		validText(phase.resolution) &&
		Array.isArray(phase.verificationEvidence) &&
		phase.verificationEvidence.length === content.verification.length &&
		phase.verificationEvidence.every(
			(evidence, index) =>
				validVerificationEvidence(evidence) &&
				evidence.command === content.verification[index] &&
				evidence.exitCode === 0,
		) &&
		typeof phase.commit === "string" &&
		OBJECT_ID.test(phase.commit)
	);
}

function validPlan(value: unknown): value is TaskPlan {
	const plan = record(value);
	return Boolean(
		plan &&
			exactKeys(plan, [
				"objective",
				"constraints",
				"assumptions",
				"nonGoals",
				"successCriteria",
				"completed",
				"remaining",
			]) &&
			validText(plan.objective) &&
			validTextList(plan.constraints) &&
			validTextList(plan.assumptions) &&
			validTextList(plan.nonGoals) &&
			validTextList(plan.successCriteria, true) &&
			Array.isArray(plan.completed) &&
			plan.completed.every(validCompletedPhase) &&
			Array.isArray(plan.remaining) &&
			plan.remaining.every(validPhase),
	);
}

export function validTaskDocument(value: unknown): value is TaskDocument {
	const task = record(value);
	if (
		!task ||
		!exactKeys(task, [
			"version",
			"slug",
			"title",
			"request",
			"repository",
			"stage",
			"sessions",
			"plan",
			"blockReason",
		]) ||
		task.version !== TASK_VERSION ||
		typeof task.slug !== "string" ||
		!SLUG.test(task.slug) ||
		!validText(task.title) ||
		!validText(task.request) ||
		!validRepository(task.repository) ||
		!validSessions(task.sessions) ||
		!TASK_STAGES.includes(task.stage as TaskStage) ||
		(task.plan !== null && !validPlan(task.plan)) ||
		(task.blockReason !== null && !validText(task.blockReason))
	)
		return false;

	const stage = task.stage as TaskStage;
	const plan = task.plan as TaskPlan | null;
	const sessions = task.sessions as TaskSessionRun[];
	if (stage === "blocked")
		return Boolean(
			plan?.remaining.length &&
			findSession(sessions, {
				kind: "implementation",
				phase: plan.completed.length + 1,
			}) &&
			task.blockReason,
		);
	if (stage === "building")
		return task.blockReason === null && Boolean(plan?.remaining.length);
	if (stage === "done")
		return task.blockReason === null && Boolean(plan && plan.remaining.length === 0);
	return true;
}

function checked(task: TaskDocument): TaskDocument {
	if (!validTaskDocument(task)) throw new Error("invalid JURUC task document");
	return structuredClone(task);
}

export function createTaskDocument(input: NewTaskInput): TaskDocument {
	return checked({
		version: TASK_VERSION,
		slug: input.slug,
		title: input.title,
		request: input.request,
		repository: structuredClone(input.repository),
		stage: "research",
		sessions: [],
		plan: null,
		blockReason: null,
	});
}

function findSession(
	sessions: readonly TaskSessionRun[],
	key: TaskSessionKey,
): TaskSessionRun | undefined {
	const logicalKey = sessionLogicalKey(key);
	return sessions.find((run) => sessionLogicalKey(run) === logicalKey);
}

export function findTaskSession(
	task: Pick<TaskDocument, "sessions">,
	key: TaskSessionKey,
): TaskSessionRun | undefined {
	return findSession(task.sessions, key);
}

export function findTaskSessionByPath(
	task: Pick<TaskDocument, "sessions">,
	path: string,
): TaskSessionRun | undefined {
	return task.sessions.find((run) => run.path === path);
}

export function appendTaskSession(
	task: TaskDocument,
	run: TaskSessionRun,
): TaskDocument {
	if (!validSessionRun(run)) throw new Error("invalid task session run");
	if (findTaskSessionByPath(task, run.path))
		throw new Error(`session path is already recorded: ${run.path}`);
	if (findSession(task.sessions, run))
		throw new Error(`session run is already recorded: ${sessionLogicalKey(run)}`);
	return checked({
		...task,
		sessions: [...task.sessions, structuredClone(run)],
	});
}

export function finishTaskResearch(task: TaskDocument): TaskDocument {
	if (task.stage !== "research") throw new Error("task is not researching");
	return checked({ ...task, stage: "planning" });
}

export function returnTaskToResearch(task: TaskDocument): TaskDocument {
	if (task.stage !== "planning" && task.stage !== "blocked")
		throw new Error("only planning or blocked tasks can return to research");
	return checked({ ...task, stage: "research" });
}

export function returnTaskToPlanning(task: TaskDocument): TaskDocument {
	if (task.stage !== "blocked") throw new Error("task is not blocked");
	return checked({ ...task, stage: "planning" });
}

export function extendTask(task: TaskDocument): TaskDocument {
	if (task.stage !== "done") throw new Error("task is not done");
	return checked({ ...task, stage: "planning" });
}

export function setTaskPlan(
	task: TaskDocument,
	input: TaskPlanInput,
): TaskDocument {
	if (task.stage !== "planning") throw new Error("task is not planning");
	if (input.remaining.length === 0)
		throw new Error("a confirmed plan requires at least one remaining phase");
	return checked({
		...task,
		stage: "building",
		plan: {
			objective: input.objective,
			constraints: [...input.constraints],
			assumptions: [...input.assumptions],
			nonGoals: [...input.nonGoals],
			successCriteria: [...input.successCriteria],
			completed: structuredClone(task.plan?.completed ?? []),
			remaining: structuredClone(input.remaining),
		},
		blockReason: null,
	});
}

export function blockTaskPhase(
	task: TaskDocument,
	reason: string,
): TaskDocument {
	if (task.stage !== "building") throw new Error("task is not building");
	const phase = (task.plan?.completed.length ?? 0) + 1;
	if (!findTaskSession(task, { kind: "implementation", phase }))
		throw new Error("active phase has no implementation session");
	return checked({ ...task, stage: "blocked", blockReason: reason });
}

export function resumeTaskPhase(task: TaskDocument): TaskDocument {
	if (task.stage !== "blocked") throw new Error("task is not blocked");
	return checked({ ...task, stage: "building", blockReason: null });
}

export function completeTaskPhase(
	task: TaskDocument,
	resolution: string,
	verificationEvidence: VerificationEvidence[],
	commit: string,
): TaskDocument {
	if (task.stage !== "building" || !task.plan?.remaining.length)
		throw new Error("task has no active build phase");
	const [current, ...remaining] = task.plan.remaining;
	return checked({
		...task,
		stage: remaining.length ? "building" : "done",
		plan: {
			...task.plan,
			completed: [
				...task.plan.completed,
				{
					...structuredClone(current),
					resolution,
					verificationEvidence: structuredClone(verificationEvidence),
					commit,
				},
			],
			remaining: structuredClone(remaining),
		},
		blockReason: null,
	});
}

export function parseTaskDocument(json: string): TaskDocument {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new Error("task.json is not valid JSON");
	}
	if (!validTaskDocument(value)) throw new Error("task.json is invalid");
	return structuredClone(value);
}

export function serializeTaskDocument(task: TaskDocument): string {
	if (!validTaskDocument(task)) throw new Error("cannot serialize invalid task.json");
	return `${JSON.stringify(task, null, 2)}\n`;
}

export function loadTaskDocument(path: string): TaskDocument {
	return parseTaskDocument(readFileSync(path, "utf8"));
}

export function saveTaskDocument(path: string, task: TaskDocument): void {
	const existing = lstatSync(path, { throwIfNoEntry: false });
	if (existing && (!existing.isFile() || existing.isSymbolicLink()))
		throw new Error(`${path} is not a regular file`);
	const temporary = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporary, serializeTaskDocument(task), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}
