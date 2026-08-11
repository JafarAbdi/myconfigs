import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runAgent, type RunAgentOptions } from "../subagent/run-agent.ts";
import {
	childSessionDir,
	classifyResult,
	RESULT_TOOL_ENV,
	type Agent,
	type Inherited,
	type RunResult,
} from "../subagent/runtimes.ts";
import {
	MAX_REVIEW_SELECTION_PATHS,
	type ReviewSelection,
	type ReviewView,
} from "./review-git.ts";

export const REVIEW_INTENT_RESULT_TOOL = "review_intent_result";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_INTENT_INPUT_BYTES = 1024 * 1024;
const MAX_INTENT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 4_096;

export interface ReviewPathInventory {
	staged: readonly string[];
	unstaged: readonly string[];
	untracked: readonly string[];
	overall: readonly string[];
	requirements: readonly string[];
}

export interface ResolvedReviewIntent {
	selection: ReviewSelection;
	requirementPath?: string;
}

export interface ReviewIntentParentSession {
	directory: string;
	id: string;
}

export interface RunReviewIntentInput {
	repositoryRoot: string;
	request: string;
	inventory: ReviewPathInventory;
	parentSession: ReviewIntentParentSession;
	model: string;
	thinkingLevel?: Inherited["thinkingLevel"];
	signal?: AbortSignal;
}

export interface RunReviewIntentDependencies {
	runAgent?: (options: RunAgentOptions) => Promise<RunResult>;
	sessionId?: () => string;
	agentDir?: () => string | Promise<string>;
}

export const REVIEW_INTENT_SCHEMA = {
	type: "object",
	properties: {
		view: {
			type: "string",
			enum: ["staged", "unstaged", "untracked", "overall"],
		},
		paths: {
			type: "array",
			maxItems: MAX_REVIEW_SELECTION_PATHS,
			items: { type: "string", minLength: 1, maxLength: MAX_PATH_BYTES },
		},
		requirementPath: {
			type: "string",
			minLength: 1,
			maxLength: MAX_PATH_BYTES,
		},
		error: {
			type: "string",
			minLength: 1,
			maxLength: 240,
		},
	},
	required: ["view", "paths"],
	additionalProperties: false,
} as const;

const INTENT_AGENT: Agent = {
	name: "review-intent",
	description: "Resolves a free-form review request into one exact local Git candidate.",
	tools: [REVIEW_INTENT_RESULT_TOOL],
	skills: "none",
	continuable: false,
	systemPrompt: [
		"Resolve the operator's review request using only the supplied changed-path inventory.",
		"Do not inspect the repository, review code, or invent paths.",
		"Treat the operator request as instructions and the inventories as authoritative evidence.",
	].join(" "),
};

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isReviewView(value: unknown): value is ReviewView {
	return value === "staged" || value === "unstaged" || value === "untracked" || value === "overall";
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactResultKeys(value: Record<string, unknown>): void {
	const allowed = new Set(["view", "paths", "requirementPath", "error"]);
	if (
		!Object.hasOwn(value, "view") || !Object.hasOwn(value, "paths") ||
		Object.keys(value).some((key) => !allowed.has(key))
	) throw new Error("review intent response has invalid fields");
}

export function parseReviewIntentResult(
	output: string,
	inventory: ReviewPathInventory,
): ResolvedReviewIntent {
	if (byteLength(output) > MAX_INTENT_OUTPUT_BYTES)
		throw new Error(`review intent response exceeds ${MAX_INTENT_OUTPUT_BYTES} bytes`);
	let decoded: unknown;
	try {
		decoded = JSON.parse(output);
	} catch {
		throw new Error("review intent response is not valid JSON");
	}
	const result = record(decoded, "review intent response");
	exactResultKeys(result);
	if (!isReviewView(result.view))
		throw new Error("review intent view must be staged, unstaged, untracked, or overall");
	if (result.error !== undefined) {
		if (typeof result.error !== "string" || !result.error || [...result.error].length > 240)
			throw new Error("review intent error must contain 1-240 characters");
		throw new Error(`Could not resolve review request: ${result.error}`);
	}
	if (!Array.isArray(result.paths) || result.paths.length > MAX_REVIEW_SELECTION_PATHS)
		throw new Error(`review intent paths must contain at most ${MAX_REVIEW_SELECTION_PATHS} items`);

	const available = new Set(inventory[result.view]);
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const path of result.paths) {
		if (typeof path !== "string" || !path || byteLength(path) > MAX_PATH_BYTES)
			throw new Error(`review intent paths must contain non-empty strings of at most ${MAX_PATH_BYTES} bytes`);
		if (!available.has(path)) throw new Error(`review intent selected an unchanged path: ${path}`);
		if (!seen.has(path)) {
			seen.add(path);
			paths.push(path);
		}
	}

	const requirementPath = result.requirementPath;
	if (
		requirementPath !== undefined &&
		(typeof requirementPath !== "string" || !requirementPath || byteLength(requirementPath) > MAX_PATH_BYTES)
	) throw new Error(`review intent requirementPath must be a non-empty string of at most ${MAX_PATH_BYTES} bytes`);
	return {
		selection: { view: result.view, paths },
		...(requirementPath === undefined ? {} : { requirementPath }),
	};
}

