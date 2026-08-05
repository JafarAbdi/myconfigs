import { randomUUID } from "node:crypto";
import type { AuditFinding } from "./audit.ts";
import type { ReviewPatch, ReviewSide } from "./review-git.ts";

export const MAX_REVIEW_COMMENTS = 200;
export const MAX_REVIEW_AGGREGATE_COMMENT_BYTES = 256 * 1_024;

export interface HumanCommentInput {
	filePath: string;
	side: ReviewSide;
	startLine: number;
	endLine: number;
	body: string;
}

export interface HumanComment extends HumanCommentInput {
	id: string;
	createdAt: string;
	updatedAt: string;
}

export interface GeneralComment {
	body: string;
	createdAt: string;
	updatedAt: string;
}

export type ReviewDecisionKind = "approve" | "send-feedback";

export interface ReviewDecision {
	kind: ReviewDecisionKind;
	decidedAt: string;
}

export interface ReviewState {
	version: 2;
	snapshot: { headOid: string };
	auditFindings: AuditFinding[];
	humanComments: HumanComment[];
	generalComment: GeneralComment | null;
	decision: ReviewDecision | null;
}

export interface ReviewStoreFactories {
	clock?: () => string;
	idFactory?: () => string;
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
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
		throw new ReviewStateError("review mutation has invalid fields");
}

function cleanText(value: unknown, label: string, maximum: number): string {
	if (
		typeof value !== "string" || !value || value !== value.trim() ||
		value.includes("\0") || value.length > maximum
	) throw new ReviewStateError(`${label} must be trimmed, non-empty, NUL-free, and at most ${maximum} characters`);
	return value;
}

