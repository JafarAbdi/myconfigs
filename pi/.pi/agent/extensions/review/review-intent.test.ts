import assert from "node:assert/strict";
import test from "node:test";
import type { RunAgentOptions } from "../subagent/run-agent.ts";
import type { RunResult } from "../subagent/runtimes.ts";
import {
	buildReviewIntentPrompt,
	parseReviewIntentResult,
	registerReviewIntentResultTool,
	REVIEW_INTENT_MODEL,
	REVIEW_INTENT_RESULT_TOOL,
	runReviewIntent,
	type ReviewPathInventory,
} from "./review-intent.ts";

const INVENTORY: ReviewPathInventory = {
	staged: ["src/a.ts", "src/mixed.ts"],
	unstaged: ["src/b.ts", "src/mixed.ts"],
	untracked: ["src/new.ts"],
	overall: ["src/a.ts", "src/b.ts", "src/mixed.ts", "src/new.ts"],
};

function completed(output: string): RunResult {
	return {
		agent: "review-intent",
		task: "resolve the review request",
		output,
		model: "test-provider/test-model",
		stopReason: "stop",
		steps: [],
		turns: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		durationMs: 0,
	};
}

test("the resolver prompt makes overall the natural mixed-state view", () => {
	const prompt = buildReviewIntentPrompt({
		request: "Review the complete mixed change",
		inventory: INVENTORY,
	});
	assert.match(prompt, /overall: final working tree versus HEAD, including untracked files/u);
	assert.match(prompt, /Use this for mixed staged and unstaged changes/u);
	assert.match(prompt, /when no layer is specified/u);
	assert.match(prompt, /paths to null for the whole view/u);
	assert.match(prompt, /empty paths array.*no exact path matches.*never broaden/u);
	assert.match(prompt, new RegExp(`Call ${REVIEW_INTENT_RESULT_TOOL} exactly once`));
	assert.match(prompt, /Review the complete mixed change/u);
	assert.match(prompt, /"overall": \[/u);
});

test("intent results select only exact changed files in the chosen view", () => {
	assert.deepEqual(parseReviewIntentResult(JSON.stringify({
		view: "overall",
		paths: ["src/mixed.ts", "src/new.ts", "src/mixed.ts"],
	}), INVENTORY), {
		selection: { view: "overall", paths: ["src/mixed.ts", "src/new.ts"] },
		resolvedPaths: ["src/mixed.ts", "src/new.ts"],
	});
	assert.deepEqual(parseReviewIntentResult(JSON.stringify({
		view: "staged",
		paths: null,
	}), INVENTORY), {
		selection: { view: "staged", paths: [] },
		resolvedPaths: ["src/a.ts", "src/mixed.ts"],
	});
	assert.throws(
		() => parseReviewIntentResult(JSON.stringify({ view: "overall", paths: [] }), INVENTORY),
		/did not match any changed paths/u,
	);
	assert.throws(
		() => parseReviewIntentResult(JSON.stringify({ view: "staged", paths: ["src/b.ts"] }), INVENTORY),
		/selected an unchanged path: src\/b\.ts/u,
	);
});

test("intent results reject malformed and expanded shapes", () => {
	for (const [output, error] of [
		["not json", /not valid JSON/u],
		[JSON.stringify({ view: "everything", paths: [] }), /view must be/u],
		[JSON.stringify({ view: "overall", paths: [], confidence: 1 }), /invalid fields/u],
		[JSON.stringify({ view: "overall", paths: [], requirementPath: "docs/plan.md" }), /invalid fields/u],
		[JSON.stringify({ view: "overall", paths: [], error: "No match." }), /invalid fields/u],
		[JSON.stringify({ view: "overall", paths: "src/a.ts" }), /paths must contain/u],
	] as const) assert.throws(() => parseReviewIntentResult(output, INVENTORY), error);
});

test("runReviewIntent uses one fresh structured Luna child", async () => {
	let options: RunAgentOptions | undefined;
	const result = await runReviewIntent({
		repositoryRoot: "/repository",
		request: "@src/a.ts, also check auth",
		inventory: INVENTORY,
		parentSession: { directory: "/sessions/project", id: "parent-id" },
	}, {
		agentDir: () => "/agent",
		sessionId: () => "intent-session",
		async runAgent(input) {
			options = input;
			return completed(JSON.stringify({ view: "staged", paths: ["src/a.ts", "src/mixed.ts"] }));
		},
	});
	assert.deepEqual(result, {
		selection: { view: "staged", paths: ["src/a.ts", "src/mixed.ts"] },
		resolvedPaths: ["src/a.ts", "src/mixed.ts"],
	});
	assert.equal(options?.cwd, "/repository");
	assert.equal(options?.model, REVIEW_INTENT_MODEL);
	assert.equal(options?.resultTool, REVIEW_INTENT_RESULT_TOOL);
	assert.equal(options?.resultTask, "resolve the review request");
	assert.match(options?.task ?? "", /@src\/a\.ts, also check auth/u);
	assert.deepEqual(options?.agent.tools, [REVIEW_INTENT_RESULT_TOOL]);
	assert.equal(options?.agent.skills, "none");
	assert.deepEqual(options?.inherited, {
		sessionDir: "/sessions/project/subagents/parent-id",
		sessionId: "intent-session",
		thinkingLevel: "minimal",
	});
});

test("runReviewIntent rejects oversized @ requests before invoking Luna", async () => {
	let called = false;
	await assert.rejects(runReviewIntent({
		repositoryRoot: "/repository",
		request: `@${"a".repeat(64 * 1024)}`,
		inventory: INVENTORY,
		parentSession: { directory: "/sessions/project", id: "parent-id" },
	}, {
		agentDir: () => "/agent",
		async runAgent() {
			called = true;
			return completed("");
		},
	}), /Review request exceeds 65536 bytes/u);
	assert.equal(called, false);
});

test("runReviewIntent reports child failure without accepting output", async () => {
	await assert.rejects(runReviewIntent({
		repositoryRoot: "/repository",
		request: "overall",
		inventory: INVENTORY,
		parentSession: { directory: "/sessions/project", id: "parent-id" },
	}, {
		agentDir: () => "/agent",
		async runAgent() {
			return { ...completed(""), stopReason: "error", errorMessage: "resolver unavailable" };
		},
	}), /review-intent model error.*resolver unavailable/u);
});

test("registers one terminating structured result tool", async () => {
	let tool: any;
	registerReviewIntentResultTool({
		registerTool(value: unknown) { tool = value; },
	} as never);
	assert.equal(tool.name, REVIEW_INTENT_RESULT_TOOL);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["view", "paths"]);
	assert.deepEqual(tool.parameters.required, ["view", "paths"]);
	assert.deepEqual(tool.parameters.properties.paths.type, ["array", "null"]);
	assert.equal(tool.constrainedSampling.strict, "require");
	const params = { view: "overall", paths: INVENTORY.overall };
	const result = await tool.execute("call", params);
	assert.equal(result.terminate, true);
	assert.deepEqual(result.details, params);
});
