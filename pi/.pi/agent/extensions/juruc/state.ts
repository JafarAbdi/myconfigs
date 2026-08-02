import {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import {
	safeRelativePath,
	samePendingPhase,
	type PendingPhase,
	type PlanCandidate,
	type WorktreeSnapshot,
	validPendingPhase,
	validPlanCandidate,
	validWorktreeSnapshot,
} from "./plan.ts";

export const STATE_VERSION = 7 as const;
export const PHASES = [
	"creating",
	"planning",
	"revising",
	"promoting",
	"starting",
	"building",
	"amending",
	"discarding",
	"staging",
	"committing",
	"accepting",
	"done",
	"deleting",
] as const;
export type ExecutionPhase = (typeof PHASES)[number];
export type PlanningReason = "initial" | "revision" | "blocked" | "extension";
export type PlanningStep = "research" | "grill";
export type ResearchProgress = "orientation" | "evidence" | "ready";

export interface SessionIdentity {
	readonly path: string;
	readonly id: string;
}

export interface TaskIdentity {
	version: typeof STATE_VERSION;
	slug: string;
	branch: string;
	worktree: string;
	sourceRoot: string;
	baseBranch: string;
	sourceHead: string;
	planningSession: SessionIdentity | null;
	buildSessions: SessionIdentity[];
}

export interface CreatingState extends TaskIdentity {
	phase: "creating";
}

export interface ResearchPlanningState extends TaskIdentity {
	phase: "planning";
	reason: PlanningReason;
	subject: string;
	step: "research";
	researchSession: SessionIdentity | null;
	researchProgress: ResearchProgress;
}

export interface GrillPlanningState extends TaskIdentity {
	phase: "planning";
	reason: PlanningReason;
	subject: string;
	step: "grill";
	researchSession: null;
}

export type PlanningState = ResearchPlanningState | GrillPlanningState;

export interface RevisingState extends TaskIdentity {
	phase: "revising";
	candidate: PlanCandidate;
	subject: string;
}

export interface PromotingState extends TaskIdentity {
	phase: "promoting";
	candidate: PlanCandidate;
}

export interface StartingState extends TaskIdentity {
	phase: "starting";
	phaseSnapshot: PendingPhase;
	phaseSession: SessionIdentity | null;
}

export type SuccessfulAuditReceipt =
	| {
			kind: "phase";
			snapshot: WorktreeSnapshot;
			summary: string;
	  }
	| {
			kind: "terminal";
			task: string;
			planRevision: number;
			sourceHead: string;
			currentHead: string;
			baseHead: string;
			phaseSnapshot: PendingPhase;
			phaseSession: SessionIdentity;
			stagedTree: string;
			snapshot: WorktreeSnapshot;
			summary: string;
	  };

export interface BuildingState extends TaskIdentity {
	phase: "building";
	phaseSnapshot: PendingPhase;
	phaseSession: SessionIdentity;
	audit: SuccessfulAuditReceipt | null;
}

export interface AmendingState extends TaskIdentity {
	phase: "amending";
	phaseSnapshot: PendingPhase;
	phaseSession: SessionIdentity;
	amendment: string;
}

export interface DiscardingState extends TaskIdentity {
	phase: "discarding";
	candidate: PlanCandidate;
	head: string;
	paths: string[];
}

interface CompletionTransaction extends TaskIdentity {
	terminalAudit: Extract<SuccessfulAuditReceipt, { kind: "terminal" }> | null;
	phaseSnapshot: PendingPhase;
	phaseSession: SessionIdentity;
	resolution: string;
	parent: string;
}

export interface StagingState extends CompletionTransaction {
	phase: "staging";
	paths: string[];
	tree: string;
}

export interface CommitMessageReceipt {
	responseEntryId: string;
	text: string;
}

export interface CommittingState extends CompletionTransaction {
	phase: "committing";
	paths: string[];
	tree: string;
	promptBaselineEntryId: string;
	commitMessage: CommitMessageReceipt | null;
}

export interface AcceptanceReceipt {
	readonly task: string;
	readonly phase: PendingPhase;
	readonly phaseSession: SessionIdentity;
	readonly sourceHead: string;
	readonly currentHead: string;
	readonly finalParent: string | null;
	readonly finalCommit: string;
	readonly finalTree: string;
	readonly auditedPlanRevision: number;
	readonly completedPlanRevision: number;
	readonly orderedPhaseCommits: string[];
	readonly auditSummary: string;
	readonly baseHead: string;
}

export interface AcceptingState extends TaskIdentity {
	phase: "accepting";
	phaseSnapshot: PendingPhase;
	phaseSession: SessionIdentity;
	terminalAudit: Extract<SuccessfulAuditReceipt, { kind: "terminal" }>;
	finalParent: string | null;
	finalTree: string;
	finalCommit: string;
	completedPlanRevision: number;
	orderedPhaseCommits: string[];
	acceptance: AcceptanceReceipt | null;
}

export interface DoneState extends TaskIdentity {
	phase: "done";
	acceptance: AcceptanceReceipt;
}

export type DeletionWorktreeSnapshot =
	| { kind: "absent" }
	| {
			kind: "present";
			head: string;
			paths: string[];
		};

export interface DeletingState extends TaskIdentity {
	phase: "deleting";
	worktreeSnapshot: DeletionWorktreeSnapshot;
}

export type ExecutionState =
	| CreatingState
	| PlanningState
	| RevisingState
	| PromotingState
	| StartingState
	| BuildingState
	| AmendingState
	| DiscardingState
	| StagingState
	| CommittingState
	| AcceptingState
	| DoneState
	| DeletingState;

const TRANSITIONS: Record<ExecutionPhase, readonly ExecutionPhase[]> = {
	creating: ["planning"],
	planning: ["planning", "revising", "promoting", "discarding"],
	revising: ["planning"],
	promoting: ["planning", "starting"],
	starting: ["starting", "building"],
	building: ["planning", "starting", "building", "amending", "staging", "accepting"],
	amending: ["building"],
	discarding: ["starting"],
	staging: ["planning", "committing", "starting"],
	committing: ["planning", "starting", "accepting"],
	accepting: ["accepting", "done"],
	done: ["planning"],
	deleting: [],
};

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IDENTITY_KEYS = [
	"version",
	"slug",
	"sourceRoot",
	"baseBranch",
	"sourceHead",
	"planningSession",
	"buildSessions",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const optional = new Set(["branch", "worktree"]);
	const actual = Object.keys(value).filter((key) => !optional.has(key));
	const expected = keys.filter((key) => !optional.has(key));
	return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function validSessionPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		isAbsolute(value) &&
		!/\p{Cc}/u.test(value) &&
		!/[\u2028\u2029]/u.test(value)
	);
}

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function validSessionIdentity(value: unknown): value is SessionIdentity {
	const identity = record(value);
	return Boolean(
		identity &&
			exactKeys(identity, ["path", "id"]) &&
			validSessionPath(identity.path) &&
			typeof identity.id === "string" &&
			SESSION_ID.test(identity.id),
	);
}