function bodyText(value: unknown): string {
	if (typeof value !== "string") throw new ReviewStateError("comment body must be text");
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

function targetKey(filePath: string, targetSide: ReviewSide): string {
	return `${targetSide}\0${filePath}`;
}

function commentInput(
	value: unknown,
	validateTarget: (filePath: string, side: ReviewSide, startLine: number, endLine: number) => void,
): HumanCommentInput {
	const input = record(value, "human comment");
	exactKeys(input, ["filePath", "side", "startLine", "endLine", "body"]);
	const comment = {
		filePath: cleanText(input.filePath, "comment filePath", 4_096),
		side: side(input.side),
		startLine: line(input.startLine, "comment startLine"),
		endLine: line(input.endLine, "comment endLine"),
		body: bodyText(input.body),
	};
	validateTarget(comment.filePath, comment.side, comment.startLine, comment.endLine);
	return comment;
}

function commentBody(value: unknown): string {
	const input = record(value, "comment update");
	exactKeys(input, ["body"]);
	return bodyText(input.body);
}

function cloneState(state: ReviewState): ReviewState {
	return {
		version: 2,
		snapshot: { ...state.snapshot },
		auditFindings: structuredClone(state.auditFindings),
		humanComments: structuredClone(state.humanComments),
		generalComment: state.generalComment ? { ...state.generalComment } : null,
		decision: state.decision ? { ...state.decision } : null,
	};
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

interface FeedbackGroup {
	filePath: string;
	side: ReviewSide;
	startLine: number;
	endLine: number;
	findings: AuditFinding[];
	comments: HumanComment[];
}

function compareTargets(left: FeedbackGroup, right: FeedbackGroup): number {
	return compareText(left.filePath, right.filePath) ||
		compareText(left.side, right.side) ||
		left.startLine - right.startLine ||
		left.endLine - right.endLine;
}

function sideLabel(side_: ReviewSide): "new" | "old" {
	return side_ === "additions" ? "new" : "old";
}

function targetLabel(group: FeedbackGroup): string {
	const range = group.startLine === group.endLine
		? `L${group.startLine}`
		: `L${group.startLine}-${group.endLine}`;
	return `${group.filePath}:${sideLabel(group.side)} ${range}`;
}

function quoteAgent(message: string): string[] {
	return ["> **AGENT**", ">", ...message.split("\n").map((line) => line ? `> ${line}` : ">")];
}

export function formatReviewFeedback(
	state: Pick<ReviewState, "auditFindings" | "humanComments" | "generalComment">,
): string {
	const groups = new Map<string, FeedbackGroup>();
	const groupFor = (
		filePath: string,
		side: ReviewSide,
		startLine: number,
		endLine: number,
	): FeedbackGroup => {
		const key = JSON.stringify([filePath, side, startLine, endLine]);
		let group = groups.get(key);
		if (!group) {
			group = { filePath, side, startLine, endLine, findings: [], comments: [] };
			groups.set(key, group);
		}
		return group;
	};
	for (const finding of state.auditFindings)
		groupFor(finding.filePath, finding.side, finding.line, finding.line).findings.push(finding);
	for (const comment of state.humanComments)
		groupFor(comment.filePath, comment.side, comment.startLine, comment.endLine).comments.push(comment);

	const lines = ["# Review feedback"];
	if (state.generalComment)
		lines.push("", "## General", "", "**HUMAN**", "", state.generalComment.body);
	for (const group of [...groups.values()].sort(compareTargets)) {
		lines.push("", `## ${targetLabel(group)}`);
		for (const finding of group.findings) lines.push("", ...quoteAgent(finding.message));
		for (const comment of group.comments.sort((left, right) => compareText(left.id, right.id)))
			lines.push("", "**HUMAN**", "", comment.body);
	}
	return `${lines.join("\n")}\n`;
}

export class ReviewStore {
	private readonly targets = new Map<string, ReadonlySet<number>>();
	private readonly clock: () => string;
	private readonly idFactory: () => string;
	private state: ReviewState;

	constructor(
		patch: ReviewPatch,
		auditFindings: readonly AuditFinding[] = [],
		factories: ReviewStoreFactories = {},
	) {
		for (const file of patch.files) {
			this.targets.set(targetKey(file.filePath, "additions"), new Set(file.changed.additions));
			this.targets.set(targetKey(file.filePath, "deletions"), new Set(file.changed.deletions));
		}
		this.clock = factories.clock ?? (() => new Date().toISOString());
		this.idFactory = factories.idFactory ?? randomUUID;
		for (const finding of auditFindings)
			this.validateTarget(finding.filePath, finding.side, finding.line, finding.line);
		this.state = {
			version: 2,
			snapshot: { headOid: patch.snapshot.headOid },
			auditFindings: structuredClone([...auditFindings]),
			humanComments: [],
			generalComment: null,
			decision: null,
		};
	}

	private validateTarget(
		filePath: string,
		targetSide: ReviewSide,
		startLine: number,
		endLine: number,
	): void {
		if (endLine < startLine)
			throw new ReviewStateError("comment range end must not precede its start");
		const changed = this.targets.get(targetKey(filePath, targetSide));
		if (!changed) throw new ReviewStateError(`${filePath}: file is not in this patch`);
		if (endLine - startLine + 1 > changed.size)
			throw new ReviewStateError(`${filePath}: comment range exceeds its changed lines`);
		for (let current = startLine; current <= endLine; current += 1)
			if (!changed.has(current))
				throw new ReviewStateError(`${filePath}: ${targetSide} line ${current} is not a changed line`);
	}

	private requireOpen(): void {
		if (this.state.decision)
			throw new ReviewStateError("review has a terminal decision", 409);
	}

	private requireCommentBytes(body: string, previousBody = ""): void {
		const bytes = this.state.humanComments.reduce(
			(total, comment) => total + Buffer.byteLength(comment.body, "utf8"),
			Buffer.byteLength(this.state.generalComment?.body ?? "", "utf8") +
				Buffer.byteLength(body, "utf8") - Buffer.byteLength(previousBody, "utf8"),
		);
		if (bytes > MAX_REVIEW_AGGREGATE_COMMENT_BYTES)
			throw new ReviewStateError("aggregate comment bodies are too large", 413);
	}

	private timestamp(): string {
		const value = this.clock();
		if (!Number.isFinite(Date.parse(value)))
			throw new ReviewStateError("review clock returned an invalid timestamp", 500);
		return value;
	}

	snapshot(): ReviewState {
		return cloneState(this.state);
	}

	addComment(value: unknown): ReviewState {
		this.requireOpen();
		if (this.state.humanComments.length >= MAX_REVIEW_COMMENTS)
			throw new ReviewStateError("review has too many comments", 413);
		const input = commentInput(value, this.validateTarget.bind(this));
		this.requireCommentBytes(input.body);
		const id = cleanText(this.idFactory(), "comment id", 256);
		if (this.state.humanComments.some((comment) => comment.id === id))
			throw new ReviewStateError("comment id already exists", 409);
		const timestamp = this.timestamp();
		this.state.humanComments.push({
			...input,
			id,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		return this.snapshot();
	}

	updateComment(id: string, value: unknown): ReviewState {
		this.requireOpen();
		const cleanId = cleanText(id, "comment id", 256);
		const comment = this.state.humanComments.find((candidate) => candidate.id === cleanId);
		if (!comment) throw new ReviewStateError("comment not found", 404);
		const body = commentBody(value);
		this.requireCommentBytes(body, comment.body);
		comment.body = body;
		comment.updatedAt = this.timestamp();
		return this.snapshot();
	}

	deleteComment(id: string): ReviewState {
		this.requireOpen();
		const cleanId = cleanText(id, "comment id", 256);
		const index = this.state.humanComments.findIndex((candidate) => candidate.id === cleanId);
		if (index === -1) throw new ReviewStateError("comment not found", 404);
		this.state.humanComments.splice(index, 1);
		return this.snapshot();
	}

	setGeneralComment(value: unknown): ReviewState {
		this.requireOpen();
		const body = commentBody(value);
		const previous = this.state.generalComment;
		this.requireCommentBytes(body, previous?.body);
		const timestamp = this.timestamp();
		this.state.generalComment = {
			body,
			createdAt: previous?.createdAt ?? timestamp,
			updatedAt: timestamp,
		};
		return this.snapshot();
	}

	deleteGeneralComment(): ReviewState {
		this.requireOpen();
		if (!this.state.generalComment)
			throw new ReviewStateError("general comment not found", 404);
		this.state.generalComment = null;
		return this.snapshot();
	}

	decide(kind: unknown): ReviewState {
		this.requireOpen();
		if (kind !== "approve" && kind !== "send-feedback")
			throw new ReviewStateError("decision kind is invalid");
		if (
			kind === "approve" &&
			(this.state.humanComments.length > 0 || this.state.generalComment)
		) throw new ReviewStateError("Approve requires all human comments to be removed", 409);
		if (
			kind === "send-feedback" && this.state.auditFindings.length === 0 &&
			this.state.humanComments.length === 0 && !this.state.generalComment
		) throw new ReviewStateError("Send Feedback requires at least one finding or comment", 409);
		this.state.decision = { kind, decidedAt: this.timestamp() };
		return this.snapshot();
	}
}
