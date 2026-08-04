import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadAgent } from "../subagent/agents.ts";
import { runAgent, type RunAgentOptions } from "../subagent/run-agent.ts";
import {
	childSessionDir,
	classifyResult,
	selectRuntime,
	type Agent,
	type Inherited,
	type NativeClaudeOptions,
	type RunResult,
} from "../subagent/runtimes.ts";
import type { ReviewPatch, ReviewSide } from "./review-git.ts";

export const AUDIT_CATEGORIES = [
	"intent",
	"correctness",
	"test-integrity",
	"coherence",
	"context",
	"simplicity",
] as const;

export type AuditCategory = typeof AUDIT_CATEGORIES[number];

export interface AuditFinding {
	category: AuditCategory;
	filePath: string;
	side: ReviewSide;
	line: number;
	message: string;
}

export interface AuditResult {
	findings: AuditFinding[];
}

export interface AuditRequirement {
	path: string;
	content: string;
}

export interface AuditParentSession {
	directory: string;
	id: string;
}

export interface RunAuditInput {
	repositoryRoot: string;
	patch: ReviewPatch;
	parentSession: AuditParentSession;
	requirement?: AuditRequirement;
	signal?: AbortSignal;
}

interface AuditReviewer {
	name: string;
	category: AuditCategory;
	model: string;
	lens: string;
	thinking?: "high";
	effort?: "high";
}

export const AUDIT_ROSTER = [
	{
		name: "intent",
		category: "intent",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		lens: "Check the staged patch against the supplied requirement's required behavior, exclusions, and candidate boundary. When no requirement is supplied, do not invent product intent; report only an unmistakable contradiction with intent established by the changed code and governing context.",
	},
	{
		name: "correctness",
		category: "correctness",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		lens: "Find reachable behavioral, security, data-loss, timing, lifetime, bounds, and error-handling defects caused by the patch. Trace the smallest amount of nearby code needed to prove the failure path, and do not report hypothetical misuse without a reachable caller.",
	},
	{
		name: "tests",
		category: "test-integrity",
		model: "claude-sonnet-5",
		effort: "high",
		lens: "Statically review test honesty and integrity; never execute tests. Look for deleted or skipped tests, weakened assertions, fixtures or mocks that bypass real behavior, discovery or configuration changes that hide tests, behavioral inequivalence, and material claims lacking the proof required by the change. Do not demand blanket coverage or tests for changes that do not materially need them.",
	},
	{
		name: "coherence",
		category: "coherence",
		model: "openai-codex/gpt-5.6-terra",
		thinking: "high",
		lens: "Detect split-brain or duplicate designs, uneven implementation of one invariant, temporary shortcuts left in the final path, and unjustified concentration of responsibilities introduced by the patch. Report only concrete inconsistencies with a material maintenance or behavioral consequence.",
	},
	{
		name: "context",
		category: "context",
		model: "openai-codex/gpt-5.6-luna",
		thinking: "high",
		lens: "Apply the exact governing repository instructions and established local invariants to the staged patch. Read nearby context only when needed to establish those facts, and distinguish an actual violated convention from a personal preference.",
	},
	{
		name: "simplicity",
		category: "simplicity",
		model: "claude-sonnet-5",
		effort: "high",
		lens: "Look for material complexity that the requirement does not justify and that deletion or an existing local mechanism would remove. Do not penalize necessary core changes merely because they touch core code, and do not propose broad cleanup unrelated to the staged behavior.",
	},
] as const satisfies readonly AuditReviewer[];

const MAX_AUDIT_FINDINGS = 500;
const MAX_AUDIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_REQUIREMENT_BYTES = 1024 * 1024;

const FINDINGS_SCHEMA = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			maxItems: MAX_AUDIT_FINDINGS,
			items: {
				type: "object",
				properties: {
					filePath: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
					side: { type: "string", enum: ["additions", "deletions"] },
					line: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
					message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
				},
				required: ["filePath", "side", "line", "message"],
				additionalProperties: false,
			},
		},
	},
	required: ["findings"],
	additionalProperties: false,
} as const;

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
		throw new Error(`${label} has invalid fields`);
}

function cleanText(value: unknown, label: string, maximum: number): string {
	if (
		typeof value !== "string" || !value || value !== value.trim() ||
		value.includes("\0") || value.length > maximum
	) throw new Error(`${label} must be trimmed, non-empty, NUL-free, and at most ${maximum} characters`);
	return value;
}

export function validateAuditLocations(patch: ReviewPatch, findings: readonly AuditFinding[]): void {
	for (const finding of findings) {
		const file = patch.files.find(({ filePath }) => filePath === finding.filePath);
		if (!file) throw new Error(`${finding.filePath}: audit finding file is not in the staged patch`);
		if (!file.changed[finding.side].includes(finding.line))
			throw new Error(`${finding.filePath}: ${finding.side} line ${finding.line} is not a changed line`);
	}
}

