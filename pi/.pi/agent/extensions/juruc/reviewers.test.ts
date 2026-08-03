import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { demoReviewPatch } from "./review-fixture.ts";
import { acquireTestLock } from "./test-lock.ts";
import type { ReviewerDriver, ReviewerRunInput } from "./reviewers.ts";
import type {
	CompletedTaskPhase,
	TaskPhase,
	TaskPlan,
	TaskSpecification,
} from "./task.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const extensionsDirectory = dirname(extensionDirectory);
const releaseTestLock = await acquireTestLock("juruc-extension-node-modules.lock");
const localModules = join(extensionsDirectory, "node_modules");
const piExecutable = process.env.PATH?.split(delimiter)
	.map((directory) => join(directory, "pi"))
	.find(existsSync);
const piPackage = process.env.PI_PACKAGE_DIR ??
	(piExecutable ? join(dirname(realpathSync(piExecutable)), "..") : undefined);
if (!piPackage) throw new Error("pi package not found through PI_PACKAGE_DIR or PATH");
if (existsSync(localModules)) throw new Error(`${localModules} already exists; refusing to replace it`);
mkdirSync(join(localModules, "@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-tui"])
	symlinkSync(
		join(piPackage, "node_modules", "@earendil-works", name),
		join(localModules, "@earendil-works", name),
		"dir",
	);
