import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const TASK_VERSION = 5 as const;
export const TASK_STAGES = [
	"questions",
	"research",
	"specification",
	"plan",
	"implementation",
	"review",
	"done",
] as const;

export type TaskStage = (typeof TASK_STAGES)[number];
export type DiscoverySessionKind = "questions" | "research" | "specification" | "plan";
export type ReviewSide = "deletions" | "additions";
export type ReviewerKind = "deviation" | "correctness";
export type ReviewerSessionKind = "deviation-review" | "correctness-review";

export interface ReviewerAnnotation {
	filePath: string;
	side: ReviewSide;
	line: number;
	summary: string;
	rationale?: string;
}

export type ReviewerFailureKind = "malformed-output" | "session-error";

export type ReviewerOutcome =
	| { status: "completed"; annotations: ReviewerAnnotation[] }
	| { status: "failed"; failureKind: ReviewerFailureKind; message: string };

export interface HumanComment {
	id: string;
	filePath: string;
	side: ReviewSide;
	startLine: number;
	endLine: number;
	body: string;
	createdAt: string;
}

export interface HumanCommentInput {
	filePath: string;
	side: ReviewSide;
	startLine: number;
	endLine: number;
	body: string;
}

export type ReviewDecisionKind = "approve" | "send-feedback";

export interface ReviewDecision {
	kind: ReviewDecisionKind;
	decidedAt: string;
}

export interface TaskReviewerSlot {
	sessionPath: string;
	outcome: ReviewerOutcome | null;
}

export interface TaskReviewRound {
	number: number;
	baseCommit: string;
	headCommit: string;
	reviewers: Record<ReviewerKind, TaskReviewerSlot | null>;
	humanComments: HumanComment[];
	decision: ReviewDecision | null;
	correction: null;
}

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
	reviewRounds: TaskReviewRound[];
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
const MAX_REVIEW_FILE_PATH_LENGTH = 4_096;
const MAX_REVIEW_SUMMARY_LENGTH = 2_000;
const MAX_REVIEW_RATIONALE_LENGTH = 5_000;
const MAX_REVIEW_FAILURE_LENGTH = 500;
const MAX_COMMENT_BODY_LENGTH = 10_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function validBoundedCleanText(value: unknown, maximum: number): value is string {
	return validCleanText(value) && value.length <= maximum;
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" &&
		!Number.isNaN(Date.parse(value)) &&
		new Date(value).toISOString() === value;
}

