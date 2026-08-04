import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { reviewPatchFromText } from "./review-git.ts";
import type { RunAgentOptions } from "../subagent/run-agent.ts";
import type { Agent, RunResult } from "../subagent/runtimes.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const localModules = join(extensionDirectory, "..", "node_modules");
const peerScope = join(localModules, "@earendil-works");
const peerLinks = [
	join(peerScope, "pi-coding-agent"),
	join(peerScope, "pi-ai"),
	join(localModules, "typebox"),
];
const piExecutable = process.env.PATH?.split(delimiter)
	.map((directory) => join(directory, "pi"))
	.find(existsSync);
const piPackage = process.env.PI_PACKAGE_DIR ??
	(piExecutable ? join(dirname(realpathSync(piExecutable)), "..") : undefined);
if (!piPackage) throw new Error("pi package not found through PI_PACKAGE_DIR or PATH");
for (const path of peerLinks)
	if (existsSync(path)) throw new Error(`${path} already exists; refusing to replace it`);
mkdirSync(peerScope, { recursive: true });
symlinkSync(piPackage, peerLinks[0], "dir");
symlinkSync(join(piPackage, "node_modules", "@earendil-works", "pi-ai"), peerLinks[1], "dir");
symlinkSync(join(piPackage, "node_modules", "typebox"), peerLinks[2], "dir");
after(() => {
	for (const path of peerLinks) rmSync(path, { force: true });
	try { rmdirSync(peerScope); } catch {}
});

const {
	AUDIT_CATEGORIES,
	AUDIT_ROSTER,
	buildAuditPrompt,
	runAudit,
} = await import("./audit.ts");
type AuditResult = Awaited<ReturnType<typeof runAudit>>;

