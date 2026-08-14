import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunAgentOptions } from "../subagent/run-agent.ts";
import type { RunResult } from "../subagent/runtimes.ts";
import type { AuditFinding } from "./audit.ts";
import { MAX_AUDIT_FINDINGS } from "./audit-output.ts";
import { reviewPatchFromText } from "./review-git.ts";
import {
	buildReviewSynthesisPrompt,
	MAX_REVIEW_SYNTHESIS_OUTPUT_BYTES,
	MAX_REVIEW_SYNTHESIS_PROMPT_BYTES,
	REVIEW_SYNTHESIS_MODEL,
	REVIEW_SYNTHESIS_SCHEMA,
	runReviewSynthesis,
	type RunReviewSynthesisInput,
} from "./review-synthesis.ts";
import type { WiffComment } from "./review-wiff.ts";

const PATCH_TEXT = `diff --git a/src/a.ts b/src/a.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-before
+after
`;

function patch(root = "/repository") {
	return reviewPatchFromText(PATCH_TEXT, root, "2".repeat(40), {
		view: "staged",
		paths: ["src/a.ts", "src/b.ts"],
	});
}

function finding(index: number): AuditFinding {
	return {
		category: index === 1 ? "contract" : index === 2 ? "correctness" : "test-integrity",
		filePath: `src/${index}.ts`,
		side: "additions",
		line: index,
		message: `Candidate defect ${index}; concrete consequence ${index}.`,
	};
}

function comment(overrides: Partial<WiffComment> = {}): WiffComment {
	return {
		id: "01J00000000000000000000001",
		number: 1,
		body: "The existing open comment describes defect one.",
		target: {
			target: "lines",
			file: "src/a.ts",
			side: "after",
			startLine: 1,
			endLine: 1,
		},
		resolved: false,
		deleted: false,
		author: { name: "reviewer", kind: "human" },
		...overrides,
	};
}

function input(candidates: readonly AuditFinding[] = [finding(1), finding(2)]): RunReviewSynthesisInput {
	return {
		repositoryRoot: "/repository",
		patch: patch(),
		candidates,
		openComments: [],
		parentSession: { directory: "/sessions/project", id: "parent-id" },
	};
}

