import { randomUUID } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const TASK_VERSION = 3 as const;
export const TASK_STAGES = [
	"questions",
	"research",
	"specification",
	"plan",
	"implementation",
	"done",
] as const;

export type TaskStage = (typeof TASK_STAGES)[number];
export type DiscoverySessionKind = "questions" | "research" | "specification" | "plan";
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

export interface TaskQuestions {
	sharedUnderstanding: string;
	decisions: string[];
	acceptedAssumptions: string[];
	researchTargets: string[];
}

export interface TaskSpecification {
	summary: string;
	requirements: string[];
	nonGoals: string[];
	constraints: string[];
	acceptanceCriteria: string[];
	decisions: string[];
}

export interface TaskPhase {
	id: string;
	title: string;
	goal: string;
	fileScopes: string[];
	instructions: string[];
	verification: string[];
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
	phases: TaskPhase[];
}

export interface TaskDocument {
	version: typeof TASK_VERSION;
	slug: string;
	title: string;
	request: string;
	repository: TaskRepository;
	stage: TaskStage;
	sessions: TaskSessionRun[];
	questions: TaskQuestions | null;
	specification: TaskSpecification | null;
	plan: TaskPlan | null;
	checkpoints: CompletedTaskPhase[];
}

export interface NewTaskInput {
	slug: string;
	title: string;
	request: string;
	repository: TaskRepository;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PHASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
export const MAX_TASK_TEXT_LENGTH = 100_000;
const MAX_VERIFICATION_SUMMARY_LENGTH = 1_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validText(value: unknown, nonempty = true): value is string {
	return typeof value === "string" &&
		value.length <= MAX_TASK_TEXT_LENGTH &&
		(!nonempty || value.trim().length > 0) &&
		!value.includes("\0");
}

function validCleanText(value: unknown): value is string {
	return validText(value) && value === value.trim();
}

function validUniqueTextList(value: unknown, nonempty = false): value is string[] {
	return Array.isArray(value) &&
		(!nonempty || value.length > 0) &&
		value.every(validCleanText) &&
		new Set(value).size === value.length;
}

function validOrderedTextList(value: unknown, nonempty = false): value is string[] {
	return Array.isArray(value) &&
		(!nonempty || value.length > 0) &&
		value.every(validCleanText);
}

function validRepository(value: unknown): value is TaskRepository {
	const repository = record(value);
	return Boolean(
		repository &&
			exactKeys(repository, ["sourceRoot", "baseBranch", "sourceHead", "branch", "worktree"]) &&
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
	if (!run || !validText(run.kind) || !validText(run.path) || !isAbsolute(run.path)) return false;
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

function validQuestions(value: unknown): value is TaskQuestions {
	const questions = record(value);
	return Boolean(
		questions &&
			exactKeys(questions, [
				"sharedUnderstanding",
				"decisions",
				"acceptedAssumptions",
				"researchTargets",
			]) &&
			validCleanText(questions.sharedUnderstanding) &&
			validUniqueTextList(questions.decisions) &&
			validUniqueTextList(questions.acceptedAssumptions) &&
			validUniqueTextList(questions.researchTargets),
	);
}

function validSpecification(value: unknown): value is TaskSpecification {
	const specification = record(value);
	return Boolean(
		specification &&
			exactKeys(specification, [
				"summary",
				"requirements",
				"nonGoals",
				"constraints",
				"acceptanceCriteria",
				"decisions",
			]) &&
			validCleanText(specification.summary) &&
			validUniqueTextList(specification.requirements, true) &&
			validUniqueTextList(specification.nonGoals) &&
			validUniqueTextList(specification.constraints) &&
			validUniqueTextList(specification.acceptanceCriteria, true) &&
			validUniqueTextList(specification.decisions),
	);
}

function validFileScope(value: unknown): value is string {
	if (!validCleanText(value) || isAbsolute(value) || WINDOWS_ABSOLUTE.test(value)) return false;
	if (["\\", ":", "!", "^"].some((prefix) => value.startsWith(prefix))) return false;
	return !value.split(/[\\/]/u).includes("..");
}

function validPhase(value: unknown): value is TaskPhase {
	const phase = record(value);
	return Boolean(
		phase &&
			exactKeys(phase, ["id", "title", "goal", "fileScopes", "instructions", "verification"]) &&
			typeof phase.id === "string" &&
			PHASE_ID.test(phase.id) &&
			validCleanText(phase.title) &&
			validCleanText(phase.goal) &&
			Array.isArray(phase.fileScopes) &&
			phase.fileScopes.length > 0 &&
			phase.fileScopes.every(validFileScope) &&
			new Set(phase.fileScopes).size === phase.fileScopes.length &&
			validOrderedTextList(phase.instructions, true) &&
			validUniqueTextList(phase.verification, true),
	);
}

function validPlan(value: unknown): value is TaskPlan {
	const plan = record(value);
	if (!plan || !exactKeys(plan, ["phases"]) || !Array.isArray(plan.phases) || !plan.phases.length)
		return false;
	if (!plan.phases.every(validPhase)) return false;
	return new Set(plan.phases.map(({ id }) => id)).size === plan.phases.length;
}

function validVerificationEvidence(value: unknown): value is VerificationEvidence {
	const evidence = record(value);
	return Boolean(
		evidence &&
			exactKeys(evidence, ["command", "exitCode", "summary"]) &&
			validCleanText(evidence.command) &&
			Number.isInteger(evidence.exitCode) &&
			validCleanText(evidence.summary) &&
			(evidence.summary as string).length <= MAX_VERIFICATION_SUMMARY_LENGTH,
	);
}

function phaseFields(value: Record<string, unknown>): Record<string, unknown> {
	return {
		id: value.id,
		title: value.title,
		goal: value.goal,
		fileScopes: value.fileScopes,
		instructions: value.instructions,
		verification: value.verification,
	};
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePhase(left: TaskPhase, right: TaskPhase): boolean {
	return left.id === right.id &&
		left.title === right.title &&
		left.goal === right.goal &&
		sameList(left.fileScopes, right.fileScopes) &&
		sameList(left.instructions, right.instructions) &&
		sameList(left.verification, right.verification);
}

function validCheckpoint(value: unknown, phase: TaskPhase): value is CompletedTaskPhase {
	const checkpoint = record(value);
	if (
		!checkpoint ||
		!exactKeys(checkpoint, [
			"id",
			"title",
			"goal",
			"fileScopes",
			"instructions",
			"verification",
			"resolution",
			"verificationEvidence",
			"commit",
		])
	) return false;
	const copied = phaseFields(checkpoint);
	if (!validPhase(copied) || !samePhase(copied, phase)) return false;
	return validCleanText(checkpoint.resolution) &&
		Array.isArray(checkpoint.verificationEvidence) &&
		checkpoint.verificationEvidence.length === phase.verification.length &&
		checkpoint.verificationEvidence.every(
			(evidence, index) =>
				validVerificationEvidence(evidence) &&
				evidence.command === phase.verification[index] &&
				evidence.exitCode === 0,
		) &&
		typeof checkpoint.commit === "string" &&
		OBJECT_ID.test(checkpoint.commit);
}

function validCheckpoints(value: unknown, plan: TaskPlan | null): value is CompletedTaskPhase[] {
	if (!Array.isArray(value)) return false;
	if (!plan) return value.length === 0;
	if (value.length > plan.phases.length) return false;
	return value.every((checkpoint, index) => validCheckpoint(checkpoint, plan.phases[index]));
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
			"questions",
			"specification",
			"plan",
			"checkpoints",
		]) ||
		task.version !== TASK_VERSION ||
		typeof task.slug !== "string" ||
		!SLUG.test(task.slug) ||
		!validText(task.title) ||
		!validText(task.request) ||
		!validRepository(task.repository) ||
		!validSessions(task.sessions) ||
		!TASK_STAGES.includes(task.stage as TaskStage) ||
		(task.questions !== null && !validQuestions(task.questions)) ||
		(task.specification !== null && !validSpecification(task.specification)) ||
		(task.plan !== null && !validPlan(task.plan)) ||
		!validCheckpoints(task.checkpoints, task.plan as TaskPlan | null)
	) return false;

	const stage = task.stage as TaskStage;
	const questions = task.questions as TaskQuestions | null;
	const specification = task.specification as TaskSpecification | null;
	const plan = task.plan as TaskPlan | null;
	const checkpoints = task.checkpoints as CompletedTaskPhase[];
	switch (stage) {
		case "questions":
			return questions === null && specification === null && plan === null && checkpoints.length === 0;
		case "research":
		case "specification":
			return questions !== null && specification === null && plan === null && checkpoints.length === 0;
		case "plan":
			return questions !== null && specification !== null && plan === null && checkpoints.length === 0;
		case "implementation":
			return questions !== null && specification !== null && plan !== null && checkpoints.length < plan.phases.length;
		case "done":
			return questions !== null && specification !== null && plan !== null && checkpoints.length === plan.phases.length;
	}
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
		stage: "questions",
		sessions: [],
		questions: null,
		specification: null,
		plan: null,
		checkpoints: [],
	});
}