export function sameSessionIdentity(
	left: SessionIdentity | null,
	right: SessionIdentity | null,
): boolean {
	return left === null || right === null
		? left === right
		: left.path === right.path && left.id === right.id;
}

function validBuildSessions(value: unknown): value is SessionIdentity[] {
	return (
		Array.isArray(value) &&
		value.every(
			(session, index) =>
				validSessionIdentity(session) &&
				(index === 0 || value[index - 1].path < session.path),
		)
	);
}

function validPhaseSession(
	state: Record<string, unknown>,
	value: unknown,
): value is SessionIdentity {
	return (
		validSessionIdentity(value) &&
		Array.isArray(state.buildSessions) &&
		state.buildSessions.some((session) => sameSessionIdentity(session, value)) &&
		!sameSessionIdentity(state.planningSession as SessionIdentity | null, value)
	);
}

function validIdentity(state: Record<string, unknown>): boolean {
	const planningSession = state.planningSession;
	return (
		state.version === STATE_VERSION &&
		typeof state.slug === "string" &&
		SLUG.test(state.slug) &&
		(state.branch === undefined || state.branch === state.slug) &&
		(state.worktree === undefined || (typeof state.worktree === "string" && isAbsolute(state.worktree))) &&
		typeof state.sourceRoot === "string" &&
		isAbsolute(state.sourceRoot) &&
		state.worktree !== state.sourceRoot &&
		typeof state.baseBranch === "string" &&
		state.baseBranch.length > 0 &&
		!/\p{Cc}/u.test(state.baseBranch) &&
		typeof state.sourceHead === "string" &&
		OBJECT_ID.test(state.sourceHead) &&
		(planningSession === null || validSessionIdentity(planningSession)) &&
		validBuildSessions(state.buildSessions) &&
		(planningSession === null ||
			!state.buildSessions.some(
				(session) => session.path === planningSession.path,
			))
	);
}

function identityOf(identity: TaskIdentity): TaskIdentity {
	return {
		version: STATE_VERSION,
		slug: identity.slug,
		branch: identity.branch,
		worktree: identity.worktree,
		sourceRoot: identity.sourceRoot,
		baseBranch: identity.baseBranch,
		sourceHead: identity.sourceHead,
		planningSession: identity.planningSession
			? { ...identity.planningSession }
			: null,
		buildSessions: identity.buildSessions.map((session) => ({ ...session })),
	};
}