function completed(output: string): RunResult {
	return {
		agent: "review-synthesis",
		task: "synthesize audit findings for the exact candidate patch",
		output,
		model: REVIEW_SYNTHESIS_MODEL,
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

async function synthesize(
	output: string,
	candidates: readonly AuditFinding[] = [finding(1), finding(2)],
) {
	return runReviewSynthesis(input(candidates), {
		agentDir: () => "/agent",
		sessionId: () => "synthesis-session",
		runAgent: async () => completed(output),
	});
}

test("runs one fresh native Sonnet synthesis with no tools or skills", async () => {
	const candidates = [finding(1), finding(2)];
	const controller = new AbortController();
	let options: RunAgentOptions | undefined;
	let calls = 0;
	const selected = await runReviewSynthesis({
		...input(candidates),
		parentSession: { directory: "", id: "parent-id" },
		signal: controller.signal,
		openComments: [
			comment(),
			comment({ id: "resolved", number: 2, body: "RESOLVED_BODY_MUST_NOT_APPEAR", resolved: true }),
			comment({ id: "deleted", number: 3, body: "DELETED_BODY_MUST_NOT_APPEAR", deleted: true }),
			comment({
				id: "reply",
				number: 4,
				body: "REPLY_BODY_MUST_NOT_APPEAR",
				target: { target: "comment", id: "01J00000000000000000000001" },
			}),
		],
	}, {
		agentDir: () => "/agent",
		sessionId: () => "synthesis-session",
		async runAgent(run) {
			calls += 1;
			options = run;
			return completed(JSON.stringify({
				selected: [{ candidateId: "candidate-1", confidence: 91 }],
			}));
		},
	});

	assert.equal(calls, 1);
	assert.deepEqual(selected, [candidates[0]]);
	assert.equal(options?.cwd, "/repository");
	assert.equal(options?.model, REVIEW_SYNTHESIS_MODEL);
	assert.equal(options?.resultTask, "synthesize audit findings for the exact candidate patch");
	assert.equal(options?.resultTool, undefined);
	assert.equal(options?.signal, controller.signal);
	assert.deepEqual(options?.agent.tools, []);
	assert.equal(options?.agent.skills, "none");
	assert.equal(options?.agent.continuable, false);
	assert.deepEqual(options?.nativeClaude, {
		effort: "high",
		jsonSchema: REVIEW_SYNTHESIS_SCHEMA,
	});
	assert.deepEqual(options?.inherited, {
		sessionDir: "/agent/sessions/subagents/parent-id",
		sessionId: "synthesis-session",
	});

	const prompt = options?.task ?? "";
	assert.match(prompt, /"repositoryRoot": "\/repository"/u);
	assert.match(prompt, new RegExp(`"headOid": "${"2".repeat(40)}"`));
	assert.match(prompt, /"view": "staged"/u);
	assert.match(prompt, /"orderedPaths": \[[\s\S]*"src\/a\.ts"[\s\S]*"src\/b\.ts"/u);
	assert.match(prompt, /Candidate defect 1[\s\S]*candidate-1[\s\S]*Candidate defect 2[\s\S]*candidate-2/u);
	assert.match(prompt, /The existing open comment describes defect one\./u);
	assert.doesNotMatch(prompt, /RESOLVED_BODY_MUST_NOT_APPEAR|DELETED_BODY_MUST_NOT_APPEAR|REPLY_BODY_MUST_NOT_APPEAR/u);
	assert.match(prompt, /diff --git a\/src\/a\.ts b\/src\/a\.ts/u);
	assert.match(prompt, /Recheck every candidate defect against the exact patch/u);
	assert.match(prompt, /same underlying defect and consequence/u);
	assert.match(prompt, /choose exactly one existing candidateId from that group/iu);
	assert.match(prompt, /A nearby or related comment is not equivalent/u);
	assert.match(prompt, /0: Not confident at all\. This is a false positive that doesn't stand up to light scrutiny, or is a pre-existing issue\./u);
	assert.match(prompt, /25: Somewhat confident\.[\s\S]*relevant CLAUDE\.md\./u);
	assert.match(prompt, /50: Moderately confident\.[\s\S]*it's not very important\./u);
	assert.match(prompt, /75: Highly confident\.[\s\S]*relevant CLAUDE\.md\./u);
	assert.match(prompt, /100: Absolutely certain\.[\s\S]*The evidence directly confirms this\./u);
	assert.match(prompt, /exactly candidateId and confidence[\s\S]*no prose/u);
});

test("defines a strict bounded synthesis schema", () => {
	assert.equal(REVIEW_SYNTHESIS_SCHEMA.additionalProperties, false);
	assert.deepEqual(REVIEW_SYNTHESIS_SCHEMA.required, ["selected"]);
	assert.equal(REVIEW_SYNTHESIS_SCHEMA.properties.selected.maxItems, MAX_AUDIT_FINDINGS);
	const item = REVIEW_SYNTHESIS_SCHEMA.properties.selected.items;
	assert.deepEqual(item.required, ["candidateId", "confidence"]);
	assert.equal(item.additionalProperties, false);
	assert.equal(item.properties.confidence.type, "integer");
	assert.equal(item.properties.confidence.minimum, 0);
	assert.equal(item.properties.confidence.maximum, 100);
});

test("rejects duplicate and unknown candidate IDs", async (t) => {
	await t.test("duplicate", async () => {
		await assert.rejects(synthesize(JSON.stringify({
			selected: [
				{ candidateId: "candidate-1", confidence: 90 },
				{ candidateId: "candidate-1", confidence: 80 },
			],
		})), /duplicate candidate ID: candidate-1/u);
	});
	await t.test("unknown", async () => {
		await assert.rejects(synthesize(JSON.stringify({
			selected: [{ candidateId: "candidate-99", confidence: 90 }],
		})), /unknown candidate ID: candidate-99/u);
	});
});

test("rejects malformed output and extra fields", async () => {
	for (const [output, error] of [
		["not JSON", /not valid JSON/u],
		["[]", /response must be an object/u],
		[JSON.stringify({ selected: [], prose: "done" }), /response has invalid fields/u],
		[JSON.stringify({ selected: "candidate-1" }), /selected must be an array/u],
		[JSON.stringify({ selected: [{ candidateId: "candidate-1" }] }), /selection has invalid fields/u],
		[JSON.stringify({ selected: [{ candidateId: "candidate-1", confidence: 90, message: "new" }] }), /selection has invalid fields/u],
	] as const) await assert.rejects(synthesize(output), error);
});

test("enforces selection and response bounds", async () => {
	await assert.rejects(synthesize(JSON.stringify({
		selected: [
			{ candidateId: "candidate-1", confidence: 90 },
			{ candidateId: "candidate-2", confidence: 90 },
		],
	}), [finding(1)]), /selection count exceeds candidate count/u);

	const candidates = Array.from({ length: MAX_AUDIT_FINDINGS }, (_, index) => finding(index + 1));
	const selected = Array.from({ length: MAX_AUDIT_FINDINGS + 1 }, (_, index) => ({
		candidateId: `candidate-${index + 1}`,
		confidence: 90,
	}));
	await assert.rejects(synthesize(JSON.stringify({ selected }), candidates), /selection count exceeds audit maximum/u);
	await assert.rejects(
		synthesize("x".repeat(MAX_REVIEW_SYNTHESIS_OUTPUT_BYTES + 1)),
		/response exceeds 65536 bytes/u,
	);
});

test("rejects non-integer and out-of-range confidence scores", async () => {
	for (const confidence of [-1, 1.5, 101, "80", null]) {
		await assert.rejects(synthesize(JSON.stringify({
			selected: [{ candidateId: "candidate-1", confidence }],
		})), /confidence must be an integer from 0 through 100/u);
	}
});

test("drops 79, keeps 80, and restores original candidate order", async () => {
	const candidates = [finding(1), finding(2), finding(3)];
	const selected = await synthesize(JSON.stringify({
		selected: [
			{ candidateId: "candidate-3", confidence: 80 },
			{ candidateId: "candidate-1", confidence: 79 },
			{ candidateId: "candidate-2", confidence: 100 },
		],
	}), candidates);
	assert.deepEqual(selected, [candidates[1], candidates[2]]);
});

test("requires an absolute repository root matching the snapshot", async () => {
	let called = false;
	const dependencies = {
		agentDir: () => "/agent",
		async runAgent() {
			called = true;
			return completed(JSON.stringify({ selected: [] }));
		},
	};
	await assert.rejects(runReviewSynthesis({
		...input(),
		repositoryRoot: "repository",
	}, dependencies), /repository root must be absolute/u);
	await assert.rejects(runReviewSynthesis({
		...input(),
		repositoryRoot: "/other",
	}, dependencies), /repository root does not match the candidate snapshot/u);
	assert.equal(called, false);
});

test("propagates synthesis failure and cancellation", async (t) => {
	await t.test("model failure", async () => {
		await assert.rejects(runReviewSynthesis(input(), {
			agentDir: () => "/agent",
			runAgent: async () => ({
				...completed(""),
				stopReason: "error",
				errorMessage: "synthesizer unavailable",
			}),
		}), /review-synthesis model error.*synthesizer unavailable/u);
	});
	await t.test("cancelled result", async () => {
		await assert.rejects(runReviewSynthesis(input(), {
			agentDir: () => "/agent",
			runAgent: async () => ({ ...completed(""), termination: "cancelled" }),
		}), /review-synthesis was cancelled/u);
	});
	await t.test("pre-cancelled signal", async () => {
		const controller = new AbortController();
		controller.abort(new Error("operator cancelled synthesis"));
		let called = false;
		await assert.rejects(runReviewSynthesis({
			...input(),
			signal: controller.signal,
		}, {
			agentDir: () => "/agent",
			async runAgent() {
				called = true;
				return completed(JSON.stringify({ selected: [] }));
			},
		}), /operator cancelled synthesis/u);
		assert.equal(called, false);
	});
});

test("rejects a complete oversized prompt before starting Sonnet", async () => {
	let called = false;
	const oversizedComment = comment({ body: "x".repeat(MAX_REVIEW_SYNTHESIS_PROMPT_BYTES) });
	await assert.rejects(runReviewSynthesis({
		...input(),
		openComments: [oversizedComment],
	}, {
		agentDir: () => "/agent",
		async runAgent() {
			called = true;
			return completed(JSON.stringify({ selected: [] }));
		},
	}), new RegExp(`prompt exceeds ${MAX_REVIEW_SYNTHESIS_PROMPT_BYTES} bytes`, "u"));
	assert.equal(called, false);
});

test("rejects patch text that is not the immutable snapshot bytes", () => {
	const exact = patch();
	assert.throws(() => buildReviewSynthesisPrompt({
		patch: { ...exact, text: `${exact.text}changed` },
		candidates: [],
		openComments: [],
	}), /patch text does not match its exact snapshot bytes/u);
});
