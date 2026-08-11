import assert from "node:assert/strict";
import test from "node:test";
import type { RunAgentOptions } from "../subagent/run-agent.ts";
import type { RunResult } from "../subagent/runtimes.ts";
import {
	buildReviewIntentPrompt,
	parseReviewIntentResult,
	registerReviewIntentResultTool,
	REVIEW_INTENT_RESULT_TOOL,
	runReviewIntent,
	type ReviewPathInventory,
} from "./review-intent.ts";

const INVENTORY: ReviewPathInventory = {
	staged: ["src/a.ts", "src/mixed.ts"],
	unstaged: ["src/b.ts", "src/mixed.ts"],
	untracked: ["src/new.ts"],
	overall: ["src/a.ts", "src/b.ts", "src/mixed.ts", "src/new.ts"],
	requirements: ["docs/plan.md"],
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
		request: "Review @docs/plan.md and the complete mixed change",
		inventory: INVENTORY,
	});
	assert.match(prompt, /overall: final working tree versus HEAD, including untracked files/u);
	assert.match(prompt, /Use this for mixed staged and unstaged changes/u);
	assert.match(prompt, /when no layer is specified/u);
	assert.match(prompt, /no exact match.*set a concise error.*do not broaden the scope/u);
	assert.match(prompt, new RegExp(`Call ${REVIEW_INTENT_RESULT_TOOL} exactly once`));
	assert.match(prompt, /Review @docs\/plan\.md and the complete mixed change/u);
	assert.match(prompt, /"overall": \[/u);
	assert.match(prompt, /"docs\/plan\.md"/u);
});

test("intent results select only exact changed files in the chosen view", () => {
	assert.deepEqual(parseReviewIntentResult(JSON.stringify({
		view: "overall",
		paths: ["src/mixed.ts", "src/new.ts", "src/mixed.ts"],
		requirementPath: "docs/plan.md",
	}), INVENTORY), {
		selection: { view: "overall", paths: ["src/mixed.ts", "src/new.ts"] },
		requirementPath: "docs/plan.md",
	});
	assert.deepEqual(parseReviewIntentResult(JSON.stringify({
		view: "staged",
		paths: [],
	}), INVENTORY), {
		selection: { view: "staged", paths: [] },
	});
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
		[JSON.stringify({ view: "overall", paths: "src/a.ts" }), /paths must contain/u],
		[JSON.stringify({ view: "overall", paths: [], error: "No changed auth path matched." }), /Could not resolve review request: No changed auth path matched\./u],
	] as const) assert.throws(() => parseReviewIntentResult(output, INVENTORY), error);
});

test("runReviewIntent uses one fresh structured child with the active model", async () => {
	let options: RunAgentOptions | undefined;
	const result = await runReviewIntent({
		repositoryRoot: "/repository",
		request: "staged only",
		inventory: INVENTORY,
		parentSession: { directory: "/sessions/project", id: "parent-id" },
		model: "test-provider/test-model",
		thinkingLevel: "high",
	}, {
		agentDir: () => "/agent",
		sessionId: () => "intent-session",
		async runAgent(input) {
			options = input;
			return completed(JSON.stringify({ view: "staged", paths: [] }));
		},
	});
	assert.deepEqual(result, { selection: { view: "staged", paths: [] } });
	assert.equal(options?.cwd, "/repository");
	assert.equal(options?.model, "test-provider/test-model");
	assert.equal(options?.resultTool, REVIEW_INTENT_RESULT_TOOL);
	assert.equal(options?.resultTask, "resolve the review request");
	assert.deepEqual(options?.agent.tools, [REVIEW_INTENT_RESULT_TOOL]);
	assert.equal(options?.agent.skills, "none");
	assert.deepEqual(options?.inherited, {
		sessionDir: "/sessions/project/subagents/parent-id",
		sessionId: "intent-session",
		thinkingLevel: "high",
	});
});

test("runReviewIntent reports child failure without accepting output", async () => {
	await assert.rejects(runReviewIntent({
		repositoryRoot: "/repository",
		request: "overall",
		inventory: INVENTORY,
		parentSession: { directory: "/sessions/project", id: "parent-id" },
		model: "test-provider/test-model",
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
	assert.equal(tool.constrainedSampling.strict, "require");
	const result = await tool.execute("call", { view: "overall", paths: [] });
	assert.equal(result.terminate, true);
	assert.deepEqual(result.details, { view: "overall", paths: [] });
});