function validReviewSide(value: unknown): value is ReviewSide {
	return value === "additions" || value === "deletions";
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

function samePlan(left: TaskPlan, right: TaskPlan): boolean {
	return left.phases.length === right.phases.length &&
		left.phases.every((phase, index) => samePhase(phase, right.phases[index]));
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

function validReviewerAnnotation(value: unknown): value is ReviewerAnnotation {
	const annotation = record(value);
	if (!annotation) return false;
	const keys = ["filePath", "side", "line", "summary"];
	if (annotation.rationale !== undefined) keys.push("rationale");
	return exactKeys(annotation, keys) &&
		validBoundedCleanText(annotation.filePath, MAX_REVIEW_FILE_PATH_LENGTH) &&
		validReviewSide(annotation.side) &&
		positiveInteger(annotation.line) &&
		validBoundedCleanText(annotation.summary, MAX_REVIEW_SUMMARY_LENGTH) &&
		(annotation.rationale === undefined ||
			validBoundedCleanText(annotation.rationale, MAX_REVIEW_RATIONALE_LENGTH));
}

function validReviewerOutcome(value: unknown): value is ReviewerOutcome {
	const outcome = record(value);
	if (!outcome) return false;
	if (outcome.status === "completed")
		return exactKeys(outcome, ["status", "annotations"]) &&
			Array.isArray(outcome.annotations) &&
			outcome.annotations.every(validReviewerAnnotation);
	return outcome.status === "failed" &&
		exactKeys(outcome, ["status", "failureKind", "message"]) &&
		(outcome.failureKind === "malformed-output" || outcome.failureKind === "session-error") &&
		validBoundedCleanText(outcome.message, MAX_REVIEW_FAILURE_LENGTH);
}

function validReviewerSlot(value: unknown): value is TaskReviewerSlot {
	const slot = record(value);
	return Boolean(
		slot &&
			exactKeys(slot, ["sessionPath", "outcome"]) &&
			validCleanText(slot.sessionPath) &&
			isAbsolute(slot.sessionPath as string) &&
			(slot.outcome === null || validReviewerOutcome(slot.outcome)),
	);
}

function validHumanComment(value: unknown): value is HumanComment {
	const comment = record(value);
	return Boolean(
		comment &&
			exactKeys(comment, [
				"id",
				"filePath",
				"side",
				"startLine",
				"endLine",
				"body",
				"createdAt",
			]) &&
			typeof comment.id === "string" &&
			UUID_V4.test(comment.id) &&
			validBoundedCleanText(comment.filePath, MAX_REVIEW_FILE_PATH_LENGTH) &&
			validReviewSide(comment.side) &&
			positiveInteger(comment.startLine) &&
			positiveInteger(comment.endLine) &&
			(comment.endLine as number) >= (comment.startLine as number) &&
			validBoundedCleanText(comment.body, MAX_COMMENT_BODY_LENGTH) &&
			validTimestamp(comment.createdAt),
	);
}

function validReviewDecision(value: unknown): value is ReviewDecision {
	const decision = record(value);
	return Boolean(
		decision &&
			exactKeys(decision, ["kind", "decidedAt"]) &&
			(decision.kind === "approve" || decision.kind === "send-feedback") &&
			validTimestamp(decision.decidedAt),
	);
}

function validReviewRound(value: unknown, index: number): value is TaskReviewRound {
	const round = record(value);
	if (
		!round ||
		!exactKeys(round, [
			"number",
			"baseCommit",
			"headCommit",
			"reviewers",
			"humanComments",
			"decision",
			"correction",
		]) ||
		round.number !== index + 1 ||
		typeof round.baseCommit !== "string" ||
		!OBJECT_ID.test(round.baseCommit) ||
		typeof round.headCommit !== "string" ||
		!OBJECT_ID.test(round.headCommit) ||
		round.correction !== null
	) return false;
	const reviewers = record(round.reviewers);
	if (
		!reviewers ||
		!exactKeys(reviewers, ["deviation", "correctness"]) ||
		(reviewers.deviation !== null && !validReviewerSlot(reviewers.deviation)) ||
		(reviewers.correctness !== null && !validReviewerSlot(reviewers.correctness)) ||
		!Array.isArray(round.humanComments) ||
		!round.humanComments.every(validHumanComment)
	) return false;
	const deviation = reviewers.deviation as TaskReviewerSlot | null;
	const correctness = reviewers.correctness as TaskReviewerSlot | null;
	if (correctness !== null && (deviation === null || deviation.outcome === null)) return false;
	const comments = round.humanComments as HumanComment[];
	if (new Set(comments.map(({ id }) => id)).size !== comments.length) return false;
	if (round.decision === null) return true;
	if (!validReviewDecision(round.decision)) return false;
	const terminal = [reviewers.deviation, reviewers.correctness].every(
		(slot) => slot !== null && record(slot)?.outcome !== null,
	);
	if (!terminal) return false;
	return round.decision.kind === "approve" ? comments.length === 0 : comments.length > 0;
}

function validReviewRounds(
	value: unknown,
	repository: TaskRepository,
	checkpoints: readonly CompletedTaskPhase[],
): value is TaskReviewRound[] {
	if (!Array.isArray(value) || value.length > 1) return false;
	if (!value.every(validReviewRound)) return false;
	if (value.length === 0) return true;
	const round = value[0] as TaskReviewRound;
	return round.baseCommit === repository.sourceHead &&
		round.headCommit === checkpoints.at(-1)?.commit;
}

function validSessionRelationships(
	sessions: readonly TaskSessionRun[],
	stage: TaskStage,
	questions: TaskQuestions | null,
	specification: TaskSpecification | null,
	plan: TaskPlan | null,
	checkpoints: readonly CompletedTaskPhase[],
	rounds: readonly TaskReviewRound[],
): boolean {
	for (const run of sessions) {
		switch (run.kind) {
			case "questions":
				break;
			case "research":
				if (!questions) return false;
				break;
			case "specification":
				if (!questions || stage === "research") return false;
				break;
			case "plan":
				if (!specification) return false;
				break;
			case "implementation": {
				if (!plan || run.phase > plan.phases.length) return false;
				const available = stage === "implementation"
					? checkpoints.length + 1
					: checkpoints.length;
				if (run.phase > available) return false;
				break;
			}
			case "deviation-review":
			case "correctness-review": {
				const round = rounds[run.round - 1];
				const kind = run.kind === "deviation-review" ? "deviation" : "correctness";
				if (round?.reviewers[kind]?.sessionPath !== run.path) return false;
				break;
			}
			case "correction":
				return false;
		}
	}
	for (const round of rounds)
		for (const kind of ["deviation", "correctness"] as const) {
			const slot = round.reviewers[kind];
			if (!slot) continue;
			const sessionKind = kind === "deviation" ? "deviation-review" : "correctness-review";
			if (!sessions.some(
				(run) => run.kind === sessionKind && run.round === round.number && run.path === slot.sessionPath,
			)) return false;
		}
	return true;
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
			"reviewRounds",
		]) ||
		task.version !== TASK_VERSION ||
		typeof task.slug !== "string" ||
		!SLUG.test(task.slug) ||
		!validText(task.title) ||
		!validText(task.request) ||
		!validRepository(task.repository) ||
		task.repository.branch !== task.slug ||
		!validSessions(task.sessions) ||
		!TASK_STAGES.includes(task.stage as TaskStage) ||
		(task.questions !== null && !validQuestions(task.questions)) ||
		(task.specification !== null && !validSpecification(task.specification)) ||
		(task.plan !== null && !validPlan(task.plan)) ||
		!validCheckpoints(task.checkpoints, task.plan as TaskPlan | null) ||
		!validReviewRounds(
			task.reviewRounds,
			task.repository as TaskRepository,
			task.checkpoints as CompletedTaskPhase[],
		)
	) return false;

	const stage = task.stage as TaskStage;
	const questions = task.questions as TaskQuestions | null;
	const specification = task.specification as TaskSpecification | null;
	const plan = task.plan as TaskPlan | null;
	const checkpoints = task.checkpoints as CompletedTaskPhase[];
	const reviewRounds = task.reviewRounds as TaskReviewRound[];
	if (!validSessionRelationships(
		task.sessions as TaskSessionRun[],
		stage,
		questions,
		specification,
		plan,
		checkpoints,
		reviewRounds,
	)) return false;
	switch (stage) {
		case "questions":
			return questions === null && specification === null && plan === null &&
				checkpoints.length === 0 && reviewRounds.length === 0;
		case "research":
		case "specification":
			return questions !== null && specification === null && plan === null &&
				checkpoints.length === 0 && reviewRounds.length === 0;
		case "plan":
			return questions !== null && specification !== null && checkpoints.length === 0 &&
				reviewRounds.length === 0;
		case "implementation":
			return questions !== null && specification !== null && plan !== null &&
				checkpoints.length < plan.phases.length && reviewRounds.length === 0;
		case "review":
			return questions !== null && specification !== null && plan !== null &&
				checkpoints.length === plan.phases.length && reviewRounds.length === 1;
		case "done":
			return questions !== null && specification !== null && plan !== null &&
				checkpoints.length === plan.phases.length && reviewRounds.length === 1 &&
				reviewRounds[0].decision?.kind === "approve";
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
		reviewRounds: [],
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
	if (task.plan) {
		if (!validPlan(plan) || !samePlan(task.plan, plan))
			throw new Error("accepted task plan is immutable");
		return checked(task);
	}
	return checked({ ...task, plan: structuredClone(plan) });
}