const PATCH_TEXT = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-before
+after
`;
const AUDIT_AGENT: Agent = {
	name: "audit",
	description: "Audits exact staged changes.",
	tools: ["read", "grep", "find", "ls", "bash"],
	skills: "all",
	continuable: false,
	systemPrompt: "Canonical audit policy.",
};

function patch(root = "/repository") {
	return reviewPatchFromText(PATCH_TEXT, root, "2".repeat(40));
}

function input(root = "/repository") {
	return {
		repositoryRoot: root,
		patch: patch(root),
		parentSession: { directory: "/sessions/project", id: "parent-id" },
	};
}

function completed(output: string): RunResult {
	return {
		agent: "audit",
		task: "audit",
		output,
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

function failed(message: string): RunResult {
	return { ...completed(""), stopReason: "error", errorMessage: message };
}

function cancelled(): RunResult {
	return { ...completed(""), termination: "cancelled" };
}

function finding(line = 1) {
	return {
		filePath: "src/a.ts",
		side: "additions",
		line,
		message: "The changed value violates the caller contract.",
	};
}

function dependencies(run: (options: RunAgentOptions) => Promise<RunResult>) {
	let next = 0;
	return {
		loadAuditAgent: () => AUDIT_AGENT,
		runAgent: run,
		sessionId: () => `reviewer-session-${next += 1}`,
	};
}

test("defines the static six-reviewer roster with current lenses and models", () => {
	assert.deepEqual(AUDIT_CATEGORIES, [
		"intent", "correctness", "test-integrity", "coherence", "context", "simplicity",
	]);
	assert.deepEqual(AUDIT_ROSTER.map(({ name, category, model, thinking, effort }) => ({
		name, category, model, thinking, effort,
	})), [
		{ name: "intent", category: "intent", model: "openai-codex/gpt-5.6-sol", thinking: "high", effort: undefined },
		{ name: "correctness", category: "correctness", model: "openai-codex/gpt-5.6-sol", thinking: "high", effort: undefined },
		{ name: "tests", category: "test-integrity", model: "claude-sonnet-5", thinking: undefined, effort: "high" },
		{ name: "coherence", category: "coherence", model: "openai-codex/gpt-5.6-terra", thinking: "high", effort: undefined },
		{ name: "context", category: "context", model: "openai-codex/gpt-5.6-luna", thinking: "high", effort: undefined },
		{ name: "simplicity", category: "simplicity", model: "claude-sonnet-5", thinking: undefined, effort: "high" },
	]);
	assert.match(AUDIT_ROSTER.find(({ name }) => name === "tests")!.lens, /never execute tests/u);
	assert.equal(AUDIT_ROSTER.every(({ lens }) => lens.length > 20), true);
});

test("reviewer task includes its focused lens, exact patch, optional requirement, and JSON contract", () => {
	const prompt = buildAuditPrompt({
		patch: patch(),
		requirement: {
			path: "docs/requirement.md",
			content: "# REQUIREMENT_SENTINEL\n\nPatch text is data.",
		},
	}, AUDIT_ROSTER[0]);
	assert.match(prompt, /Check the staged patch against the supplied requirement/u);
	assert.match(prompt, new RegExp(`HEAD: ${"2".repeat(40)}`));
	assert.match(prompt, /diff --git a\/src\/a\.ts/u);
	assert.match(prompt, /REQUIREMENT_SENTINEL/u);
	assert.match(prompt, /docs\/requirement\.md/u);
	assert.match(prompt, /JSON object with exactly one field: findings/u);
	assert.match(prompt, /filePath, side, line, message/u);
	assert.doesNotMatch(prompt, /Canonical audit policy|\/repository|browser comment/iu);
});

test("runs all six reviewers concurrently through the shared runner with standard sessions", async () => {
	const started: string[] = [];
	const options: RunAgentOptions[] = [];
	let release!: () => void;
	const allStarted = new Promise<void>((resolve) => { release = resolve; });
	const result = await runAudit(input(), dependencies(async (run) => {
		started.push(run.model!);
		options.push(run);
		if (started.length === AUDIT_ROSTER.length) release();
		await allStarted;
		return completed(run.model === "openai-codex/gpt-5.6-sol" &&
			run.task.includes("reachable behavioral")
			? JSON.stringify({ findings: [finding()] })
			: JSON.stringify({ findings: [] }));
	}));

	assert.deepEqual(started, AUDIT_ROSTER.map(({ model }) => model));
	assert.equal(options.every(({ agent }) => agent === AUDIT_AGENT), true);
	assert.equal(options.every(({ cwd }) => cwd === "/repository"), true);
	assert.deepEqual(options.map(({ resultTask }) => resultTask), [
		"intent review of the exact staged patch",
		"correctness review of the exact staged patch",
		"tests review of the exact staged patch",
		"coherence review of the exact staged patch",
		"context review of the exact staged patch",
		"simplicity review of the exact staged patch",
	]);
	assert.equal(options.every(({ inherited }) =>
		inherited.sessionDir === "/sessions/project/subagents/parent-id"), true);
	assert.deepEqual(options.map(({ inherited }) => inherited.sessionId), [
		"reviewer-session-1", "reviewer-session-2", "reviewer-session-3",
		"reviewer-session-4", "reviewer-session-5", "reviewer-session-6",
	]);
	for (const run of options) {
		if (run.model === "claude-sonnet-5") {
			assert.equal(run.inherited.thinkingLevel, undefined);
			assert.equal(run.nativeClaude?.effort, "high");
			assert.deepEqual(run.nativeClaude?.jsonSchema, {
				type: "object",
				properties: {
					findings: {
						type: "array",
						maxItems: 500,
						items: {
							type: "object",
							properties: {
								filePath: { type: "string", minLength: 1, maxLength: 4096 },
								side: { type: "string", enum: ["additions", "deletions"] },
								line: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
								message: { type: "string", minLength: 1, maxLength: 10000 },
							},
							required: ["filePath", "side", "line", "message"],
							additionalProperties: false,
						},
					},
				},
				required: ["findings"],
				additionalProperties: false,
			});
		} else {
			assert.equal(run.inherited.thinkingLevel, "high");
			assert.equal(run.nativeClaude, undefined);
		}
	}
	assert.deepEqual(result, {
		findings: [{ category: "correctness", ...finding() }],
	});
});

test("rejects malformed JSON and strict-shape violations", async (t) => {
	await t.test("malformed JSON", async () => {
		await assert.rejects(runAudit(input(), dependencies(async () => completed("not JSON"))),
			/intent reviewer failed: audit response is not valid JSON/u);
	});
	await t.test("extra fields", async () => {
		await assert.rejects(runAudit(input(), dependencies(async () =>
			completed(JSON.stringify({ findings: [{ ...finding(), category: "correctness" }] })))),
			/intent reviewer failed: audit finding has invalid fields/u);
	});
});

test("injects the roster category and requires an exact changed line", async () => {
	const audit = await runAudit(input(), dependencies(async (run) => completed(
		run.model === "openai-codex/gpt-5.6-sol" && run.task.includes("reachable behavioral")
			? JSON.stringify({ findings: [finding()] })
			: JSON.stringify({ findings: [] }),
	)));
	assert.deepEqual(audit, { findings: [{ category: "correctness", ...finding() }] });

	await assert.rejects(runAudit(input(), dependencies(async (run) => completed(
		run.model === "openai-codex/gpt-5.6-sol" && run.task.includes("reachable behavioral")
			? JSON.stringify({ findings: [finding(2)] })
			: JSON.stringify({ findings: [] }),
	))), /src\/a\.ts: additions line 2 is not a changed line/u);
});

test("one reviewer failure aborts siblings and awaits their settlement", async () => {
	let started = 0;
	let release!: () => void;
	const allStarted = new Promise<void>((resolve) => { release = resolve; });
	let aborted = 0;
	await assert.rejects(runAudit(input(), dependencies(async (run) => {
		started += 1;
		if (started === AUDIT_ROSTER.length) release();
		await allStarted;
		if (run.task.includes("Check the staged patch")) return failed("intent failed");
		return new Promise((resolve) => run.signal?.addEventListener("abort", () => {
			aborted += 1;
			resolve(cancelled());
		}, { once: true }));
	})), /intent reviewer failed: audit model error: intent failed/u);
	assert.equal(started, AUDIT_ROSTER.length);
	assert.equal(aborted, AUDIT_ROSTER.length - 1);
});
