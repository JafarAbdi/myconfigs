import type { PatchIdentity, ReviewPatch } from "./review-git.ts";
import {
	addTaskReviewComment,
	currentTaskReviewRound,
	decideTaskReview,
	deleteTaskReviewComment,
	loadTaskDocument,
	saveTaskDocument,
	updateTaskReviewComment,
	type HumanComment,
	type HumanCommentInput,
	type ReviewDecision,
	type ReviewDecisionKind,
	type ReviewerAnnotation,
	type ReviewerKind,
	type ReviewSide,
	type TaskDocument,
	type TaskReviewRound,
} from "./task.ts";

export type {
	HumanComment,
	HumanCommentInput,
	ReviewDecision,
	ReviewDecisionKind,
} from "./task.ts";

export interface AgentAnnotation extends ReviewerAnnotation {
	source: string;
}

export interface ReviewState {
	version: 1;
	patch: PatchIdentity;
	agentAnnotations: AgentAnnotation[];
	humanComments: HumanComment[];
	decision: ReviewDecision | null;
}

export class ReviewStateError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new ReviewStateError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	) throw new ReviewStateError("review mutation has invalid fields");
}

function cleanText(value: unknown, label: string, maximum: number): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.includes("\0") ||
		value.length > maximum
	) throw new ReviewStateError(`${label} must be trimmed, non-empty, NUL-free, and at most ${maximum} characters`);
	return value;
}

function bodyText(value: unknown): string {
	if (typeof value !== "string")
		throw new ReviewStateError("comment body must be text");
	return cleanText(value.trim(), "comment body", 10_000);
}

function line(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		throw new ReviewStateError(`${label} must be a positive integer`);
	return value as number;
}

function side(value: unknown): ReviewSide {
	if (value !== "additions" && value !== "deletions")
		throw new ReviewStateError("side must be additions or deletions");
	return value;
}

function validateTarget(
	patch: ReviewPatch,
	filePath: string,
	targetSide: ReviewSide,
	startLine: number,
	endLine: number,
): void {
	if (endLine < startLine)
		throw new ReviewStateError("comment range end must not precede its start");
	const file = patch.files.find((candidate) => candidate.filePath === filePath);
	if (!file) throw new ReviewStateError(`${filePath}: file is not in this patch`);
	const changed = new Set(file.changed[targetSide]);
	for (let current = startLine; current <= endLine; current += 1)
		if (!changed.has(current))
			throw new ReviewStateError(`${filePath}: ${targetSide} line ${current} is not a changed line`);
}

function commentInput(value: unknown, patch: ReviewPatch): HumanCommentInput {
	const input = record(value, "human comment");
	exactKeys(input, ["filePath", "side", "startLine", "endLine", "body"]);
	const comment = {
		filePath: cleanText(input.filePath, "comment filePath", 4_096),
		side: side(input.side),
		startLine: line(input.startLine, "comment startLine"),
		endLine: line(input.endLine, "comment endLine"),
		body: bodyText(input.body),
	};
	validateTarget(patch, comment.filePath, comment.side, comment.startLine, comment.endLine);
	return comment;
}

function commentBody(value: unknown): string {
	const input = record(value, "comment update");
	exactKeys(input, ["body"]);
	return bodyText(input.body);
}

function validateAnnotation(patch: ReviewPatch, annotation: ReviewerAnnotation): void {
	validateTarget(patch, annotation.filePath, annotation.side, annotation.line, annotation.line);
}

function projectAnnotations(round: TaskReviewRound, patch: ReviewPatch): AgentAnnotation[] {
	const projected: AgentAnnotation[] = [];
	for (const [kind, source] of [
		["deviation", "Deviation reviewer"],
		["correctness", "Correctness reviewer"],
	] as const satisfies readonly (readonly [ReviewerKind, string])[]) {
		const outcome = round.reviewers[kind]?.outcome;
		if (outcome?.status !== "completed") continue;
		for (const annotation of outcome.annotations) {
			validateAnnotation(patch, annotation);
			projected.push({ ...structuredClone(annotation), source });
		}
	}
	return projected;
}