symlinkSync(piPackage, join(localModules, "@earendil-works", "pi-coding-agent"), "dir");
symlinkSync(join(piPackage, "node_modules", "typebox"), join(localModules, "typebox"), "dir");
const reviewerAgentDir = mkdtempSync(join(tmpdir(), "juruc-reviewer-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = reviewerAgentDir;
function cleanup(): void {
	rmSync(localModules, { recursive: true, force: true });
	releaseTestLock();
	rmSync(reviewerAgentDir, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
process.once("exit", cleanup);

const {
	buildCorrectnessReviewerPrompt,
	buildDeviationReviewerPrompt,
	drivePiReviewer,
	parseReviewerOutput,
	projectCheckpointVerification,
	MAX_REVIEWER_OUTPUT_BYTES,
	REVIEWER_SYSTEM_INSTRUCTION,
	runReviewer,
} = await import("./reviewers.ts");
const specification: TaskSpecification = {
	summary: "SPECIFICATION_SENTINEL",
	requirements: ["Preserve greeting behavior."],
	nonGoals: ["No unrelated refactor."],
	constraints: ["Keep output deterministic."],
	acceptanceCriteria: ["The greeting is correct."],
	decisions: ["Use the accepted fallback."],
};

const phase: TaskPhase = {
	id: "phase-plan-sentinel",
	title: "PLAN_TITLE_SENTINEL",
	goal: "PLAN_GOAL_SENTINEL",
	fileScopes: ["src/**"],
	instructions: ["PLAN_INSTRUCTION_SENTINEL"],
	verification: ["node --test"],
};
const plan: TaskPlan = { phases: [phase] };
const checkpoints: CompletedTaskPhase[] = [{
	...phase,
	resolution: "CHECKPOINT_RESOLUTION_OMITTED",
	verificationEvidence: [{
		command: "node --test",
		exitCode: 0,
		summary: "VERIFICATION_SUMMARY_SENTINEL",
	}],
	commit: "a".repeat(40),
}];

function assistant(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		...overrides,
	};
}

function output(annotations: unknown[]): string {
	return JSON.stringify({ annotations });
}

function sessionEntries(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf8").trim().split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertPersistedReviewerSession(path: string, kind = "deviation"): void {
	assert.equal(existsSync(path), true);
	assert.equal(lstatSync(path).mode & 0o777, 0o600);
	const entries = sessionEntries(path);
	assert.equal(entries[0].type, "session");
	assert.equal(entries[1].type, "session_info");
	assert.equal(entries[1].name, `JURUC ${kind} reviewer`);
}

function baseRunInput(root: string): ReviewerRunInput {
	return {
		kind: "deviation",
		worktree: root,
		patch: demoReviewPatch(),
		specification,
		plan,
		checkpoints,
		sessionDirectory: join(root, "sessions"),
	};
}

test("strict reviewer output accepts empty and multiple exact changed-line annotations", () => {
	const patch = demoReviewPatch();
	assert.deepEqual(parseReviewerOutput('{"annotations":[]}', patch), []);
	const annotations = [
		{
			filePath: "src/greeting.ts",
			side: "additions",
			line: 2,
			summary: "Fallback behavior can hide an invalid caller input.",
			rationale: "The changed assignment converts whitespace-only values.",
		},
		{
			filePath: "README.md",
			side: "deletions",
			line: 3,
			summary: "The removed description was the only terse behavior statement.",
		},
	];
	assert.deepEqual(parseReviewerOutput(output(annotations), patch), annotations);
	assert.deepEqual(
		parseReviewerOutput(JSON.stringify({ annotations }, null, 2), patch),
		annotations,
	);
	assert.deepEqual(
		parseReviewerOutput(
			'{"annotations":[{"summary":"Concrete issue.","line":2,"side":"additions","filePath":"src/greeting.ts"}]}',
			patch,
		),
		[{
			filePath: "src/greeting.ts",
			side: "additions",
			line: 2,
			summary: "Concrete issue.",
		}],
	);
});

test("strict reviewer output rejects malformed containers, fields, text, and targets atomically", () => {
	const patch = demoReviewPatch();
	const valid = {
		filePath: "src/greeting.ts",
		side: "additions",
		line: 2,
		summary: "Concrete issue.",
	};
	const malformed = [
		"```json\n{\"annotations\":[]}\n```",
		'{"annotations":[],"annotations":[]}',
		'{"annotations":[{"filePath":"src/greeting.ts","side":"additions","line":2,"summary":"first","summary":"second"}]}',
		'Here is the result: {"annotations":[]}',
		JSON.stringify({ annotations: [], extra: true }),
		output([{ ...valid, extra: true }]),
		output([{ ...valid, source: "model" }]),
		output([{ ...valid, side: "context" }]),
		output([{ ...valid, line: 0 }]),
		output([{ ...valid, line: 1.5 }]),
		output([{ ...valid, filePath: "unknown.ts" }]),
		output([{ ...valid, line: 1 }]),
		output([{ ...valid, summary: " " }]),
		output([{ ...valid, summary: ` ${valid.summary}` }]),
		output([{ ...valid, summary: "x".repeat(2_001) }]),
		output([{ ...valid, filePath: "x".repeat(4_097) }]),
		output([{ ...valid, rationale: "" }]),
		output([{ ...valid, rationale: "x".repeat(5_001) }]),
		output([valid, { ...valid, line: 1 }]),
	];
	for (const source of malformed)
		assert.throws(() => parseReviewerOutput(source, patch));
	assert.throws(
		() => parseReviewerOutput(" ".repeat(MAX_REVIEWER_OUTPUT_BYTES + 1), patch),
		/exceeds .* bytes/,
	);
});

test("reviewer prompts enforce exact information diets and verification projection", () => {
	const patch = demoReviewPatch();
	assert.deepEqual(projectCheckpointVerification(checkpoints), [{
		id: "phase-plan-sentinel",
		title: "PLAN_TITLE_SENTINEL",
		verificationEvidence: [{
			command: "node --test",
			exitCode: 0,
			summary: "VERIFICATION_SUMMARY_SENTINEL",
		}],
	}]);
	const deviation = buildDeviationReviewerPrompt(specification, plan, patch, checkpoints);
	const correctness = buildCorrectnessReviewerPrompt(specification, patch, checkpoints);
	for (const prompt of [deviation, correctness]) {
		assert.match(prompt, /SPECIFICATION_SENTINEL/);
		assert.match(prompt, /VERIFICATION_SUMMARY_SENTINEL/);
		assert.match(prompt, /BEGIN UNTRUSTED PATCH/);
		assert.match(prompt, /Return only strict JSON/);
		assert.doesNotMatch(prompt, /CHECKPOINT_RESOLUTION_OMITTED/);
		assert.doesNotMatch(prompt, /questions transcript sentinel/i);
		assert.doesNotMatch(prompt, /research transcript sentinel/i);
	}
	assert.match(deviation, /phase-plan-sentinel/);
	assert.match(deviation, /PLAN_INSTRUCTION_SENTINEL/);
	assert.match(correctness, /phase-plan-sentinel/);
	assert.match(correctness, /PLAN_TITLE_SENTINEL/);
	assert.doesNotMatch(correctness, /PLAN_GOAL_SENTINEL/);
	assert.doesNotMatch(correctness, /PLAN_INSTRUCTION_SENTINEL/);
});

test("top-level reviewer runs once, preserves valid output, and creates fresh absolute sessions", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-reviewer-run-"));
	mkdirSync(join(root, "sessions"));
	try {
		let calls = 0;
		const driver: ReviewerDriver = async () => {
			calls++;
			return {
				assistantMessages: [assistant(output([{
					filePath: "src/greeting.ts",
					side: "additions",
					line: 3,
					summary: "The changed return adds punctuation callers may not expect.",
				}]))],
			};
		};
		const first = await runReviewer(baseRunInput(root), driver);
		const second = await runReviewer(baseRunInput(root), driver);
		assert.equal(calls, 2);
		assert.equal(first.outcome.status, "completed");
		assert.equal(second.outcome.status, "completed");
		assert.notEqual(first.sessionPath, second.sessionPath);
		assert.equal(first.sessionPath.startsWith(root), true);
		assertPersistedReviewerSession(first.sessionPath);
		assertPersistedReviewerSession(second.sessionPath);
		assert.deepEqual(
			first.outcome.status === "completed" ? first.outcome.annotations : undefined,
			[{
				filePath: "src/greeting.ts",
				side: "additions",
				line: 3,
				summary: "The changed return adds punctuation callers may not expect.",
			}],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reviewer callback runs after durable session and before the driver", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-reviewer-callback-"));
	mkdirSync(join(root, "sessions"));
	try {
		const order: string[] = [];
		const result = await runReviewer({
			...baseRunInput(root),
			async onSessionCreated(path) {
				assertPersistedReviewerSession(path);
				order.push("callback");
			},
		}, async () => {
			order.push("driver");
			return { assistantMessages: [assistant('{"annotations":[]}')] };
		});
		assert.equal(result.outcome.status, "completed");
		assert.deepEqual(order, ["callback", "driver"]);

		let driverCalls = 0;
		await assert.rejects(
			runReviewer({
				...baseRunInput(root),
				async onSessionCreated(path) {
					assertPersistedReviewerSession(path);
					throw new Error("task persistence failed");
				},
			}, async () => {
				driverCalls++;
				return { assistantMessages: [] };
			}),
			/task persistence failed/,
		);
		assert.equal(driverCalls, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("top-level reviewer does not retry driver, malformed output, or session failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-reviewer-failure-"));
	mkdirSync(join(root, "sessions"));
	try {
		let malformedCalls = 0;
		const malformed = await runReviewer(baseRunInput(root), async () => {
			malformedCalls++;
			return { assistantMessages: [assistant(output([{
				filePath: "src/greeting.ts",
				side: "additions",
				line: 1,
				summary: "Not on a changed line.",
			}]))] };
		});
		assert.equal(malformedCalls, 1);
		assert.deepEqual(malformed.outcome.status, "failed");
		assert.equal(malformed.outcome.status === "failed" ? malformed.outcome.failureKind : undefined, "malformed-output");
		assert.equal("annotations" in malformed.outcome, false);
		assertPersistedReviewerSession(malformed.sessionPath);

		let throwCalls = 0;
		const failed = await runReviewer(baseRunInput(root), async () => {
			throwCalls++;
			throw new Error(`provider unavailable ${"x".repeat(1_000)}`);
		});
		assert.equal(throwCalls, 1);
		assert.equal(failed.outcome.status === "failed" ? failed.outcome.failureKind : undefined, "session-error");
		assert.equal(failed.outcome.status === "failed" ? failed.outcome.message.length : 0, 500);
		assert.equal(failed.sessionPath.startsWith(root), true);
		assertPersistedReviewerSession(failed.sessionPath);

		const nontext = await runReviewer(baseRunInput(root), async () => ({
			assistantMessages: [assistant("", { content: [{ type: "toolCall", name: "read" }] })],
		}));
		assert.equal(nontext.outcome.status === "failed" ? nontext.outcome.failureKind : undefined, "malformed-output");
		assertPersistedReviewerSession(nontext.sessionPath);
		const thinkingOnly = await runReviewer(baseRunInput(root), async () => ({
			assistantMessages: [assistant("", { content: [{ type: "thinking", thinking: "Reviewing." }] })],
		}));
		assert.equal(thinkingOnly.outcome.status === "failed" ? thinkingOnly.outcome.failureKind : undefined, "malformed-output");
		const multipleText = await runReviewer(baseRunInput(root), async () => ({
			assistantMessages: [assistant("", { content: [
				{ type: "text", text: '{"annotations":[]}' },
				{ type: "text", text: '{"annotations":[]}' },
			] })],
		}));
		assert.equal(multipleText.outcome.status === "failed" ? multipleText.outcome.failureKind : undefined, "malformed-output");
		const missing = await runReviewer(baseRunInput(root), async () => ({ assistantMessages: [] }));
		assert.equal(missing.outcome.status === "failed" ? missing.outcome.failureKind : undefined, "malformed-output");
		const modelError = await runReviewer(baseRunInput(root), async () => ({
			assistantMessages: [assistant("", { stopReason: "error", errorMessage: "model error" })],
		}));
		assert.equal(modelError.outcome.status === "failed" ? modelError.outcome.failureKind : undefined, "session-error");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi reviewer driver disables resources, tools, retry, and compaction for one prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-reviewer-driver-"));
	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	const settingsPath = join(reviewerAgentDir, "settings.json");
	const configuredSettings = JSON.stringify({
		defaultThinkingLevel: "high",
		defaultProvider: "global-provider",
		defaultModel: "global-model",
		transport: "sse",
	});
	writeFileSync(settingsPath, configuredSettings);
	const projectDirectory = join(root, ".pi");
	mkdirSync(projectDirectory);
	const projectSettingsPath = join(projectDirectory, "settings.json");
	const hostileProjectSettings = JSON.stringify({
		defaultThinkingLevel: "off",
		defaultProvider: "hostile-provider",
		defaultModel: "hostile-model",
		transport: "websocket",
		compaction: { enabled: true, reserveTokens: 999_999, keepRecentTokens: 999_999 },
		retry: { enabled: true, maxRetries: 99 },
	});
	writeFileSync(projectSettingsPath, hostileProjectSettings);
	const correctnessInput: ReviewerRunInput = {
		kind: "correctness",
		worktree: root,
		patch: demoReviewPatch(),
		specification,
		checkpoints,
		sessionDirectory: sessions,
	};
	try {
		let factoryCalls = 0;
		let prompts = 0;
		let disposed = 0;
		let capturedOptions: Parameters<NonNullable<Parameters<typeof drivePiReviewer>[1]>>[0] | undefined;
		let promptOptions: unknown;
		const result = await runReviewer(correctnessInput, (driverInput) =>
			drivePiReviewer(driverInput, async (options) => {
				factoryCalls++;
				capturedOptions = options;
				assertPersistedReviewerSession(options.sessionManager!.getSessionFile()!, "correctness");
				return {
					session: {
						messages: [assistant("", { content: [
							{ type: "thinking", thinking: "Inspecting the patch." },
							{ type: "text", text: '{"annotations":[]}' },
							{ type: "thinking", thinking: "Done." },
						] })],
						async prompt(text, options_) {
							prompts++;
							assert.equal(text, driverInput.prompt);
							promptOptions = options_;
						},
						dispose() { disposed++; },
					},
				};
			}),
		);
		assert.equal(result.outcome.status, "completed");
		assert.equal(factoryCalls, 1);
		assert.equal(prompts, 1);
		assert.equal(disposed, 1);
		assert.deepEqual(promptOptions, { expandPromptTemplates: false });
		assert.equal(capturedOptions?.noTools, "all");
		assert.deepEqual(capturedOptions?.tools, []);
		assert.equal(capturedOptions?.thinkingLevel, undefined);
		assert.equal(capturedOptions?.settingsManager?.isProjectTrusted(), false);
		assert.deepEqual(capturedOptions?.settingsManager?.getProjectSettings(), {});
		assert.equal(capturedOptions?.settingsManager?.getDefaultThinkingLevel(), "high");
		assert.equal(capturedOptions?.settingsManager?.getDefaultProvider(), "global-provider");
		assert.equal(capturedOptions?.settingsManager?.getDefaultModel(), "global-model");
		assert.equal(capturedOptions?.settingsManager?.getTransport(), "sse");
		assert.equal(capturedOptions?.settingsManager?.getRetryEnabled(), false);
		assert.equal(capturedOptions?.settingsManager?.getRetrySettings().maxRetries, 0);
		assert.equal(capturedOptions?.settingsManager?.getProviderRetrySettings().maxRetries, 0);
		assert.equal(capturedOptions?.settingsManager?.getCompactionEnabled(), false);
		const loader = capturedOptions?.resourceLoader;
		assert.deepEqual(loader?.getExtensions().extensions, []);
		assert.deepEqual(loader?.getSkills().skills, []);
		assert.deepEqual(loader?.getPrompts().prompts, []);
		assert.deepEqual(loader?.getThemes().themes, []);
		assert.deepEqual(loader?.getAgentsFiles().agentsFiles, []);
		assert.equal(loader?.getSystemPrompt(), REVIEWER_SYSTEM_INSTRUCTION);
		assert.deepEqual(loader?.getAppendSystemPrompt(), []);

		let failedDispose = 0;
		const failed = await runReviewer(correctnessInput, (driverInput) =>
			drivePiReviewer(driverInput, async () => ({
				session: {
					messages: [],
					async prompt() { throw new Error("model failed"); },
					dispose() { failedDispose++; },
				},
			})),
		);
		assert.equal(failed.outcome.status === "failed" ? failed.outcome.failureKind : undefined, "session-error");
		assertPersistedReviewerSession(failed.sessionPath, "correctness");
		assert.equal(failedDispose, 1);
		assert.equal(readFileSync(settingsPath, "utf8"), configuredSettings);
		assert.equal(readFileSync(projectSettingsPath, "utf8"), hostileProjectSettings);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