function sameIdentity(left: TaskIdentity, right: TaskIdentity): boolean {
	return (
		IDENTITY_KEYS.every(
			(key) =>
				key === "planningSession" ||
				key === "buildSessions" ||
				left[key] === right[key],
		) &&
		sameSessionIdentity(left.planningSession, right.planningSession) &&
		left.buildSessions.length === right.buildSessions.length &&
		left.buildSessions.every((session, index) =>
			sameSessionIdentity(session, right.buildSessions[index]),
		)
	);
}

function validPlanningSubject(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 16_384 &&
		value === value.trim() &&
		!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
	);
}

const AUDIT_SUMMARY_MAX_LENGTH = 500;

function validAuditSummary(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= AUDIT_SUMMARY_MAX_LENGTH &&
		value === value.trim() &&
		!/[\r\n\u2028\u2029]/u.test(value)
	);
}

function validReceiptText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 10_000 &&
		!value.includes("\0");
}

function validEntryId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 200 &&
		value === value.trim();
}

function validAuditReceipt(value: unknown, state: Record<string, unknown>): value is SuccessfulAuditReceipt {
	const receipt = record(value);
	if (!receipt || !validWorktreeSnapshot(receipt.snapshot) || !validAuditSummary(receipt.summary)) return false;
	if (receipt.kind === "phase") return exactKeys(receipt, ["kind", "snapshot", "summary"]);
	return receipt.kind === "terminal" && exactKeys(receipt, [
		"kind", "task", "planRevision", "sourceHead", "currentHead", "baseHead",
		"phaseSnapshot", "phaseSession", "stagedTree", "snapshot", "summary",
	]) && receipt.task === state.slug && Number.isSafeInteger(receipt.planRevision) && (receipt.planRevision as number) >= 0 &&
		typeof receipt.sourceHead === "string" && OBJECT_ID.test(receipt.sourceHead) && receipt.sourceHead === state.sourceHead &&
		typeof receipt.currentHead === "string" && OBJECT_ID.test(receipt.currentHead) &&
		typeof receipt.baseHead === "string" && OBJECT_ID.test(receipt.baseHead) &&
		validPendingPhase(receipt.phaseSnapshot) && samePendingPhase(receipt.phaseSnapshot, state.phaseSnapshot as PendingPhase) &&
		validSessionIdentity(receipt.phaseSession) && sameSessionIdentity(receipt.phaseSession, state.phaseSession as SessionIdentity) &&
		typeof receipt.stagedTree === "string" && OBJECT_ID.test(receipt.stagedTree) &&
		receipt.currentHead === receipt.snapshot.head && receipt.stagedTree === receipt.snapshot.tree;
}

function validResolution(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		!/[\r\n\u2028\u2029]/u.test(value) &&
		!/\p{Cc}/u.test(value)
	);
}

function validAmendment(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 10_000 &&
		value === value.trim() &&
		!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
	);
}

function validPaths(value: unknown, nonempty = true): value is string[] {
	return (
		Array.isArray(value) &&
		(!nonempty || value.length > 0) &&
		value.every(
			(path, index) =>
				typeof path === "string" &&
				safeRelativePath(path) &&
				(index === 0 || value[index - 1] < path),
		)
	);
}

function samePaths(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((path, index) => path === right[index])
	);
}

function validDeletionWorktreeSnapshot(
	value: unknown,
): value is DeletionWorktreeSnapshot {
	const snapshot = record(value);
	if (!snapshot || typeof snapshot.kind !== "string") return false;
	if (snapshot.kind === "absent") return exactKeys(snapshot, ["kind"]);
	return (
		snapshot.kind === "present" &&
		exactKeys(snapshot, ["kind", "head", "paths"]) &&
		typeof snapshot.head === "string" &&
		OBJECT_ID.test(snapshot.head) &&
		validPaths(snapshot.paths, false)
	);
}

function validObjectIds(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && OBJECT_ID.test(item));
}

function validTerminalAudit(value: unknown, state: Record<string, unknown>): value is Extract<SuccessfulAuditReceipt, { kind: "terminal" }> {
	const receipt = record(value);
	return Boolean(receipt && receipt.kind === "terminal" && validAuditReceipt(receipt, state));
}

function acceptanceMatchesState(receipt: AcceptanceReceipt, state: Record<string, unknown>): boolean {
	return receipt.task === state.slug && samePendingPhase(receipt.phase, state.phaseSnapshot as PendingPhase) && sameSessionIdentity(receipt.phaseSession, state.phaseSession as SessionIdentity) && receipt.sourceHead === state.sourceHead && receipt.currentHead === receipt.finalCommit && receipt.finalTree === state.finalTree &&
		receipt.finalParent === state.finalParent && receipt.finalCommit === state.finalCommit &&
		receipt.completedPlanRevision === state.completedPlanRevision &&
		JSON.stringify(receipt.orderedPhaseCommits) === JSON.stringify(state.orderedPhaseCommits);
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	const item = record(value);
	if (!item) return value;
	return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonicalValue(item[key])]));
}