function domainError(error: unknown): never {
	if (error instanceof ReviewStateError) throw error;
	const message = error instanceof Error ? error.message : String(error);
	if (/not found/u.test(message)) throw new ReviewStateError(message, 404);
	if (/completed decision|current review|terminal outcomes|already|requires/u.test(message))
		throw new ReviewStateError(message, 409);
	throw new ReviewStateError(message, 400);
}

export class ReviewStore {
	readonly taskPath: string;
	private readonly patch: ReviewPatch;
	private readonly roundNumber: number;
	private readonly identity: PatchIdentity;

	constructor(taskPath: string, patch: ReviewPatch) {
		this.taskPath = taskPath;
		this.patch = patch;
		this.identity = { ...patch.identity };
		let task: TaskDocument;
		try {
			task = loadTaskDocument(taskPath);
		} catch (error) {
			throw new ReviewStateError(
				`authoritative task.json is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				409,
			);
		}
		const round = currentTaskReviewRound(task);
		if (!round) throw new ReviewStateError("task has no current review round", 409);
		this.roundNumber = round.number;
		this.stateFrom(task);
	}

	private stateFrom(task: TaskDocument): ReviewState {
		const round = currentTaskReviewRound(task);
		if (
			(task.stage !== "review" && task.stage !== "done") ||
			!round ||
			round.number !== this.roundNumber ||
			round.baseCommit !== this.identity.baseOid ||
			round.headCommit !== this.identity.headOid
		) throw new ReviewStateError("review round or patch identity is stale", 409);
		if (!round.reviewers.deviation?.outcome || !round.reviewers.correctness?.outcome)
			throw new ReviewStateError("both reviewers must be terminal before browser review", 409);
		for (const comment of round.humanComments)
			validateTarget(this.patch, comment.filePath, comment.side, comment.startLine, comment.endLine);
		return {
			version: 1,
			patch: { ...this.identity },
			agentAnnotations: projectAnnotations(round, this.patch),
			humanComments: structuredClone(round.humanComments),
			decision: structuredClone(round.decision),
		};
	}

	private load(): { task: TaskDocument; state: ReviewState } {
		let task: TaskDocument;
		try {
			task = loadTaskDocument(this.taskPath);
		} catch (error) {
			throw new ReviewStateError(
				`authoritative task.json is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				409,
			);
		}
		return { task, state: this.stateFrom(task) };
	}

	snapshot(): ReviewState {
		return this.load().state;
	}

	private save(task: TaskDocument): ReviewState {
		saveTaskDocument(this.taskPath, task);
		return this.stateFrom(task);
	}

	addComment(value: unknown): ReviewState {
		const { task } = this.load();
		let updated: TaskDocument;
		try {
			updated = addTaskReviewComment(task, commentInput(value, this.patch));
		} catch (error) {
			domainError(error);
		}
		return this.save(updated);
	}

	updateComment(id: string, value: unknown): ReviewState {
		const { task } = this.load();
		let updated: TaskDocument;
		try {
			updated = updateTaskReviewComment(task, id, commentBody(value));
		} catch (error) {
			domainError(error);
		}
		return this.save(updated);
	}

	deleteComment(id: string): ReviewState {
		const { task } = this.load();
		let updated: TaskDocument;
		try {
			updated = deleteTaskReviewComment(task, id);
		} catch (error) {
			domainError(error);
		}
		return this.save(updated);
	}

	decide(kind: unknown): ReviewState {
		if (kind !== "approve" && kind !== "send-feedback")
			throw new ReviewStateError("decision kind is invalid");
		const { task } = this.load();
		let updated: TaskDocument;
		try {
			updated = decideTaskReview(task, kind);
		} catch (error) {
			domainError(error);
		}
		return this.save(updated);
	}
}