export function activateTaskPlan(task: TaskDocument): TaskDocument {
	if (task.stage !== "plan" || !task.plan || task.checkpoints.length)
		throw new Error("task plan is not accepted and pending activation");
	return checked({ ...task, stage: "implementation" });
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
	const final = checkpoints.length === task.plan!.phases.length;
	return checked({
		...task,
		stage: final ? "review" : "implementation",
		checkpoints,
		reviewRounds: final
			? [{
				number: 1,
				baseCommit: task.repository.sourceHead,
				headCommit: commit,
				reviewers: { deviation: null, correctness: null },
				humanComments: [],
				decision: null,
				correction: null,
			}]
			: [],
	});
}

export function currentTaskReviewRound(task: TaskDocument): TaskReviewRound | undefined {
	return task.reviewRounds.at(-1);
}

function requireOpenReviewRound(task: TaskDocument): TaskReviewRound {
	const round = currentTaskReviewRound(task);
	if (task.stage !== "review" || !round)
		throw new Error("task has no current review round");
	if (round.decision) throw new Error("task review round already has a completed decision");
	return round;
}

function replaceCurrentReviewRound(task: TaskDocument, round: TaskReviewRound): TaskDocument {
	return checked({
		...task,
		reviewRounds: [...task.reviewRounds.slice(0, -1), round],
	});
}

