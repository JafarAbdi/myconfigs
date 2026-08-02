import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	PatchIdentity,
	ReviewPatch,
	ReviewSide,
} from "./review-git.ts";

export interface AgentAnnotation {
	filePath: string;
	side: ReviewSide;
	line: number;
	source: string;
	summary: string;
	rationale?: string;
}

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new ReviewStateError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !(key in value)) ||
		Object.keys(value).some((key) => !allowed.has(key))
	)
		throw new ReviewStateError("review state has invalid fields");
}

function text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum)
		throw new ReviewStateError(`${label} must be non-empty and at most ${maximum} characters`);
	return value;
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

function timestamp(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	)
		throw new ReviewStateError(`${label} must be an ISO timestamp`);
	return value;
}

function patchIdentity(value: unknown): PatchIdentity {
	const input = record(value, "patch");
	exactKeys(input, ["baseOid", "headOid"]);
	if (!OID.test(input.baseOid as string) || !OID.test(input.headOid as string))
		throw new ReviewStateError("patch object IDs must be full hexadecimal OIDs");
	return {
		baseOid: input.baseOid as string,
		headOid: input.headOid as string,
	};
}

function validatesTarget(
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
			throw new ReviewStateError(
				`${filePath}: ${targetSide} line ${current} is not a changed line`,
			);
}

function agentAnnotation(value: unknown, patch: ReviewPatch): AgentAnnotation {
	const input = record(value, "agent annotation");
	exactKeys(input, ["filePath", "side", "line", "source", "summary"], ["rationale"]);
	const annotation = {
		filePath: text(input.filePath, "agent filePath", 4_096),
		side: side(input.side),
		line: line(input.line, "agent line"),
		source: text(input.source, "agent source", 100),
		summary: text(input.summary, "agent summary", 2_000),
		...(input.rationale === undefined
			? {}
			: { rationale: text(input.rationale, "agent rationale", 5_000) }),
	};
	validatesTarget(
		patch,
		annotation.filePath,
		annotation.side,
		annotation.line,
		annotation.line,
	);
	return annotation;
}

function commentInput(value: unknown, patch: ReviewPatch): HumanCommentInput {
	const input = record(value, "human comment");
	exactKeys(input, ["filePath", "side", "startLine", "endLine", "body"]);
	const comment = {
		filePath: text(input.filePath, "comment filePath", 4_096),
		side: side(input.side),
		startLine: line(input.startLine, "comment startLine"),
		endLine: line(input.endLine, "comment endLine"),
		body: text(input.body, "comment body", 10_000).trim(),
	};
	validatesTarget(
		patch,
		comment.filePath,
		comment.side,
		comment.startLine,
		comment.endLine,
	);
	return comment;
}

function commentBody(value: unknown): string {
	const input = record(value, "comment update");
	exactKeys(input, ["body"]);
	return text(input.body, "comment body", 10_000).trim();
}

function humanComment(value: unknown, patch: ReviewPatch): HumanComment {
	const input = record(value, "human comment");
	exactKeys(input, [
		"id",
		"filePath",
		"side",
		"startLine",
		"endLine",
		"body",
		"createdAt",
	]);
	if (typeof input.id !== "string" || !UUID.test(input.id))
		throw new ReviewStateError("comment id must be a UUID");
	return {
		id: input.id,
		...commentInput(
			{
				filePath: input.filePath,
				side: input.side,
				startLine: input.startLine,
				endLine: input.endLine,
				body: input.body,
			},
			patch,
		),
		createdAt: timestamp(input.createdAt, "comment createdAt"),
	};
}

function decision(value: unknown): ReviewDecision | null {
	if (value === null) return null;
	const input = record(value, "decision");
	exactKeys(input, ["kind", "decidedAt"]);
	if (input.kind !== "approve" && input.kind !== "send-feedback")
		throw new ReviewStateError("decision kind is invalid");
	return {
		kind: input.kind,
		decidedAt: timestamp(input.decidedAt, "decision decidedAt"),
	};
}