function findSession(sessions: readonly TaskSessionRun[], key: TaskSessionKey): TaskSessionRun | undefined {
	const logicalKey = sessionLogicalKey(key);
	return sessions.find((run) => sessionLogicalKey(run) === logicalKey);
}

export function findTaskSession(task: Pick<TaskDocument, "sessions">, key: TaskSessionKey): TaskSessionRun | undefined {
	return findSession(task.sessions, key);
}

export function findTaskSessionByPath(task: Pick<TaskDocument, "sessions">, path: string): TaskSessionRun | undefined {
	return task.sessions.find((run) => run.path === path);
}

export function appendTaskSession(task: TaskDocument, run: TaskSessionRun): TaskDocument {
	if (!validSessionRun(run)) throw new Error("invalid task session run");
	if (findTaskSessionByPath(task, run.path))
		throw new Error(`session path is already recorded: ${run.path}`);
	if (findSession(task.sessions, run))
		throw new Error(`session run is already recorded: ${sessionLogicalKey(run)}`);
	return checked({ ...task, sessions: [...task.sessions, structuredClone(run)] });
}

export function confirmTaskQuestions(task: TaskDocument, questions: TaskQuestions): TaskDocument {
	if (task.stage !== "questions") throw new Error("task is not asking questions");
	return checked({ ...task, stage: "research", questions: structuredClone(questions) });
}

