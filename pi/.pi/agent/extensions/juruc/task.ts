import { randomUUID } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const TASK_VERSION = 1 as const;
export const TASK_STAGES = [
	"research",
	"planning",
	"building",
	"blocked",
	"done",
] as const;

export type TaskStage = (typeof TASK_STAGES)[number];
export type SessionKind = "research" | "planning" | "build";

export interface TaskRepository {
	sourceRoot: string;
	baseBranch: string;
	sourceHead: string;
	branch: string;
	worktree: string;
}

export interface TaskSessions {
	research: string | null;
	planning: string | null;
	build: string | null;
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
	sessions: TaskSessions;
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

function validNullableAbsolutePath(value: unknown): value is string | null {
	return value === null || (validText(value) && isAbsolute(value));
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

function validSessions(value: unknown): value is TaskSessions {
	const sessions = record(value);
	if (
		!sessions ||
		!exactKeys(sessions, ["research", "planning", "build"]) ||
		!validNullableAbsolutePath(sessions.research) ||
		!validNullableAbsolutePath(sessions.planning) ||
		!validNullableAbsolutePath(sessions.build)
	)
		return false;
	const paths = [sessions.research, sessions.planning, sessions.build].filter(
		(path): path is string => path !== null,
	);
	return new Set(paths).size === paths.length;
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
	const sessions = task.sessions as TaskSessions;
	if (stage === "blocked")
		return Boolean(plan?.remaining.length && sessions.build && task.blockReason);
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
		sessions: { research: null, planning: null, build: null },
		plan: null,
		blockReason: null,
	});
}

export function recordTaskSession(
	task: TaskDocument,
	kind: SessionKind,
	path: string,
): TaskDocument {
	if (!isAbsolute(path)) throw new Error(`${kind} session path must be absolute`);
	if (kind === "research" && task.stage !== "research")
		throw new Error("research session requires research stage");
	if (kind === "planning" && task.stage !== "planning")
		throw new Error("planning session requires planning stage");
	if (kind === "build" && task.stage !== "building")
		throw new Error("build session requires building stage");
	if (
		Object.entries(task.sessions).some(
			([role, owned]) => role !== kind && owned === path,
		)
	)
		throw new Error("research, planning, and build sessions must be separate");
	return checked({
		...task,
		sessions: { ...task.sessions, [kind]: path },
	});
}

export function finishTaskResearch(task: TaskDocument): TaskDocument {
	if (task.stage !== "research") throw new Error("task is not researching");
	return checked({ ...task, stage: "planning" });
}

export function returnTaskToResearch(task: TaskDocument): TaskDocument {
	if (task.stage !== "planning" && task.stage !== "blocked")
		throw new Error("only planning or blocked tasks can return to research");
	return checked({
		...task,
		stage: "research",
		sessions: { ...task.sessions, research: null },
	});
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
	if (!task.sessions.build) throw new Error("active phase has no build session");
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
		sessions: { ...task.sessions, build: null },
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