export function registerTaskReviewerStart(
	task: TaskDocument,
	kind: ReviewerKind,
	sessionPath: string,
): TaskDocument {
	const round = requireOpenReviewRound(task);
	if (kind !== "deviation" && kind !== "correctness")
		throw new Error("invalid reviewer kind");
	if (!validCleanText(sessionPath) || !isAbsolute(sessionPath))
		throw new Error("reviewer session path must be absolute");
	if (round.reviewers[kind] !== null)
		throw new Error(`${kind} reviewer has already started`);
	if (kind === "correctness" && !round.reviewers.deviation?.outcome)
		throw new Error("correctness reviewer requires a terminal deviation outcome");
	if (findTaskSessionByPath(task, sessionPath))
		throw new Error(`session path is already recorded: ${sessionPath}`);
	const sessionKind = kind === "deviation" ? "deviation-review" : "correctness-review";
	if (findSession(task.sessions, { kind: sessionKind, round: round.number }))
		throw new Error(`${kind} reviewer session is already recorded`);
	return checked({
		...task,
		sessions: [...task.sessions, { kind: sessionKind, round: round.number, path: sessionPath }],
		reviewRounds: [
			...task.reviewRounds.slice(0, -1),
			{
				...round,
				reviewers: {
					...round.reviewers,
					[kind]: { sessionPath, outcome: null },
				},
			},
		],
	});
}

export function completeTaskReviewer(
	task: TaskDocument,
	kind: ReviewerKind,
	outcome: ReviewerOutcome,
): TaskDocument {
	const round = requireOpenReviewRound(task);
	const slot = round.reviewers[kind];
	if (!slot) throw new Error(`${kind} reviewer has not started`);
	if (slot.outcome) throw new Error(`${kind} reviewer outcome is already complete`);
	if (!validReviewerOutcome(outcome)) throw new Error("invalid reviewer outcome");
	return replaceCurrentReviewRound(task, {
		...round,
		reviewers: {
			...round.reviewers,
			[kind]: { ...slot, outcome: structuredClone(outcome) },
		},
	});
}

export function addTaskReviewComment(
	task: TaskDocument,
	input: HumanCommentInput,
	id = randomUUID(),
	createdAt = new Date().toISOString(),
): TaskDocument {
	const round = requireOpenReviewRound(task);
	const comment: HumanComment = { id, ...structuredClone(input), body: input.body.trim(), createdAt };
	if (!validHumanComment(comment)) throw new Error("invalid review comment");
	if (round.humanComments.some((existing) => existing.id === id))
		throw new Error(`review comment ID is already recorded: ${id}`);
	return replaceCurrentReviewRound(task, {
		...round,
		humanComments: [...round.humanComments, comment],
	});
}

export function updateTaskReviewComment(
	task: TaskDocument,
	id: string,
	body: string,
): TaskDocument {
	const round = requireOpenReviewRound(task);
	const existing = round.humanComments.find((comment) => comment.id === id);
	if (!existing) throw new Error("review comment not found");
	const updated = { ...existing, body: typeof body === "string" ? body.trim() : body };
	if (!validHumanComment(updated)) throw new Error("invalid review comment body");
	return replaceCurrentReviewRound(task, {
		...round,
		humanComments: round.humanComments.map((comment) => comment.id === id ? updated : comment),
	});
}

export function deleteTaskReviewComment(task: TaskDocument, id: string): TaskDocument {
	const round = requireOpenReviewRound(task);
	const humanComments = round.humanComments.filter((comment) => comment.id !== id);
	if (humanComments.length === round.humanComments.length)
		throw new Error("review comment not found");
	return replaceCurrentReviewRound(task, { ...round, humanComments });
}

export function decideTaskReview(
	task: TaskDocument,
	kind: ReviewDecisionKind,
	decidedAt = new Date().toISOString(),
): TaskDocument {
	const round = requireOpenReviewRound(task);
	if (kind !== "approve" && kind !== "send-feedback")
		throw new Error("invalid review decision");
	if (!Object.values(round.reviewers).every((slot) => slot?.outcome))
		throw new Error("both reviewers must have terminal outcomes before a decision");
	if (kind === "approve" && round.humanComments.length)
		throw new Error("Approve requires zero saved human comments");
	if (kind === "send-feedback" && !round.humanComments.length)
		throw new Error("Send Feedback requires at least one saved human comment");
	const decision = { kind, decidedAt };
	if (!validReviewDecision(decision)) throw new Error("invalid review decision timestamp");
	return replaceCurrentReviewRound(task, { ...round, decision });
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
	const directory = dirname(path);
	const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const file = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(file, serializeTaskDocument(task), "utf8");
			fchmodSync(file, 0o600);
			fsyncSync(file);
		} finally {
			closeSync(file);
		}
		renameSync(temporary, path);
		const parent = openSync(directory, "r");
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}