export function parseReviewState(source: string, patch: ReviewPatch): ReviewState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new ReviewStateError("review state is not valid JSON");
	}
	const input = record(parsed, "review state");
	exactKeys(input, [
		"version",
		"patch",
		"agentAnnotations",
		"humanComments",
		"decision",
	]);
	if (input.version !== 1) throw new ReviewStateError("review state version is invalid");
	if (!Array.isArray(input.agentAnnotations) || !Array.isArray(input.humanComments))
		throw new ReviewStateError("review annotations and comments must be arrays");
	const identity = patchIdentity(input.patch);
	if (
		identity.baseOid !== patch.identity.baseOid ||
		identity.headOid !== patch.identity.headOid
	)
		throw new ReviewStateError("saved review state belongs to a different patch");
	const humanComments = input.humanComments.map((item) => humanComment(item, patch));
	if (new Set(humanComments.map(({ id }) => id)).size !== humanComments.length)
		throw new ReviewStateError("review state contains duplicate comment IDs");
	const completedDecision = decision(input.decision);
	if (completedDecision?.kind === "send-feedback" && humanComments.length === 0)
		throw new ReviewStateError("saved Send Feedback decision has no human comments");
	return {
		version: 1,
		patch: identity,
		agentAnnotations: input.agentAnnotations.map((item) => agentAnnotation(item, patch)),
		humanComments,
		decision: completedDecision,
	};
}

function saveAtomic(path: string, state: ReviewState): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

export function resetReviewState(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export class ReviewStore {
	readonly path: string;
	private readonly patch: ReviewPatch;
	private state: ReviewState;

	constructor(
		path: string,
		patch: ReviewPatch,
		initialAgentAnnotations: readonly AgentAnnotation[] = [],
	) {
		this.path = path;
		this.patch = patch;
		if (existsSync(path)) {
			this.state = parseReviewState(readFileSync(path, "utf8"), patch);
			chmodSync(path, 0o600);
			return;
		}
		this.state = {
			version: 1,
			patch: { ...patch.identity },
			agentAnnotations: initialAgentAnnotations.map((item) =>
				agentAnnotation(item, patch),
			),
			humanComments: [],
			decision: null,
		};
		saveAtomic(this.path, this.state);
	}

	snapshot(): ReviewState {
		return structuredClone(this.state);
	}

	private requireOpen(): void {
		if (this.state.decision)
			throw new ReviewStateError("this review already has a completed decision", 409);
	}

	private commit(next: ReviewState): ReviewState {
		saveAtomic(this.path, next);
		this.state = next;
		return this.snapshot();
	}

	addComment(value: unknown): ReviewState {
		this.requireOpen();
		const input = commentInput(value, this.patch);
		return this.commit({
			...this.state,
			humanComments: [
				...this.state.humanComments,
				{
					id: randomUUID(),
					...input,
					createdAt: new Date().toISOString(),
				},
			],
		});
	}

	updateComment(id: string, value: unknown): ReviewState {
		this.requireOpen();
		if (!this.state.humanComments.some((comment) => comment.id === id))
			throw new ReviewStateError("comment not found", 404);
		const body = commentBody(value);
		return this.commit({
			...this.state,
			humanComments: this.state.humanComments.map((comment) =>
				comment.id === id ? { ...comment, body } : comment,
			),
		});
	}

	deleteComment(id: string): ReviewState {
		this.requireOpen();
		const comments = this.state.humanComments.filter((comment) => comment.id !== id);
		if (comments.length === this.state.humanComments.length)
			throw new ReviewStateError("comment not found", 404);
		return this.commit({ ...this.state, humanComments: comments });
	}

	decide(kind: unknown): ReviewState {
		this.requireOpen();
		if (kind !== "approve" && kind !== "send-feedback")
			throw new ReviewStateError("decision kind is invalid");
		if (kind === "send-feedback" && this.state.humanComments.length === 0)
			throw new ReviewStateError(
				"Send Feedback requires at least one saved human comment",
				409,
			);
		return this.commit({
			...this.state,
			decision: { kind, decidedAt: new Date().toISOString() },
		});
	}
}