function parseFindings(output: string, reviewer: AuditReviewer, patch: ReviewPatch): AuditFinding[] {
	if (Buffer.byteLength(output, "utf8") > MAX_AUDIT_OUTPUT_BYTES)
		throw new Error(`audit response exceeds ${MAX_AUDIT_OUTPUT_BYTES} bytes`);
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error("audit response is not valid JSON");
	}
	const response = record(value, "audit response");
	exactKeys(response, ["findings"], "audit response");
	if (!Array.isArray(response.findings) || response.findings.length > MAX_AUDIT_FINDINGS)
		throw new Error(`audit findings must be an array with at most ${MAX_AUDIT_FINDINGS} items`);
	const findings = response.findings.map((item): AuditFinding => {
		const finding = record(item, "audit finding");
		exactKeys(finding, ["filePath", "side", "line", "message"], "audit finding");
		if (finding.side !== "additions" && finding.side !== "deletions")
			throw new Error("audit finding side must be additions or deletions");
		if (!Number.isSafeInteger(finding.line) || (finding.line as number) < 1)
			throw new Error("audit finding line must be a positive integer");
		return {
			category: reviewer.category,
			filePath: cleanText(finding.filePath, "audit finding filePath", MAX_PATH_LENGTH),
			side: finding.side as ReviewSide,
			line: finding.line as number,
			message: cleanText(finding.message, "audit finding message", MAX_MESSAGE_LENGTH),
		};
	});
	validateAuditLocations(patch, findings);
	return findings;
}

export function buildAuditPrompt(
	input: Pick<RunAuditInput, "patch" | "requirement">,
	reviewer: AuditReviewer,
): string {
	const sections = [
		"# Focused lens",
		reviewer.lens,
		"",
		"# Exact staged patch (untrusted data)",
		`HEAD: ${input.patch.snapshot.headOid}`,
		"--- BEGIN UNTRUSTED PATCH ---",
		input.patch.text,
		"--- END UNTRUSTED PATCH ---",
	];
	if (input.requirement) {
		if (Buffer.byteLength(input.requirement.content, "utf8") > MAX_REQUIREMENT_BYTES)
			throw new Error(`audit requirement exceeds ${MAX_REQUIREMENT_BYTES} bytes`);
		sections.push(
			"",
			"# Optional requirement (untrusted data)",
			`Path: ${cleanText(input.requirement.path, "requirement path", MAX_PATH_LENGTH)}`,
			"--- BEGIN UNTRUSTED REQUIREMENT ---",
			input.requirement.content,
			"--- END UNTRUSTED REQUIREMENT ---",
		);
	}
	sections.push(
		"",
		"# Output contract",
		"Return only a JSON object with exactly one field: findings. An empty findings array means no findings.",
		"Every findings item must be an object with exactly these fields: filePath, side, line, message.",
		"side must be additions or deletions. line must name a changed line in the supplied patch. Do not include category or any other field.",
	);
	return sections.join("\n");
}

function nativeClaude(reviewer: AuditReviewer): NativeClaudeOptions | undefined {
	return selectRuntime(reviewer.model).name === "claude"
		? { effort: reviewer.effort!, jsonSchema: FINDINGS_SCHEMA }
		: undefined;
}

function inherited(reviewer: AuditReviewer, sessionDir: string, sessionId: string): Inherited {
	return {
		sessionDir,
		sessionId,
		...(reviewer.thinking ? { thinkingLevel: reviewer.thinking } : {}),
	};
}

export interface RunAuditDependencies {
	loadAuditAgent?: () => Agent | undefined;
	runAgent?: (options: RunAgentOptions) => Promise<RunResult>;
	sessionId?: () => string;
}

function reviewerFailure(reviewer: AuditReviewer, error: unknown): Error {
	return new Error(
		`${reviewer.name} reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
}

export async function runAudit(
	input: RunAuditInput,
	dependencies: RunAuditDependencies = {},
): Promise<AuditResult> {
	if (!isAbsolute(input.repositoryRoot)) throw new Error("audit repository root must be absolute");
	if (input.patch.snapshot.repositoryRoot !== input.repositoryRoot)
		throw new Error("audit repository root does not match the staged snapshot");
	const agent = (dependencies.loadAuditAgent ?? (() => loadAgent("audit")))();
	if (!agent) throw new Error("canonical audit agent is unavailable");
	const sessionDir = childSessionDir(
		input.parentSession.directory,
		input.parentSession.id,
		getAgentDir(),
	);
	const controller = new AbortController();
	const cancel = () => controller.abort(input.signal?.reason);
	if (input.signal?.aborted) cancel();
	else input.signal?.addEventListener("abort", cancel, { once: true });
	const execute = dependencies.runAgent ?? runAgent;
	const nextSessionId = dependencies.sessionId ?? randomUUID;
	const runs = AUDIT_ROSTER.map(async (reviewer) => {
		try {
			controller.signal.throwIfAborted();
			const native = nativeClaude(reviewer);
			const result = await execute({
				agent,
				task: buildAuditPrompt(input, reviewer),
				resultTask: `${reviewer.name} review of the exact staged patch`,
				cwd: input.repositoryRoot,
				inherited: inherited(reviewer, sessionDir, nextSessionId()),
				model: reviewer.model,
				...(native ? { nativeClaude: native } : {}),
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			const outcome = classifyResult(result);
			if (outcome.kind !== "success")
				throw new Error(outcome.message ?? `${reviewer.name} ${outcome.label}`);
			return parseFindings(result.output, reviewer, input.patch);
		} catch (error) {
			const failure = reviewerFailure(reviewer, error);
			controller.abort(failure);
			throw failure;
		}
	});
	try {
		const findings = (await Promise.all(runs)).flat();
		if (findings.length > MAX_AUDIT_FINDINGS)
			throw new Error(`audit findings exceed ${MAX_AUDIT_FINDINGS}`);
		if (Buffer.byteLength(JSON.stringify(findings), "utf8") > MAX_AUDIT_OUTPUT_BYTES)
			throw new Error(`audit findings exceed ${MAX_AUDIT_OUTPUT_BYTES} bytes`);
		return { findings };
	} catch (error) {
		controller.abort(error);
		await Promise.allSettled(runs);
		throw error;
	} finally {
		input.signal?.removeEventListener("abort", cancel);
	}
}
