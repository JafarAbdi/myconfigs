import {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { posix } from "node:path";

export const PLAN_VERSION = 4 as const;

const MAX_AMENDMENT_LENGTH = 10_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PHASE_ID = /^P([1-9][0-9]*)$/;
const PLAN_CONTENT_KEYS = [
	"objective",
	"desiredEndState",
	"constraints",
	"assumptions",
	"nonGoals",
	"decisions",
	"risks",
	"successCriteria",
] as const;

export interface WorktreeSnapshot {
	head: string;
	paths: string[];
	tree: string;
}

export interface PhaseContent {
	title: string;
	objective: string;
	successCriteria: string[];
	hints: string[];
}

export interface PendingPhase extends PhaseContent {
	id: string;
	status: "pending";
	amendments: string[];
	resolution: null;
	commit: null;
}

export interface CompletedPhase extends PhaseContent {
	id: string;
	status: "completed";
	amendments: string[];
	resolution: string;
	commit: string | null;
}

export interface PlanDecision {
	decision: string;
	rationale: string;
	alternatives: string[];
}

export interface PlanRisk {
	risk: string;
	consequence: string;
	mitigation: string;
}

export interface PlanContent {
	objective: string;
	desiredEndState: string;
	constraints: string[];
	assumptions: string[];
	nonGoals: string[];
	decisions: PlanDecision[];
	risks: PlanRisk[];
	successCriteria: string[];
}

export interface ApprovedPlan extends PlanContent {
	completed: CompletedPhase[];
	future: PendingPhase[];
}

export interface CandidatePhase extends PhaseContent {
	id?: string;
	amendments: string[];
}

export interface PlanCandidate extends PlanContent {
	expectedRevision: number;
	future: CandidatePhase[];
	worktreeSnapshot: WorktreeSnapshot;
	activeWorkDisposition: "carry" | "discard" | null;
}

export interface ConfirmedPlanSnapshot {
	revision: number;
	content: PlanContent;
	future: PhaseContent[];
}

export interface PlanEnvelope {
	version: typeof PLAN_VERSION;
	revision: number;
	nextPhaseId: number;
	title: string;
	request: string;
	approved: ApprovedPlan | null;
	candidate: PlanCandidate | null;
	history: ConfirmedPlanSnapshot[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && actual.every((key) => keys.includes(key))
	);
}

function validInteger(value: unknown, minimum: number): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validText(value: unknown, singleLine = false): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		(!singleLine || !/[\r\n\u2028\u2029]/u.test(value)) &&
		!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
	);
}

function validTextList(value: unknown, nonempty = false): value is string[] {
	return (
		Array.isArray(value) &&
		(!nonempty || value.length > 0) &&
		value.every((item) => validText(item))
	);
}

export function semanticSerialize(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	const item = record(value);
	if (!item) return value;
	return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stableValue(item[key])]));
}

function validUniqueRecords(value: unknown, valid: (value: unknown) => boolean): boolean {
	return Array.isArray(value) && value.every(valid) && new Set(value.map((item) => JSON.stringify(stableValue(item)))).size === value.length;
}

function validDecision(value: unknown): value is PlanDecision {
	const item = record(value);
	return Boolean(item && exactKeys(item, ["decision", "rationale", "alternatives"]) && validText(item.decision) && validText(item.rationale) && validTextList(item.alternatives));
}

function validRisk(value: unknown): value is PlanRisk {
	const item = record(value);
	return Boolean(item && exactKeys(item, ["risk", "consequence", "mitigation"]) && validText(item.risk) && validText(item.consequence) && validText(item.mitigation));
}

function validAmendments(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) => validText(item) && item.length <= MAX_AMENDMENT_LENGTH,
		)
	);
}

export function safeRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!posix.isAbsolute(path) &&
		!path.includes("\0") &&
		path !== "." &&
		path !== ".." &&
		!path.startsWith("../") &&
		posix.normalize(path) === path
	);
}