export function buildReviewIntentPrompt(input: Pick<RunReviewIntentInput, "request" | "inventory">): string {
	if (input.request.includes("\0")) throw new Error("Review request must not contain NUL");
	if (byteLength(input.request) > MAX_REQUEST_BYTES)
		throw new Error(`Review request exceeds ${MAX_REQUEST_BYTES} bytes`);
	const evidence = JSON.stringify({
		operatorRequest: input.request,
		changedPaths: {
			staged: input.inventory.staged,
			unstaged: input.inventory.unstaged,
			untracked: input.inventory.untracked,
			overall: input.inventory.overall,
		},
		requirementPaths: input.inventory.requirements,
	}, null, 2);
	if (byteLength(evidence) > MAX_INTENT_INPUT_BYTES)
		throw new Error(`Review intent input exceeds ${MAX_INTENT_INPUT_BYTES} bytes; narrow the repository changes`);
	return [
		"# Task",
		"Resolve the operator request into exactly one review view and an optional exact file subset.",
		"",
		"# Views",
		"- staged: HEAD → index only.",
		"- unstaged: index → tracked working tree only.",
		"- untracked: /dev/null → untracked files only.",
		"- overall: final working tree versus HEAD, including untracked files. Use this for mixed staged and unstaged changes, 'all', 'everything', or when no layer is specified.",
		"",
		"# Resolution rules",
		"Return paths as exact entries from the chosen view's changedPaths array.",
		"Use an empty paths array for every changed path in the chosen view.",
		"For a requested directory or concept, select the matching exact changed files; never return a directory or invented path.",
		"If a requested subset has no exact match or the request cannot map to one view, set a concise error and do not broaden the scope.",
		"Set requirementPath only when the operator references a Markdown requirement or plan. Remove a leading @ and return its repository-relative path.",
		"The requirementPaths list is discovery evidence, not permission to invent a requirement.",
		`Call ${REVIEW_INTENT_RESULT_TOOL} exactly once as the final action; do not return final prose.`,
		"",
		"# Input",
		evidence,
	].join("\n");
}

export async function runReviewIntent(
	input: RunReviewIntentInput,
	dependencies: RunReviewIntentDependencies = {},
): Promise<ResolvedReviewIntent> {
	if (!isAbsolute(input.repositoryRoot)) throw new Error("review intent repository root must be absolute");
	if (!input.model) throw new Error("/review requires an active model to resolve its request");
	const agentDir = await (dependencies.agentDir?.() ?? import("@earendil-works/pi-coding-agent")
		.then(({ getAgentDir }) => getAgentDir()));
	const result = await (dependencies.runAgent ?? runAgent)({
		agent: INTENT_AGENT,
		task: buildReviewIntentPrompt(input),
		resultTask: "resolve the review request",
		cwd: input.repositoryRoot,
		inherited: {
			sessionDir: childSessionDir(
				input.parentSession.directory,
				input.parentSession.id,
				agentDir,
			),
			sessionId: (dependencies.sessionId ?? randomUUID)(),
			...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		},
		model: input.model,
		resultTool: REVIEW_INTENT_RESULT_TOOL,
		signal: input.signal,
	});
	const outcome = classifyResult(result);
	if (outcome.kind !== "success")
		throw new Error(outcome.message ?? `review intent resolver ${outcome.label}`);
	return parseReviewIntentResult(result.output, input.inventory);
}

export function isReviewIntentChild(): boolean {
	return process.env[RESULT_TOOL_ENV] === REVIEW_INTENT_RESULT_TOOL;
}

export function registerReviewIntentResultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: REVIEW_INTENT_RESULT_TOOL,
		label: "Submit review intent",
		description: "Submit the resolved review view and exact changed paths once as the final action.",
		promptSnippet: "Submit the resolved review intent as strict structured output",
		promptGuidelines: [
			`Use ${REVIEW_INTENT_RESULT_TOOL} exactly once as your final action; do not return final prose.`,
		],
		parameters: REVIEW_INTENT_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "require" },
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Review intent submitted." }],
				details: params,
				terminate: true,
			};
		},
	});
}