function sameAcceptanceReceipt(left: AcceptanceReceipt, right: AcceptanceReceipt): boolean {
	return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function acceptanceMatchesDoneState(receipt: AcceptanceReceipt, state: Record<string, unknown>): boolean {
	return receipt.task === state.slug && receipt.sourceHead === state.sourceHead && receipt.currentHead === receipt.finalCommit &&
		receipt.finalCommit === receipt.currentHead && typeof receipt.auditSummary === "string" &&
		Array.isArray(state.buildSessions) && state.buildSessions.some((session) => sameSessionIdentity(session, receipt.phaseSession)) &&
		!sameSessionIdentity(state.planningSession as SessionIdentity | null, receipt.phaseSession);
}

function validAcceptanceReceipt(value: unknown, state: Record<string, unknown>): value is AcceptanceReceipt {
	const receipt = record(value);
	if (!receipt || !exactKeys(receipt, ["task", "phase", "phaseSession", "sourceHead", "currentHead", "finalParent", "finalCommit", "finalTree", "auditedPlanRevision", "completedPlanRevision", "orderedPhaseCommits", "auditSummary", "baseHead"])) return false;
	return receipt.task === state.slug && validPendingPhase(receipt.phase) && validSessionIdentity(receipt.phaseSession) &&
		typeof receipt.sourceHead === "string" && OBJECT_ID.test(receipt.sourceHead) &&
		typeof receipt.currentHead === "string" && OBJECT_ID.test(receipt.currentHead) &&
		(receipt.finalParent === null || (typeof receipt.finalParent === "string" && OBJECT_ID.test(receipt.finalParent))) &&
		typeof receipt.finalCommit === "string" && OBJECT_ID.test(receipt.finalCommit) &&
		typeof receipt.finalTree === "string" && OBJECT_ID.test(receipt.finalTree) &&
		typeof receipt.baseHead === "string" && OBJECT_ID.test(receipt.baseHead) && receipt.currentHead === receipt.finalCommit &&
		Number.isSafeInteger(receipt.auditedPlanRevision) && Number.isSafeInteger(receipt.completedPlanRevision) && receipt.completedPlanRevision === (receipt.auditedPlanRevision as number) + 1 &&
		validObjectIds(receipt.orderedPhaseCommits) && validAuditSummary(receipt.auditSummary);
}

export function parseExecutionState(value: unknown): ExecutionState | undefined {
	const state = record(value);
	if (
		!state ||
		!validIdentity(state) ||
		typeof state.phase !== "string" ||
		!PHASES.includes(state.phase as ExecutionPhase)
	)
		return undefined;

	const keys = [...IDENTITY_KEYS, "phase"];
	if (state.phase === "creating")
		return exactKeys(state, keys) ? (state as unknown as CreatingState) : undefined;

	if (state.phase === "done")
		return exactKeys(state, [...keys, "acceptance"]) && validAcceptanceReceipt(state.acceptance, state) && acceptanceMatchesDoneState(state.acceptance, state)
			? (state as unknown as DoneState) : undefined;

	if (state.phase === "accepting") {
		return exactKeys(state, [...keys, "phaseSnapshot", "phaseSession", "terminalAudit", "finalParent", "finalTree", "finalCommit", "completedPlanRevision", "orderedPhaseCommits", "acceptance"]) && validPendingPhase(state.phaseSnapshot) && validPhaseSession(state, state.phaseSession) && validTerminalAudit(state.terminalAudit, state) &&
			(state.finalParent === null || (typeof state.finalParent === "string" && OBJECT_ID.test(state.finalParent))) && typeof state.finalTree === "string" && OBJECT_ID.test(state.finalTree) &&
			typeof state.finalCommit === "string" && OBJECT_ID.test(state.finalCommit) && Number.isSafeInteger(state.completedPlanRevision) &&
			state.completedPlanRevision === (state.terminalAudit as Extract<SuccessfulAuditReceipt, { kind: "terminal" }>).planRevision + 1 && validObjectIds(state.orderedPhaseCommits) &&
			(state.acceptance === null || (validAcceptanceReceipt(state.acceptance, state) && acceptanceMatchesState(state.acceptance, state)))
			? (state as unknown as AcceptingState) : undefined;
	}

	if (state.phase === "deleting")
		return exactKeys(state, [...keys, "worktreeSnapshot"]) &&
			validDeletionWorktreeSnapshot(state.worktreeSnapshot)
			? (state as unknown as DeletingState)
			: undefined;

	if (state.phase === "planning") {
		const common =
			(state.reason === "initial" ||
				state.reason === "revision" ||
				state.reason === "blocked" ||
				state.reason === "extension") &&
			validPlanningSubject(state.subject);
		if (!common) return undefined;
		if (state.step === "grill")
			return exactKeys(state, [
				...keys,
				"reason",
				"subject",
				"step",
				"researchSession",
			]) && state.researchSession === null
				? (state as unknown as GrillPlanningState)
				: undefined;
		const researchSession = state.researchSession;
		return state.step === "research" &&
			exactKeys(state, [
				...keys,
				"reason",
				"subject",
				"step",
				"researchSession",
				"researchProgress",
			]) &&
			(state.researchProgress === "orientation" ||
				state.researchProgress === "evidence" ||
				state.researchProgress === "ready") &&
			(researchSession === null || validSessionIdentity(researchSession)) &&
			(researchSession === null ||
				(!sameSessionIdentity(state.planningSession as SessionIdentity | null, researchSession) &&
					!(state.buildSessions as SessionIdentity[]).some((session) =>
						sameSessionIdentity(session, researchSession)))) &&
			(researchSession !== null || state.researchProgress === "orientation")
			? (state as unknown as ResearchPlanningState)
			: undefined;
	}

	if (state.phase === "revising") {
		return exactKeys(state, [...keys, "candidate", "subject"]) &&
			validPlanCandidate(state.candidate) &&
			validPlanningSubject(state.subject)
			? (state as unknown as RevisingState)
			: undefined;
	}

	if (state.phase === "promoting") {
		return exactKeys(state, [...keys, "candidate"]) &&
			validPlanCandidate(state.candidate) &&
			state.candidate.activeWorkDisposition !== "discard"
			? (state as unknown as PromotingState)
			: undefined;
	}

	if (state.phase === "starting" || state.phase === "building") {
		const validSession =
			state.phaseSession === null
				? state.phase === "starting"
				: validPhaseSession(state, state.phaseSession);
		const phaseKeys = [...keys, "phaseSnapshot", "phaseSession"];
		return exactKeys(
				state,
				state.phase === "building" ? [...phaseKeys, "audit"] : phaseKeys,
			) &&
			validPendingPhase(state.phaseSnapshot) &&
			validSession &&
			(state.phase !== "building" ||
				state.audit === null ||
				validAuditReceipt(state.audit, state))
			? (state as unknown as StartingState | BuildingState)
			: undefined;
	}

	if (state.phase === "amending") {
		return exactKeys(state, [
			...keys,
			"phaseSnapshot",
			"phaseSession",
			"amendment",
		]) &&
			validPendingPhase(state.phaseSnapshot) &&
			validPhaseSession(state, state.phaseSession) &&
			validAmendment(state.amendment)
			? (state as unknown as AmendingState)
			: undefined;
	}

	if (state.phase === "discarding") {
		if (
			!exactKeys(state, [...keys, "candidate", "head", "paths"]) ||
			!validPlanCandidate(state.candidate) ||
			state.candidate.activeWorkDisposition !== "discard" ||
			typeof state.head !== "string" ||
			!OBJECT_ID.test(state.head) ||
			!validPaths(state.paths) ||
			state.head !== state.candidate.worktreeSnapshot.head ||
			!samePaths(state.paths, state.candidate.worktreeSnapshot.paths)
		)
			return undefined;
		return state as unknown as DiscardingState;
	}

	const transactionKeys = [
		...keys,
		"phaseSnapshot",
		"phaseSession",
		"resolution",
		"parent",
		"terminalAudit",
	];
	if (
		!validPendingPhase(state.phaseSnapshot) ||
		!validPhaseSession(state, state.phaseSession) ||
		!validResolution(state.resolution) ||
		(state.terminalAudit !== null && !validTerminalAudit(state.terminalAudit, state)) ||
		typeof state.parent !== "string" ||
		!OBJECT_ID.test(state.parent)
	)
		return undefined;

	if (state.phase === "staging") {
		return exactKeys(state, [...transactionKeys, "paths", "tree"]) &&
			validPaths(state.paths) &&
			typeof state.tree === "string" &&
			OBJECT_ID.test(state.tree)
			? (state as unknown as StagingState)
			: undefined;
	}

	if (state.phase === "committing") {
		const commitMessage = record(state.commitMessage);
		return exactKeys(state, [
			...transactionKeys,
			"paths",
			"tree",
			"promptBaselineEntryId",
			"commitMessage",
		]) &&
			validPaths(state.paths) &&
			typeof state.tree === "string" &&
			OBJECT_ID.test(state.tree) &&
			validEntryId(state.promptBaselineEntryId) &&
			(state.commitMessage === null || Boolean(
				commitMessage &&
				exactKeys(commitMessage, ["responseEntryId", "text"]) &&
				validEntryId(commitMessage.responseEntryId) &&
				validReceiptText(commitMessage.text),
			))
			? (state as unknown as CommittingState)
			: undefined;
	}

	return undefined;
}

export function validExecutionTransition(current: unknown, next: unknown): boolean {
	const from = parseExecutionState(current);
	const to = parseExecutionState(next);
	if (!from || !to || !sameIdentity(from, to)) return false;
	if (to.phase === "deleting") return from.phase !== "deleting";
	if (!TRANSITIONS[from.phase].includes(to.phase)) return false;
	if (from.phase === "revising" && to.phase === "planning")
		return (
			to.reason === "revision" &&
			to.step === "research" &&
			to.researchProgress === "orientation" &&
			to.researchSession === null &&
			to.subject === from.subject
		);
	if (from.phase === "planning" && to.phase === "planning") {
		if (from.reason !== to.reason || from.subject !== to.subject) return false;
		if (from.step === "research" && to.step === "grill")
			return from.researchProgress === "ready" && to.researchSession === null;
		if (from.step !== "research" || to.step !== "research") return false;
		if (!sameSessionIdentity(from.researchSession, to.researchSession)) return false;
		return (
			(from.researchProgress === "orientation" && to.researchProgress === "evidence") ||
			(from.researchProgress === "evidence" && to.researchProgress === "ready")
		);
	}
	if (
		(from.phase === "building" ||
			from.phase === "staging" ||
			from.phase === "committing") &&
		to.phase === "starting"
	)
		return (
			to.phaseSession === null &&
			!samePendingPhase(from.phaseSnapshot, to.phaseSnapshot)
		);
	const beginsAmendment = from.phase === "building" && to.phase === "amending";
	if (
		!beginsAmendment &&
		"phaseSnapshot" in from &&
		"phaseSnapshot" in to &&
		(!samePendingPhase(from.phaseSnapshot, to.phaseSnapshot) ||
			("phaseSession" in from && "phaseSession" in to &&
				from.phaseSession !== null && to.phaseSession !== null &&
				!sameSessionIdentity(from.phaseSession, to.phaseSession)))
	) return false;
	if (from.phase === "starting" && to.phase === "building")
		return (
			from.phaseSession !== null &&
			samePendingPhase(from.phaseSnapshot, to.phaseSnapshot) &&
			sameSessionIdentity(from.phaseSession, to.phaseSession) &&
			to.audit === null
		);
	if (from.phase === "building" && to.phase === "amending") {
		const expected = {
			...from.phaseSnapshot,
			amendments: [...from.phaseSnapshot.amendments, to.amendment],
		};
		return (
			samePendingPhase(expected, to.phaseSnapshot) &&
			sameSessionIdentity(from.phaseSession, to.phaseSession)
		);
	}
	if (from.phase === "amending" && to.phase === "building")
		return (
			samePendingPhase(from.phaseSnapshot, to.phaseSnapshot) &&
			sameSessionIdentity(from.phaseSession, to.phaseSession) &&
			to.audit === null
		);
	if (from.phase === "building" && to.phase === "building") return true;
	if (from.phase === "building" && to.phase === "staging")
		return samePendingPhase(from.phaseSnapshot, to.phaseSnapshot) &&
			sameSessionIdentity(from.phaseSession, to.phaseSession);
	if (from.phase === "building" && to.phase === "accepting")
		return from.audit?.kind === "terminal" && samePendingPhase(from.phaseSnapshot, to.phaseSnapshot) && sameSessionIdentity(from.phaseSession, to.phaseSession);
	if (from.phase === "accepting" && to.phase === "done")
		return from.acceptance !== null && to.acceptance !== null &&
			sameAcceptanceReceipt(from.acceptance, to.acceptance) && acceptanceMatchesDoneState(to.acceptance, { ...to });
	if (from.phase === "staging" && to.phase === "committing")
		return (
			samePendingPhase(from.phaseSnapshot, to.phaseSnapshot) &&
			sameSessionIdentity(from.phaseSession, to.phaseSession) &&
			from.resolution === to.resolution &&
			from.parent === to.parent &&
			samePaths(from.paths, to.paths) &&
			from.tree === to.tree
		);
	return true;
}

export function transitionExecutionState<N extends ExecutionState>(
	current: ExecutionState,
	next: N,
): N {
	if (!validExecutionTransition(current, next))
		throw new Error(`invalid execution transition: ${current.phase} -> ${next.phase}`);
	return next;
}

export function parseExecutionStateJson(json: string): ExecutionState {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new Error(
			`invalid state JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parsed = record(value);
	if (parsed && ("branch" in parsed || "worktree" in parsed))
		throw new Error("invalid execution state: does not match the exact version-7 schema (derived branch/worktree fields are not persisted)");
	const state = parseExecutionState(value);
	if (!state)
		throw new Error("invalid execution state: does not match the exact version-7 schema");
	return state;
}

export function semanticSerializeExecutionState(state: ExecutionState): string {
	if (!parseExecutionState(state)) throw new Error("invalid execution state: does not match the exact version-7 schema");
	const persisted = { ...state } as Record<string, unknown>;
	delete persisted.branch;
	delete persisted.worktree;
	return JSON.stringify(canonicalValue(persisted));
}

export function serializeExecutionState(state: ExecutionState): string {
	if (!parseExecutionState(state))
		throw new Error("invalid execution state: does not match the exact version-7 schema");
	const persisted = { ...state } as Record<string, unknown>;
	delete persisted.branch;
	delete persisted.worktree;
	return `${JSON.stringify(persisted, null, 2)}\n`;
}

export function loadExecutionState(path: string): ExecutionState {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("state store is not a regular file");
	return parseExecutionStateJson(readFileSync(path, "utf8"));
}

export function saveExecutionState(path: string, state: ExecutionState): void {
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, serializeExecutionState(state), {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

export function creatingState(identity: TaskIdentity): CreatingState {
	const state: CreatingState = { ...identityOf(identity), phase: "creating" };
	if (!parseExecutionState(state)) throw new Error("invalid task identity");
	return state;
}

export function researchPlanningState(
	identity: TaskIdentity,
	reason: PlanningReason,
	subject: string,
): ResearchPlanningState {
	const state: ResearchPlanningState = {
		...identityOf(identity),
		phase: "planning",
		reason,
		subject,
		step: "research",
		researchSession: null,
		researchProgress: "orientation",
	};
	if (!parseExecutionState(state)) throw new Error("invalid research planning state");
	return state;
}

export function attachResearchSession(
	state: ResearchPlanningState,
	researchSession: SessionIdentity,
): ResearchPlanningState {
	const attached: ResearchPlanningState = { ...state, researchSession };
	if (!parseExecutionState(attached)) throw new Error("invalid research session");
	return attached;
}

export function orientationSucceededState(
	state: ResearchPlanningState,
): ResearchPlanningState {
	if (state.researchProgress !== "orientation" || state.researchSession === null)
		throw new Error("orientation success requires active orientation research");
	const progressed: ResearchPlanningState = { ...state, researchProgress: "evidence" };
	if (!validExecutionTransition(state, progressed)) throw new Error("invalid orientation progress");
	return progressed;
}

export function evidenceSucceededState(
	state: ResearchPlanningState,
): ResearchPlanningState {
	if (state.researchProgress !== "evidence" || state.researchSession === null)
		throw new Error("evidence success requires active evidence research");
	const progressed: ResearchPlanningState = { ...state, researchProgress: "ready" };
	if (!validExecutionTransition(state, progressed)) throw new Error("invalid evidence progress");
	return progressed;
}

export function grillPlanningState(
	state: ResearchPlanningState,
): GrillPlanningState {
	if (state.researchProgress !== "ready")
		throw new Error("planning grill requires ready research");
	const grilling: GrillPlanningState = {
		...identityOf(state),
		phase: "planning",
		reason: state.reason,
		subject: state.subject,
		step: "grill",
		researchSession: null,
	};
	if (!validExecutionTransition(state, grilling)) throw new Error("invalid planning grill state");
	return grilling;
}

export function revisingState(
	identity: TaskIdentity,
	candidate: PlanCandidate,
	subject: string,
): RevisingState {
	const state: RevisingState = {
		...identityOf(identity),
		phase: "revising",
		candidate: structuredClone(candidate),
		subject,
	};
	if (!parseExecutionState(state)) throw new Error("invalid candidate revision state");
	return state;
}

export function promotingState(
	identity: TaskIdentity,
	candidate: PlanCandidate,
): PromotingState {
	const state: PromotingState = {
		...identityOf(identity),
		phase: "promoting",
		candidate,
	};
	if (!parseExecutionState(state))
		throw new Error("promoting requires a clean or carry candidate");
	return state;
}

export function startingState(
	identity: TaskIdentity,
	phase: PendingPhase,
	phaseSession: SessionIdentity | null = null,
): StartingState {
	const state: StartingState = {
		...identityOf(identity), phase: "starting", phaseSnapshot: phase, phaseSession,
	};
	if (!parseExecutionState(state)) throw new Error("invalid starting phase snapshot");
	return state;
}

export function buildingState(
	identity: TaskIdentity,
	phase: PendingPhase,
	phaseSession: SessionIdentity,
): BuildingState {
	const state: BuildingState = {
		...identityOf(identity),
		phase: "building",
		phaseSnapshot: phase,
		phaseSession,
		audit: null,
	};
	if (!parseExecutionState(state)) throw new Error("invalid building phase session");
	return state;
}

export function amendingState(
	state: BuildingState,
	phase: PendingPhase,
	amendment: string,
): AmendingState {
	const amending: AmendingState = {
		...identityOf(state),
		phase: "amending",
		phaseSnapshot: phase,
		phaseSession: state.phaseSession,
		amendment,
	};
	if (!parseExecutionState(amending)) throw new Error("invalid phase amendment");
	return amending;
}

export function buildingAuditState(
	state: BuildingState,
	audit: SuccessfulAuditReceipt | null,
): BuildingState {
	const updated: BuildingState = {
		...state,
		audit: audit === null
			? null
			: audit.kind === "phase"
				? {
					kind: "phase",
					snapshot: { head: audit.snapshot.head, paths: [...audit.snapshot.paths], tree: audit.snapshot.tree },
					summary: audit.summary,
				}
				: {
					...structuredClone(audit),
					snapshot: { head: audit.snapshot.head, paths: [...audit.snapshot.paths], tree: audit.snapshot.tree },
					phaseSnapshot: structuredClone(audit.phaseSnapshot),
					phaseSession: { ...audit.phaseSession },
				},
	};
	if (!parseExecutionState(updated))
		throw new Error("invalid successful audit receipt");
	return updated;
}

export function discardingState(
	identity: TaskIdentity,
	candidate: PlanCandidate,
): DiscardingState {
	const state: DiscardingState = {
		...identityOf(identity),
		phase: "discarding",
		candidate,
		head: candidate.worktreeSnapshot.head,
		paths: [...candidate.worktreeSnapshot.paths],
	};
	if (!parseExecutionState(state))
		throw new Error("discarding requires a dirty discard candidate");
	return state;
}

export function stagingState(
	identity: TaskIdentity,
	phase: PendingPhase,
	phaseSession: SessionIdentity,
	resolution: string,
	parent: string,
	paths: string[],
	tree: string,
): StagingState {
	const state: StagingState = {
		...identityOf(identity),
		phase: "staging",
		terminalAudit: null,
		phaseSnapshot: phase,
		phaseSession,
		resolution,
		parent,
		paths: [...paths],
		tree,
	};
	if (!parseExecutionState(state)) throw new Error("invalid staging transaction");
	return state;
}

export function committingState(
	state: StagingState,
	promptBaselineEntryId: string,
): CommittingState {
	const committing: CommittingState = {
		...identityOf(state),
		phase: "committing",
		terminalAudit: state.terminalAudit,
		phaseSnapshot: state.phaseSnapshot,
		phaseSession: state.phaseSession,
		resolution: state.resolution,
		parent: state.parent,
		paths: [...state.paths],
		tree: state.tree,
		promptBaselineEntryId,
		commitMessage: null,
	};
	if (!parseExecutionState(committing))
		throw new Error("invalid committing transaction");
	return committing;
}

export function committingBaselineState(
	state: CommittingState,
	promptBaselineEntryId: string,
): CommittingState {
	const updated: CommittingState = {
		...state,
		promptBaselineEntryId,
		commitMessage: null,
	};
	if (!parseExecutionState(updated)) throw new Error("invalid commit-message baseline");
	return updated;
}

export function committingMessageState(
	state: CommittingState,
	commitMessage: CommitMessageReceipt,
): CommittingState {
	const updated: CommittingState = {
		...state,
		commitMessage: { ...commitMessage },
	};
	if (!parseExecutionState(updated)) throw new Error("invalid commit-message receipt");
	return updated;
}

export function acceptingState(
	state: BuildingState | CommittingState,
	terminalAudit: Extract<SuccessfulAuditReceipt, { kind: "terminal" }>,
	finalParent: string | null,
	finalTree: string,
	finalCommit: string,
	completedPlanRevision: number,
	orderedPhaseCommits: string[],
	acceptance: AcceptanceReceipt | null = null,
): AcceptingState {
	const accepting: AcceptingState = { ...identityOf(state), phase: "accepting", phaseSnapshot: state.phaseSnapshot, phaseSession: state.phaseSession, terminalAudit, finalParent, finalTree, finalCommit, completedPlanRevision, orderedPhaseCommits: [...orderedPhaseCommits], acceptance };
	if (!parseExecutionState(accepting)) throw new Error("invalid accepting transaction");
	return accepting;
}

export function acceptingReceiptState(state: AcceptingState, acceptance: AcceptanceReceipt): AcceptingState {
	const updated = { ...state, acceptance };
	if (!parseExecutionState(updated)) throw new Error("invalid acceptance receipt");
	return updated;
}

export function doneState(state: AcceptingState | TaskIdentity): DoneState {
	if (!("acceptance" in state) || !state.acceptance) throw new Error("done requires an acceptance receipt");
	const done: DoneState = { ...identityOf(state), phase: "done", acceptance: state.acceptance };
	if (!parseExecutionState(done)) throw new Error("invalid done state");
	return done;
}

export function deletingState(
	identity: TaskIdentity,
	worktreeSnapshot: DeletionWorktreeSnapshot,
): DeletingState {
	const state: DeletingState = {
		...identityOf(identity),
		phase: "deleting",
		worktreeSnapshot,
	};
	if (!parseExecutionState(state)) throw new Error("invalid deletion transaction");
	return state;
}