function validPaths(value: unknown, nonempty = false): value is string[] {
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

export function validWorktreeSnapshot(
	value: unknown,
): value is WorktreeSnapshot {
	const snapshot = record(value);
	return Boolean(
		snapshot &&
			exactKeys(snapshot, ["head", "paths", "tree"]) &&
			typeof snapshot.head === "string" &&
			OBJECT_ID.test(snapshot.head) &&
			validPaths(snapshot.paths) &&
			typeof snapshot.tree === "string" &&
			OBJECT_ID.test(snapshot.tree),
	);
}

function phaseNumber(id: string): number | undefined {
	const match = PHASE_ID.exec(id);
	if (!match) return undefined;
	const number = Number(match[1]);
	return Number.isSafeInteger(number) ? number : undefined;
}

function validPhaseContent(value: Record<string, unknown>): boolean {
	return (
		validText(value.title, true) &&
		validText(value.objective) &&
		validTextList(value.successCriteria, true) &&
		validTextList(value.hints)
	);
}

export function validPendingPhase(value: unknown): value is PendingPhase {
	const phase = record(value);
	return Boolean(
		phase &&
			exactKeys(phase, [
				"id",
				"status",
				"title",
				"objective",
				"successCriteria",
				"hints",
				"amendments",
				"resolution",
				"commit",
			]) &&
			typeof phase.id === "string" &&
			phaseNumber(phase.id) !== undefined &&
			phase.status === "pending" &&
			validPhaseContent(phase) &&
			validAmendments(phase.amendments) &&
			phase.resolution === null &&
			phase.commit === null,
	);
}

function validCompletedPhase(value: unknown): value is CompletedPhase {
	const phase = record(value);
	return Boolean(
		phase &&
			exactKeys(phase, [
				"id",
				"status",
				"title",
				"objective",
				"successCriteria",
				"hints",
				"amendments",
				"resolution",
				"commit",
			]) &&
			typeof phase.id === "string" &&
			phaseNumber(phase.id) !== undefined &&
			phase.status === "completed" &&
			validPhaseContent(phase) &&
			validAmendments(phase.amendments) &&
			validText(phase.resolution, true) &&
			(phase.commit === null ||
				(typeof phase.commit === "string" && OBJECT_ID.test(phase.commit))),
	);
}

function validPlanContent(value: Record<string, unknown>, exact = false): boolean {
	return (
		(!exact || exactKeys(value, PLAN_CONTENT_KEYS)) &&
		validText(value.objective) &&
		validText(value.desiredEndState) &&
		validTextList(value.constraints) &&
		validTextList(value.assumptions) &&
		validTextList(value.nonGoals) &&
		validUniqueRecords(value.decisions, validDecision) &&
		validUniqueRecords(value.risks, validRisk) &&
		validTextList(value.successCriteria, true)
	);
}

function validApproved(value: unknown): value is ApprovedPlan {
	const approved = record(value);
	if (
		!approved ||
		!exactKeys(approved, [
			"objective",
			"desiredEndState",
			"constraints",
			"assumptions",
			"nonGoals",
			"decisions",
			"risks",
			"successCriteria",
			"completed",
			"future",
		]) ||
		!validPlanContent(approved) ||
		!Array.isArray(approved.completed) ||
		!approved.completed.every(validCompletedPhase) ||
		!Array.isArray(approved.future) ||
		!approved.future.every(validPendingPhase)
	)
		return false;

	const ids = [...approved.completed, ...approved.future].map(
		(phase) => phase.id,
	);
	return new Set(ids).size === ids.length;
}

function validSnapshot(value: unknown): value is ConfirmedPlanSnapshot {
	const snapshot = record(value);
	if (!snapshot || !exactKeys(snapshot, ["revision", "content", "future"]) || !validInteger(snapshot.revision, 1)) return false;
	const content = record(snapshot.content);
	if (!content || !exactKeys(content, PLAN_CONTENT_KEYS) || !validPlanContent(content) || !Array.isArray(snapshot.future)) return false;
	return snapshot.future.every((phase) => {
		const item = record(phase);
		return Boolean(item && exactKeys(item, ["title", "objective", "successCriteria", "hints"]) && validPhaseContent(item));
	});
}

function validHistory(value: unknown): value is ConfirmedPlanSnapshot[] {
	return Array.isArray(value) && value.every(validSnapshot) && value.every((item, index, entries) => index === 0 || entries[index - 1].revision < item.revision);
}

function validCandidatePhase(value: unknown): value is CandidatePhase {
	const phase = record(value);
	if (!phase) return false;
	const keys = ["title", "objective", "successCriteria", "hints", "amendments"];
	if (Object.hasOwn(phase, "id")) keys.unshift("id");
	return (
		exactKeys(phase, keys) &&
		(!Object.hasOwn(phase, "id") ||
			(typeof phase.id === "string" && phaseNumber(phase.id) !== undefined)) &&
		validPhaseContent(phase) &&
		validAmendments(phase.amendments) &&
		(Object.hasOwn(phase, "id") || phase.amendments.length === 0)
	);
}

export function validPlanCandidate(value: unknown): value is PlanCandidate {
	const candidate = record(value);
	if (
		!candidate ||
		!exactKeys(candidate, [
			"expectedRevision",
			"objective",
			"desiredEndState",
			"constraints",
			"assumptions",
			"nonGoals",
			"decisions",
			"risks",
			"successCriteria",
			"future",
			"worktreeSnapshot",
			"activeWorkDisposition",
		]) ||
		!validInteger(candidate.expectedRevision, 0) ||
		!validPlanContent(candidate) ||
		!Array.isArray(candidate.future) ||
		candidate.future.length === 0 ||
		!candidate.future.every(validCandidatePhase) ||
		!validWorktreeSnapshot(candidate.worktreeSnapshot)
	)
		return false;

	const ids = candidate.future.flatMap((phase) =>
		phase.id === undefined ? [] : [phase.id],
	);
	if (new Set(ids).size !== ids.length) return false;
	const dirty = candidate.worktreeSnapshot.paths.length > 0;
	return dirty
		? candidate.activeWorkDisposition === "carry" ||
				candidate.activeWorkDisposition === "discard"
		: candidate.activeWorkDisposition === null;
}

export function validatePlanEnvelope(value: unknown): string[] {
	const store = record(value);
	if (
		!store ||
		!exactKeys(store, [
			"version",
			"revision",
			"nextPhaseId",
			"title",
			"request",
			"approved",
			"candidate",
			"history",
		]) ||
		store.version !== PLAN_VERSION ||
		!validInteger(store.revision, 0) ||
		!validInteger(store.nextPhaseId, 1) ||
		!validText(store.title, true) ||
		!validText(store.request) ||
		!validHistory(store.history) ||
		(store.approved !== null && !validApproved(store.approved)) ||
		(store.candidate !== null && !validPlanCandidate(store.candidate))
	)
		return ["does not match the exact version-4 plan envelope schema"];

	const envelope = store as unknown as PlanEnvelope;
	const phases = envelope.approved
		? [...envelope.approved.completed, ...envelope.approved.future]
		: [];
	const greatest = phases.reduce(
		(maximum, phase) => Math.max(maximum, phaseNumber(phase.id) ?? 0),
		0,
	);
	const errors: string[] = [];
	if (envelope.nextPhaseId <= greatest)
		errors.push("nextPhaseId must be greater than every assigned phase ID");
	if (envelope.history.some((snapshot) => snapshot.revision > envelope.revision))
		errors.push("history revisions must not exceed the envelope revision");
	if (envelope.approved === null && envelope.history.length > 0)
		errors.push("history requires an approved plan");
	if (envelope.approved !== null && envelope.history.length === 0)
		errors.push("an approved plan requires confirmed history");
	if (
		envelope.revision === Number.MAX_SAFE_INTEGER &&
		(envelope.approved === null || envelope.approved.future.length > 0 || envelope.candidate !== null)
	) errors.push("the maximum plan revision is reserved for a completed terminal plan");

	if (envelope.candidate) {
		if (envelope.candidate.expectedRevision !== envelope.revision)
			errors.push("candidate expectedRevision must equal the approved revision");
		const requiredRevisions = 1 + envelope.candidate.future.length;
		if (requiredRevisions > Number.MAX_SAFE_INTEGER - envelope.revision)
			errors.push("candidate and its future completions exceed the plan revision bound");
		const additions = envelope.candidate.future.filter((phase) => !phase.id).length;
		if (additions > Number.MAX_SAFE_INTEGER - envelope.nextPhaseId)
			errors.push("candidate cannot be promoted within the phase ID bound");
		errors.push(...candidateInvariantErrors(envelope, envelope.candidate));
	}
	return errors;
}

function candidateInvariantErrors(
	envelope: PlanEnvelope,
	candidate: PlanCandidate,
): string[] {
	const completedIds = new Set(envelope.approved?.completed.map((phase) => phase.id) ?? []);
	const pendingById = new Map(envelope.approved?.future.map((phase) => [phase.id, phase]) ?? []);
	return candidate.future.flatMap((phase) => {
		if (!phase.id) return [];
		if (completedIds.has(phase.id)) return [`${phase.id} is completed and immutable`];
		const approved = pendingById.get(phase.id);
		if (!approved) return [`${phase.id} is not an approved pending phase`];
		return sameCandidatePendingPhase(phase, approved)
			? []
			: [`${phase.id} does not exactly match the approved pending phase`];
	});
}

function assertValidPlan(envelope: PlanEnvelope): void {
	const errors = validatePlanEnvelope(envelope);
	if (errors.length) throw new Error(`invalid plan envelope: ${errors.join("; ")}`);
}

export function createPlanEnvelope(
	title: string,
	request: string,
): PlanEnvelope {
	const envelope: PlanEnvelope = {
		version: PLAN_VERSION,
		revision: 0,
		nextPhaseId: 1,
		title,
		request,
		approved: null,
		candidate: null,
		history: [],
	};
	assertValidPlan(envelope);
	return envelope;
}

export function parsePlanEnvelope(json: string): PlanEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new Error(
			`invalid plan JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const errors = validatePlanEnvelope(value);
	if (errors.length) throw new Error(`invalid plan envelope: ${errors.join("; ")}`);
	return value as PlanEnvelope;
}

export function serializePlanEnvelope(envelope: PlanEnvelope): string {
	assertValidPlan(envelope);
	return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function loadPlanEnvelope(path: string): PlanEnvelope {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("plan store is not a regular file");
	return parsePlanEnvelope(readFileSync(path, "utf8"));
}

export function savePlanEnvelope(path: string, envelope: PlanEnvelope): void {
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, serializePlanEnvelope(envelope), {
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

function cloneContent(content: PhaseContent): PhaseContent {
	return {
		title: content.title,
		objective: content.objective,
		successCriteria: [...content.successCriteria],
		hints: [...content.hints],
	};
}

function cloneDecision(item: PlanDecision): PlanDecision {
	return {
		decision: item.decision,
		rationale: item.rationale,
		alternatives: [...item.alternatives],
	};
}

function cloneRisk(item: PlanRisk): PlanRisk {
	return {
		risk: item.risk,
		consequence: item.consequence,
		mitigation: item.mitigation,
	};
}

function cloneSnapshot(snapshot: ConfirmedPlanSnapshot): ConfirmedPlanSnapshot {
	return {
		revision: snapshot.revision,
		content: {
			objective: snapshot.content.objective,
			desiredEndState: snapshot.content.desiredEndState,
			constraints: [...snapshot.content.constraints],
			assumptions: [...snapshot.content.assumptions],
			nonGoals: [...snapshot.content.nonGoals],
			decisions: snapshot.content.decisions.map(cloneDecision),
			risks: snapshot.content.risks.map(cloneRisk),
			successCriteria: [...snapshot.content.successCriteria],
		},
		future: snapshot.future.map((phase) => ({ ...cloneContent(phase) })),
	};
}

function cloneCandidate(candidate: PlanCandidate): PlanCandidate {
	return {
		expectedRevision: candidate.expectedRevision,
		objective: candidate.objective,
		desiredEndState: candidate.desiredEndState,
		constraints: [...candidate.constraints],
		assumptions: [...candidate.assumptions],
		nonGoals: [...candidate.nonGoals],
		decisions: candidate.decisions.map(cloneDecision),
		risks: candidate.risks.map(cloneRisk),
		successCriteria: [...candidate.successCriteria],
		future: candidate.future.map((phase) => ({
			...(phase.id === undefined ? {} : { id: phase.id }),
			...cloneContent(phase),
			amendments: [...phase.amendments],
		})),
		worktreeSnapshot: {
			head: candidate.worktreeSnapshot.head,
			paths: [...candidate.worktreeSnapshot.paths],
			tree: candidate.worktreeSnapshot.tree,
		},
		activeWorkDisposition: candidate.activeWorkDisposition,
	};
}

export function setCandidate(
	envelope: PlanEnvelope,
	candidate: PlanCandidate,
): PlanEnvelope {
	assertValidPlan(envelope);
	if (envelope.candidate) throw new Error("a candidate already awaits a decision");
	if (!validPlanCandidate(candidate))
		throw new Error("candidate does not match the exact candidate schema");
	if (candidate.expectedRevision !== envelope.revision)
		throw new Error("candidate expectedRevision is stale");

	const invariantErrors = candidateInvariantErrors(envelope, candidate);
	if (invariantErrors.length) throw new Error(invariantErrors[0]);
	const requiredRevisions = 1 + candidate.future.length;
	if (requiredRevisions > Number.MAX_SAFE_INTEGER - envelope.revision)
		throw new Error("candidate and its future completions exceed the plan revision bound");
	const additions = candidate.future.filter((phase) => !phase.id).length;
	if (additions > Number.MAX_SAFE_INTEGER - envelope.nextPhaseId)
		throw new Error("phase ID allocation would exceed Number.MAX_SAFE_INTEGER");

	return { ...envelope, candidate: cloneCandidate(candidate) };
}

export function sameWorktreeSnapshot(
	left: WorktreeSnapshot,
	right: WorktreeSnapshot,
): boolean {
	return (
		left.head === right.head &&
		left.tree === right.tree &&
		left.paths.length === right.paths.length &&
		left.paths.every((path, index) => path === right.paths[index])
	);
}

function sameTextList(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameDecisions(left: PlanDecision[], right: PlanDecision[]): boolean {
	return left.length === right.length && left.every((item, index) =>
		item.decision === right[index].decision &&
		item.rationale === right[index].rationale &&
		sameTextList(item.alternatives, right[index].alternatives),
	);
}

function sameRisks(left: PlanRisk[], right: PlanRisk[]): boolean {
	return left.length === right.length && left.every((item, index) =>
		item.risk === right[index].risk &&
		item.consequence === right[index].consequence &&
		item.mitigation === right[index].mitigation,
	);
}

function samePlanContent(left: PlanContent, right: PlanContent): boolean {
	return left.objective === right.objective &&
		left.desiredEndState === right.desiredEndState &&
		sameTextList(left.constraints, right.constraints) &&
		sameTextList(left.assumptions, right.assumptions) &&
		sameTextList(left.nonGoals, right.nonGoals) &&
		sameDecisions(left.decisions, right.decisions) &&
		sameRisks(left.risks, right.risks) &&
		sameTextList(left.successCriteria, right.successCriteria);
}

function sameSnapshot(left: ConfirmedPlanSnapshot, right: ConfirmedPlanSnapshot): boolean {
	return left.revision === right.revision &&
		samePlanContent(left.content, right.content) &&
		left.future.length === right.future.length &&
		left.future.every((phase, index) => samePhaseContent(phase, right.future[index]));
}

function sameCandidate(left: PlanCandidate, right: PlanCandidate): boolean {
	return left.expectedRevision === right.expectedRevision &&
		samePlanContent(left, right) &&
		left.future.length === right.future.length &&
		left.future.every((phase, index) =>
			phase.id === right.future[index].id &&
			samePhaseContent(phase, right.future[index]) &&
			sameAmendments(phase.amendments, right.future[index].amendments),
		) &&
		sameWorktreeSnapshot(left.worktreeSnapshot, right.worktreeSnapshot) &&
		left.activeWorkDisposition === right.activeWorkDisposition;
}

export function clearCandidate(
	envelope: PlanEnvelope,
	expected: PlanCandidate,
): PlanEnvelope {
	assertValidPlan(envelope);
	if (!envelope.candidate || !sameCandidate(envelope.candidate, expected))
		throw new Error("candidate changed before it could be cleared");
	return { ...envelope, candidate: null };
}

export function clearStaleCandidate(
	envelope: PlanEnvelope,
	actualSnapshot: WorktreeSnapshot,
): PlanEnvelope {
	assertValidPlan(envelope);
	if (!validWorktreeSnapshot(actualSnapshot))
		throw new Error("worktree snapshot does not match the exact snapshot schema");
	if (!envelope.candidate) throw new Error("no candidate awaits a decision");
	if (
		sameWorktreeSnapshot(envelope.candidate.worktreeSnapshot, actualSnapshot)
	)
		throw new Error("candidate worktree snapshot is still current");
	return { ...envelope, candidate: null };
}

function applyCandidate(
	envelope: PlanEnvelope,
	candidate: PlanCandidate,
): PlanEnvelope {
	const requiredRevisions = 1 + candidate.future.length;
	if (requiredRevisions > Number.MAX_SAFE_INTEGER - envelope.revision)
		throw new Error("candidate and its future completions exceed the plan revision bound");
	const completed = envelope.approved?.completed ?? [];
	let nextPhaseId = envelope.nextPhaseId;
	const future: PendingPhase[] = candidate.future.map((phase) => ({
		id: phase.id ?? `P${nextPhaseId++}`,
		status: "pending",
		...cloneContent(phase),
		amendments: [...phase.amendments],
		resolution: null,
		commit: null,
	}));
	const promoted: PlanEnvelope = {
		...envelope,
		revision: envelope.revision + 1,
		nextPhaseId,
		approved: {
			objective: candidate.objective,
			desiredEndState: candidate.desiredEndState,
			constraints: [...candidate.constraints],
			assumptions: [...candidate.assumptions],
			nonGoals: [...candidate.nonGoals],
			decisions: candidate.decisions.map(cloneDecision),
			risks: candidate.risks.map(cloneRisk),
			successCriteria: [...candidate.successCriteria],
			completed: [...completed],
			future,
		},
		candidate: null,
		history: [...envelope.history.map(cloneSnapshot), {
			revision: envelope.revision + 1,
			content: {
				objective: candidate.objective,
				desiredEndState: candidate.desiredEndState,
				constraints: [...candidate.constraints],
				assumptions: [...candidate.assumptions],
				nonGoals: [...candidate.nonGoals],
				decisions: candidate.decisions.map(cloneDecision),
				risks: candidate.risks.map(cloneRisk),
				successCriteria: [...candidate.successCriteria],
			},
			future: future.map(({ title, objective, successCriteria, hints }) => ({ title, objective, successCriteria: [...successCriteria], hints: [...hints] })),
		}],
	};
	assertValidPlan(promoted);
	return promoted;
}

export function promoteCandidate(
	envelope: PlanEnvelope,
	actualSnapshot: WorktreeSnapshot,
): PlanEnvelope {
	assertValidPlan(envelope);
	if (!validWorktreeSnapshot(actualSnapshot))
		throw new Error("worktree snapshot does not match the exact snapshot schema");
	const candidate = envelope.candidate;
	if (!candidate) throw new Error("no candidate awaits promotion");
	if (candidate.expectedRevision !== envelope.revision)
		throw new Error("candidate expectedRevision is stale");
	if (candidate.activeWorkDisposition === "discard")
		throw new Error("discard candidate requires the recoverable discard transaction");
	if (!sameWorktreeSnapshot(candidate.worktreeSnapshot, actualSnapshot))
		throw new Error("candidate worktree snapshot is stale");
	return applyCandidate(envelope, candidate);
}

export function candidateClearingMatches(
	envelope: PlanEnvelope,
	candidate: PlanCandidate,
): boolean {
	return (
		validatePlanEnvelope(envelope).length === 0 &&
		validPlanCandidate(candidate) &&
		envelope.candidate === null &&
		envelope.revision === candidate.expectedRevision
	);
}

export function candidatePromotionMatches(
	envelope: PlanEnvelope,
	candidate: PlanCandidate,
): boolean {
	if (
		validatePlanEnvelope(envelope).length > 0 ||
		!validPlanCandidate(candidate) ||
		envelope.candidate !== null ||
		envelope.revision !== candidate.expectedRevision + 1 ||
		!envelope.approved
	)
		return false;
	const approved = envelope.approved;
	if (!samePlanContent(approved, candidate)) return false;
	const pending = approved.future;
	const additions = candidate.future.filter((phase) => !phase.id).length;
	let nextPhaseId = envelope.nextPhaseId - additions;
	const expected = candidate.future.map((phase): PendingPhase => ({
		id: phase.id ?? `P${nextPhaseId++}`,
		status: "pending",
		...cloneContent(phase),
		amendments: [...phase.amendments],
		resolution: null,
		commit: null,
	}));
	const expectedSnapshot: ConfirmedPlanSnapshot = {
		revision: candidate.expectedRevision + 1,
		content: {
			objective: candidate.objective,
			desiredEndState: candidate.desiredEndState,
			constraints: [...candidate.constraints],
			assumptions: [...candidate.assumptions],
			nonGoals: [...candidate.nonGoals],
			decisions: candidate.decisions.map(cloneDecision),
			risks: candidate.risks.map(cloneRisk),
			successCriteria: [...candidate.successCriteria],
		},
		future: expected.map(({ title, objective, successCriteria, hints }) => ({
			title,
			objective,
			successCriteria: [...successCriteria],
			hints: [...hints],
		})),
	};
	const actualSnapshot = envelope.history.at(-1);
	return (
		nextPhaseId === envelope.nextPhaseId &&
		pending.length === expected.length &&
		pending.every((phase, index) => samePendingPhase(phase, expected[index])) &&
		actualSnapshot !== undefined &&
		sameSnapshot(actualSnapshot, expectedSnapshot)
	);
}

export function promoteDiscardedCandidate(
	envelope: PlanEnvelope,
	expected: PlanCandidate,
	cleanSnapshot: WorktreeSnapshot,
): PlanEnvelope {
	assertValidPlan(envelope);
	if (!validWorktreeSnapshot(cleanSnapshot))
		throw new Error("worktree snapshot does not match the exact snapshot schema");
	const candidate = envelope.candidate;
	if (!candidate || !sameCandidate(candidate, expected))
		throw new Error("candidate changed during the discard transaction");
	if (candidate.expectedRevision !== envelope.revision)
		throw new Error("candidate expectedRevision is stale");
	if (candidate.activeWorkDisposition !== "discard")
		throw new Error("candidate does not authorize discarded work");
	if (
		cleanSnapshot.head !== candidate.worktreeSnapshot.head ||
		cleanSnapshot.paths.length !== 0
	)
		throw new Error("discard transaction did not reach the clean expected HEAD");
	return applyCandidate(envelope, candidate);
}

function samePhaseContent(left: PhaseContent, right: PhaseContent): boolean {
	return (
		left.title === right.title &&
		left.objective === right.objective &&
		left.successCriteria.length === right.successCriteria.length &&
		left.successCriteria.every(
			(criterion, index) => criterion === right.successCriteria[index],
		) &&
		left.hints.length === right.hints.length &&
		left.hints.every((hint, index) => hint === right.hints[index])
	);
}

function sameAmendments(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((amendment, index) => amendment === right[index])
	);
}

function sameCandidatePendingPhase(
	candidate: CandidatePhase,
	pending: PendingPhase,
): boolean {
	return (
		candidate.id === pending.id &&
		samePhaseContent(candidate, pending) &&
		sameAmendments(candidate.amendments, pending.amendments)
	);
}

export function samePendingPhase(
	left: unknown,
	right: unknown,
): boolean {
	return (
		validPendingPhase(left) &&
		validPendingPhase(right) &&
		left.id === right.id &&
		samePhaseContent(left, right) &&
		sameAmendments(left.amendments, right.amendments)
	);
}

export function firstPendingPhase(
	envelope: PlanEnvelope,
): PendingPhase | undefined {
	assertValidPlan(envelope);
	return envelope.approved?.future[0];
}

export function amendPendingPhase(
	envelope: PlanEnvelope,
	id: string,
	text: string,
): PlanEnvelope {
	assertValidPlan(envelope);
	if (envelope.candidate)
		throw new Error("cannot amend while a candidate awaits a decision");
	if (envelope.revision >= Number.MAX_SAFE_INTEGER - 1)
		throw new Error("plan revision allocation is exhausted");
	if (!validText(text) || text.length > MAX_AMENDMENT_LENGTH)
		throw new Error(
			`amendment must be nonempty, trimmed, valid text of at most ${MAX_AMENDMENT_LENGTH} characters`,
		);
	if (!envelope.approved) throw new Error(`${id} is not an approved pending phase`);
	const index = envelope.approved.future.findIndex((phase) => phase.id === id);
	if (index < 0) {
		if (envelope.approved.completed.some((phase) => phase.id === id))
			throw new Error(`${id} is completed and cannot be amended`);
		throw new Error(`${id} is not an approved pending phase`);
	}
	const future = [...envelope.approved.future];
	const pending = future[index];
	future[index] = {
		...pending,
		amendments: [...pending.amendments, text],
	};
	const amended: PlanEnvelope = {
		...envelope,
		revision: envelope.revision + 1,
		approved: { ...envelope.approved, future },
	};
	assertValidPlan(amended);
	return amended;
}

export function completedPhaseMatches(
	envelope: PlanEnvelope,
	snapshot: PendingPhase,
): boolean {
	assertValidPlan(envelope);
	const completed = envelope.approved?.completed.find(
		(phase) => phase.id === snapshot.id,
	);
	return Boolean(completed && samePhaseContent(completed, snapshot) && sameAmendments(completed.amendments, snapshot.amendments));
}

export function completePhase(
	envelope: PlanEnvelope,
	snapshot: PendingPhase,
	resolution: string,
	commit: string | null,
): PlanEnvelope {
	assertValidPlan(envelope);
	if (envelope.candidate) throw new Error("cannot complete while a candidate awaits a decision");
	if (!validPendingPhase(snapshot))
		throw new Error("phase does not match the exact pending phase schema");
	if (!validText(resolution, true))
		throw new Error("resolution must be nonempty, trimmed, and single-line");
	if (commit !== null && !OBJECT_ID.test(commit)) throw new Error("commit is not a full Git object ID");
	if (!envelope.approved) throw new Error("no approved plan exists");

	const existing = envelope.approved.future.find(
		(phase) => phase.id === snapshot.id,
	);
	if (!existing) {
		const completed = envelope.approved.completed.find(
			(phase) => phase.id === snapshot.id,
		);
		if (!completed || !samePhaseContent(completed, snapshot) || !sameAmendments(completed.amendments, snapshot.amendments))
			throw new Error("phase does not match the exact approved snapshot");
		if (completed.resolution === resolution && completed.commit === commit)
			return envelope;
		throw new Error("completed phase result does not match recovery");
	}
	const first = firstPendingPhase(envelope);
	if (!first || !samePendingPhase(first, snapshot))
		throw new Error("phase is not the unchanged first pending phase");
	if (
		envelope.revision >= Number.MAX_SAFE_INTEGER - 1 &&
		envelope.approved.future.length > 1
	) throw new Error("plan revision allocation is exhausted");

	const completed: CompletedPhase = {
		id: existing.id,
		status: "completed",
		...cloneContent(existing),
		amendments: [...existing.amendments],
		resolution,
		commit,
	};
	const updated: PlanEnvelope = {
		...envelope,
		revision: envelope.revision + 1,
		approved: {
			...envelope.approved,
			completed: [...envelope.approved.completed, completed],
			future: envelope.approved.future.slice(1),
		},
	};
	assertValidPlan(updated);
	return updated;
}

export function planIsDone(envelope: PlanEnvelope): boolean {
	assertValidPlan(envelope);
	return Boolean(envelope.approved && envelope.approved.future.length === 0);
}
