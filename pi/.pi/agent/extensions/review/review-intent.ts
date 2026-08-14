import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runAgent, type RunAgentOptions } from "../subagent/run-agent.ts";
import {
	childSessionDir,
	classifyResult,
	RESULT_TOOL_ENV,
	type Agent,
	type RunResult,
} from "../subagent/runtimes.ts";
import {
	MAX_REVIEW_SELECTION_PATHS,
	type ReviewSelection,
	type ReviewView,
} from "./review-git.ts";

export const REVIEW_INTENT_RESULT_TOOL = "review_intent_result";
export const REVIEW_INTENT_MODEL = "openai-codex/gpt-5.6-luna";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_INTENT_INPUT_BYTES = 1024 * 1024;
const MAX_INTENT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 4_096;

export interface ReviewPathInventory {
	staged: readonly string[];
	unstaged: readonly string[];
	untracked: readonly string[];
	overall: readonly string[];
}

export interface ResolvedReviewIntent {
	selection: ReviewSelection;
	resolvedPaths: string[];
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
			type: ["array", "null"],
			maxItems: MAX_REVIEW_SELECTION_PATHS,
			items: { type: "string", minLength: 1, maxLength: MAX_PATH_BYTES },
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

interface ReviewIntentResultPayload {
	view: ReviewView;
	paths: string[] | null;
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
	if (decoded === null || decoded === undefined || Array.isArray(decoded) || decoded.constructor !== Object)
		throw new Error("review intent response must be an object");
	// SAFETY: the key and field checks below validate this shape before any value is read.
	const result = decoded as ReviewIntentResultPayload;
	if (
		Object.keys(result).length !== 2 ||
		!Object.hasOwn(result, "view") || !Object.hasOwn(result, "paths")
	) throw new Error("review intent response has invalid fields");
	if (
		result.view !== "staged" && result.view !== "unstaged" &&
		result.view !== "untracked" && result.view !== "overall"
	) throw new Error("review intent view must be staged, unstaged, untracked, or overall");
	if (result.paths === null) return {
		selection: { view: result.view, paths: [] },
		resolvedPaths: [...inventory[result.view]],
	};
	if (!Array.isArray(result.paths) || result.paths.length > MAX_REVIEW_SELECTION_PATHS)
		throw new Error(`review intent paths must contain at most ${MAX_REVIEW_SELECTION_PATHS} items`);
	if (result.paths.length === 0)
		throw new Error("review request did not match any changed paths");

	const available = new Set(inventory[result.view]);
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const path of result.paths) {
		if (path?.constructor !== String || !path || byteLength(path) > MAX_PATH_BYTES)
			throw new Error(`review intent paths must contain non-empty strings of at most ${MAX_PATH_BYTES} bytes`);
		if (!available.has(path)) throw new Error(`review intent selected an unchanged path: ${path}`);
		if (!seen.has(path)) {
			seen.add(path);
			paths.push(path);
		}
	}

	return { selection: { view: result.view, paths }, resolvedPaths: [...paths] };
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
		"Return selected files as exact entries from the chosen view's changedPaths array.",
		"Set paths to null for the whole view.",
		"For a requested directory or concept, select the matching exact changed files; never return a directory or invented path.",
		"Return an empty paths array when no exact path matches or the request cannot map to one view; never broaden the scope.",
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
			thinkingLevel: "minimal",
		},
		model: REVIEW_INTENT_MODEL,
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
