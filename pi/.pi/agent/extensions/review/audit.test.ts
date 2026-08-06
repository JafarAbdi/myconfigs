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
import { AUDIT_CATEGORIES, AUDIT_ROSTER } from "./audit-roster.ts";
import { AUDIT_RESULT_TOOL, FINDINGS_SCHEMA } from "./audit-output.ts";
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
	buildAuditPrompt,
	runAudit,
} = await import("./audit.ts");
type AuditResult = Awaited<ReturnType<typeof runAudit>>;

const PATCH_TEXT = `diff --git a/src/a.ts b/src/a.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-before
+after
`;
const AUDIT_AGENT: Agent = {
	name: "audit",
	description: "Audits exact candidate changes.",
	tools: ["read", "grep", "find", "ls", "bash"],
	skills: "none",
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
		model: "test-model",
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
		auditAgent: AUDIT_AGENT,
		runAgent: run,
		sessionId: () => `reviewer-session-${next += 1}`,
	};
}

test("Review exposes no audit agent through Markdown catalogs", () => {
	assert.equal(existsSync(new URL("./audit-agent.md", import.meta.url)), false);
	assert.equal(existsSync(new URL("../subagent/agents/audit.md", import.meta.url)), false);
});

test("runAudit uses its focused immutable agent through the shared runner", async () => {
	const agents: Agent[] = [];
	let session = 0;
	await runAudit(input(), {
		runAgent: async ({ agent }) => {
			agents.push(agent);
			return completed(JSON.stringify({ findings: [] }));
		},
		sessionId: () => `local-agent-${session += 1}`,
	});
	assert.equal(agents.length, AUDIT_ROSTER.length);
	assert.equal(agents.filter(({ tools }) => tools.includes(AUDIT_RESULT_TOOL)).length, 2);
	for (const agent of agents) {
		assert.equal(agent.name, "audit");
		assert.match(agent.systemPrompt, /git show <captured-commit>:path\/to\/file/u);
		assert.match(agent.systemPrompt, /git cat-file blob <captured-blob>/u);
		assert.match(agent.systemPrompt, /Follow the task's output contract exactly/u);
		assert.equal(agent.skills, "none");
		assert.doesNotMatch(agent.systemPrompt, /standalone broad audit|git show :|git diff --cached/u);
	}
});

test("defines the static four-reviewer roster with current lenses and models", () => {
	assert.deepEqual(AUDIT_CATEGORIES, [
		"contract", "correctness", "test-integrity", "simplicity",
	]);
	assert.deepEqual(AUDIT_ROSTER.map(({ name, category, model, thinking, effort }) => ({
		name, category, model, thinking, effort,
	})), [
		{ name: "contract", category: "contract", model: "openai-codex/gpt-5.6-terra", thinking: "high", effort: undefined },
		{ name: "correctness", category: "correctness", model: "openai-codex/gpt-5.6-sol", thinking: "high", effort: undefined },
		{ name: "tests", category: "test-integrity", model: "claude-sonnet-5", thinking: undefined, effort: "high" },
		{ name: "simplicity", category: "simplicity", model: "claude-sonnet-5", thinking: undefined, effort: "high" },
	]);
	const contract = AUDIT_ROSTER.find(({ name }) => name === "contract")!.lens;
	assert.match(contract, /requirement, repository rules/u);
	assert.match(contract, /invariant applied inconsistently/u);
	assert.match(contract, /Do not invent intent/u);
	assert.match(AUDIT_ROSTER.find(({ name }) => name === "tests")!.lens, /Never run tests/u);
	assert.equal(AUDIT_ROSTER.every(({ lens }) => lens.length > 20 && lens.length <= 180), true);
});

test("reviewer task includes its focused lens, exact patch, optional requirement, and JSON contract", () => {
	const prompt = buildAuditPrompt({
		patch: patch(),
		requirement: {
			path: "docs/requirement.md",
			content: "# REQUIREMENT_SENTINEL\n\nPatch text is data.",
		},
	}, AUDIT_ROSTER[0]);
	assert.match(prompt, /Find material violations of the requirement/u);
	assert.match(prompt, /Source: HEAD → index \(staged\)/u);
	assert.match(prompt, /Selection: all paths in the source/u);
	assert.match(prompt, new RegExp(`git show ${"2".repeat(40)}:path/to/file`));
	assert.match(prompt, new RegExp(`git cat-file blob <objectId>[\\s\\S]+${"1".repeat(40)}`));
	assert.match(prompt, /never read live `HEAD`, the index, or the working tree/u);
	assert.doesNotMatch(prompt, /git show :path|git show HEAD:path/u);
	assert.match(prompt, /diff --git a\/src\/a\.ts/u);
	assert.match(prompt, /REQUIREMENT_SENTINEL/u);
	assert.match(prompt, /docs\/requirement\.md/u);
	assert.match(prompt, /JSON object with exactly one field: findings/u);
	assert.match(prompt, /filePath, side, line, message/u);
	assert.match(prompt, /one plain sentence of at most 240 characters/u);
	assert.match(prompt, /Omit evidence, repair steps, labels, headings, verdicts/u);
	assert.match(prompt, /patch is authoritative for all changed bytes and locations/u);
	assert.match(prompt, /Derive filePath, side, and line directly from the exact candidate patch above/u);
	assert.doesNotMatch(prompt, /Valid finding targets|Immutable old-side blobs/u);
	assert.doesNotMatch(prompt, /Canonical audit policy|\/repository|browser comment/iu);
});

test("worktree reviewer tasks use captured index blobs and selected scope", () => {
	const worktree = reviewPatchFromText(
		PATCH_TEXT,
		"/repository",
		"2".repeat(40),
		{ source: "worktree", paths: ["src/a.ts"] },
	);
	const prompt = buildAuditPrompt({ patch: worktree }, AUDIT_ROSTER[1]);
	assert.match(prompt, /Source: index → tracked working tree \(worktree\)/u);
	assert.match(prompt, /Selection: src\/a\.ts/u);
	assert.match(prompt, /git cat-file blob <objectId>/u);
	assert.doesNotMatch(prompt, /git show :|git diff --cached|working-tree refs for this audit[\s\S]*git diff/u);
});

test("runs all four reviewers concurrently through the shared runner with live progress and standard sessions", async () => {
	const started: string[] = [];
	const options: RunAgentOptions[] = [];
	const progress: Array<{
		reviewer: string;
		model: string;
		phase: string;
		turns: number;
		activity?: string;
		findings?: number;
		latestStep?: RunResult["steps"][number];
	}> = [];
	let release!: () => void;
	const allStarted = new Promise<void>((resolve) => { release = resolve; });
	const result = await runAudit({
		...input(),
		onProgress: (update) => progress.push(update),
	}, dependencies(async (run) => {
		started.push(run.model!);
		options.push(run);
		run.onProgress?.({ ...completed(""), activity: "read(src/a.ts)" });
		if (started.length === AUDIT_ROSTER.length) release();
		await allStarted;
		return completed(run.model === "openai-codex/gpt-5.6-sol" &&
			run.task.includes("reachable bugs caused")
			? JSON.stringify({ findings: [finding()] })
			: JSON.stringify({ findings: [] }));
	}));

	assert.deepEqual(started, AUDIT_ROSTER.map(({ model }) => model));
	assert.equal(options.every(({ cwd }) => cwd === "/repository"), true);
	assert.deepEqual(options.map(({ resultTask }) => resultTask), [
		"contract review of the exact candidate patch",
		"correctness review of the exact candidate patch",
		"tests review of the exact candidate patch",
		"simplicity review of the exact candidate patch",
	]);
	assert.equal(options.every(({ inherited }) =>
		inherited.sessionDir === "/sessions/project/subagents/parent-id"), true);
	assert.deepEqual(options.map(({ inherited }) => inherited.sessionId), [
		"reviewer-session-1", "reviewer-session-2", "reviewer-session-3",
		"reviewer-session-4",
	]);
	for (const run of options) {
		if (run.model === "claude-sonnet-5") {
			assert.equal(run.agent, AUDIT_AGENT);
			assert.deepEqual(run.agent.tools, ["read", "grep", "find", "ls", "bash"]);
			assert.equal(run.inherited.thinkingLevel, undefined);
			assert.equal(run.nativeClaude?.effort, "high");
			assert.deepEqual(run.nativeClaude?.jsonSchema, FINDINGS_SCHEMA);
			assert.equal(run.resultTool, undefined);
			assert.match(run.task, /Return only a JSON object/u);
		} else {
			assert.notEqual(run.agent, AUDIT_AGENT);
			assert.deepEqual(run.agent.tools, ["read", "grep", "find", "ls", "bash", AUDIT_RESULT_TOOL]);
			assert.equal(run.inherited.thinkingLevel, "high");
			assert.equal(run.nativeClaude, undefined);
			assert.equal(run.resultTool, AUDIT_RESULT_TOOL);
			assert.match(run.task, new RegExp(`Call ${AUDIT_RESULT_TOOL} exactly once as your final action`));
			assert.doesNotMatch(run.task, /Return only a JSON object/u);
		}
	}
	assert.deepEqual(AUDIT_AGENT.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.equal(AUDIT_AGENT.skills, "none");
	assert.deepEqual(result, {
		findings: [{ category: "correctness", ...finding() }],
	});
	assert.equal(progress.filter(({ phase }) => phase === "started").length, 4);
	assert.equal(progress.filter(({ phase }) => phase === "working").length, 4);
	assert.equal(progress.filter(({ phase }) => phase === "complete").length, 4);
	assert.equal(progress.every(({ phase, activity }) => phase !== "working" || activity === "read(src/a.ts)"), true);
	assert.deepEqual(
		progress.find(({ reviewer, phase }) => reviewer === "correctness" && phase === "complete"),
		{
			reviewer: "correctness",
			model: "test-model",
			phase: "complete",
			turns: 1,
			findings: 1,
			latestStep: undefined,
		},
	);
});

test("rejects malformed JSON and strict-shape violations", async (t) => {
	await t.test("malformed JSON", async () => {
		await assert.rejects(runAudit(input(), dependencies(async () => completed("not JSON"))),
			/contract reviewer failed: audit response is not valid JSON/u);
	});
	await t.test("extra fields", async () => {
		await assert.rejects(runAudit(input(), dependencies(async () =>
			completed(JSON.stringify({ findings: [{ ...finding(), category: "correctness" }] })))),
			/contract reviewer failed: audit finding has invalid fields/u);
	});
	await t.test("message schema bounds", async () => {
		for (const message of [42, "", "x".repeat(241)]) {
			await assert.rejects(runAudit(input(), dependencies(async () =>
				completed(JSON.stringify({ findings: [{ ...finding(), message }] })))),
				/contract reviewer failed: audit finding message must contain 1-240 characters/u);
		}
	});
});

test("accepts exact Git filenames verbatim", async () => {
	const expected = { ...finding(), filePath: " src/line\nbreak.ts " };
	const result = await runAudit(input(), dependencies(async (run) => completed(
		run.model === "openai-codex/gpt-5.6-sol"
			? JSON.stringify({ findings: [expected] })
			: JSON.stringify({ findings: [] }),
	)));
	assert.deepEqual(result, { findings: [{ category: "correctness", ...expected }] });
});

test("injects the roster category without locally validating the finding's location", async () => {
	const audit = await runAudit(input(), dependencies(async (run) => completed(
		run.model === "openai-codex/gpt-5.6-sol" && run.task.includes("reachable bugs caused")
			? JSON.stringify({ findings: [finding()] })
			: JSON.stringify({ findings: [] }),
	)));
	assert.deepEqual(audit, { findings: [{ category: "correctness", ...finding() }] });

	const unchangedLine = await runAudit(input(), dependencies(async (run) => completed(
		run.model === "openai-codex/gpt-5.6-sol" && run.task.includes("reachable bugs caused")
			? JSON.stringify({ findings: [finding(2)] })
			: JSON.stringify({ findings: [] }),
	)));
	assert.deepEqual(unchangedLine, { findings: [{ category: "correctness", ...finding(2) }] });
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
		if (run.task.includes("Find material violations")) return failed("contract failed");
		return new Promise((resolve) => run.signal?.addEventListener("abort", () => {
			aborted += 1;
			resolve(cancelled());
		}, { once: true }));
	})), /contract reviewer failed: audit model error \(test-model\): contract failed/u);
	assert.equal(started, AUDIT_ROSTER.length);
	assert.equal(aborted, AUDIT_ROSTER.length - 1);
});