export function completeTaskResearch(task: TaskDocument): TaskDocument {
	if (task.stage !== "research") throw new Error("task is not researching");
	return checked({ ...task, stage: "specification" });
}

export function confirmTaskSpecification(
	task: TaskDocument,
	specification: TaskSpecification,
): TaskDocument {
	if (task.stage !== "specification") throw new Error("task is not specifying");
	return checked({ ...task, stage: "plan", specification: structuredClone(specification) });
}

export function acceptTaskPlan(task: TaskDocument, plan: TaskPlan): TaskDocument {
	if (task.stage !== "plan") throw new Error("task is not planning");
	return checked({ ...task, stage: "implementation", plan: structuredClone(plan) });
}

export function currentTaskPhase(task: TaskDocument): TaskPhase | undefined {
	return task.plan?.phases[task.checkpoints.length];
}

export function completeTaskPhase(
	task: TaskDocument,
	resolution: string,
	verificationEvidence: VerificationEvidence[],
	commit: string,
): TaskDocument {
	if (task.stage !== "implementation") throw new Error("task is not implementing");
	const phase = currentTaskPhase(task);
	if (!phase) throw new Error("task has no active implementation phase");
	const checkpoint: CompletedTaskPhase = {
		...structuredClone(phase),
		resolution,
		verificationEvidence: structuredClone(verificationEvidence),
		commit,
	};
	const checkpoints = [...task.checkpoints, checkpoint];
	return checked({
		...task,
		stage: checkpoints.length === task.plan!.phases.length ? "done" : "implementation",
		checkpoints,
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
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
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
