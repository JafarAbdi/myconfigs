import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
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
import { acquireTestLock } from "./test-lock.ts";

const agentDir = mkdtempSync(join(tmpdir(), "juruc-simple-pipeline-agent-"));
const scratch = mkdtempSync(join(tmpdir(), "juruc-simple-pipeline-repository-"));
const previousEnvironment = new Map<string, string | undefined>();
for (const [name, value] of Object.entries({
	PI_CODING_AGENT_DIR: agentDir,
	GIT_AUTHOR_NAME: "JURUC pipeline test",
	GIT_AUTHOR_EMAIL: "juruc-pipeline@example.invalid",
	GIT_COMMITTER_NAME: "JURUC pipeline test",
	GIT_COMMITTER_EMAIL: "juruc-pipeline@example.invalid",
})) {
	previousEnvironment.set(name, process.env[name]);
	process.env[name] = value;
}

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
if (existsSync(localModules))
	throw new Error(`${localModules} already exists; refusing to replace it`);
mkdirSync(join(localModules, "@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-tui"])
	symlinkSync(
		join(piPackage, "node_modules", "@earendil-works", name),
		join(localModules, "@earendil-works", name),
		"dir",
	);
symlinkSync(piPackage, join(localModules, "@earendil-works", "pi-coding-agent"), "dir");
symlinkSync(join(piPackage, "node_modules", "typebox"), join(localModules, "typebox"), "dir");

function cleanup(): void {
	rmSync(localModules, { recursive: true, force: true });
	releaseTestLock();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
	for (const [name, value] of previousEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}
process.once("exit", cleanup);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

try {
	const [
		{ fauxAssistantMessage, fauxToolCall, createRuntimeHarness },
		{ SessionManager },
		{ registerJuruc },
		{ runtimePaths },
		{ loadTask },
	] = await Promise.all([
		import("./runtime-harness.ts"),
		import("@earendil-works/pi-coding-agent"),
		import("./index.ts"),
		import("./runtime.ts"),
		import("./tasks.ts"),
	]);

	await test("compact runtime automatically advances through research, planning, build, and verified completion", async () => {
		const source = join(scratch, "source");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");

		const canonical = join(agentDir, "canonical");
		mkdirSync(canonical, { recursive: true });
		const grill = join(canonical, "grill.md");
		writeFileSync(grill, "Canonical grill ${ARGUMENTS:-the task}.\n");
		const paths = runtimePaths(agentDir);
		const slug = "simplify-runtime-workflow";
		const researchOutput = "Independent facts with concrete references.\n";
		const writtenPhases = new Set<number>();

		const synthesis = {
			agent: "synthesizer",
			task: "synthesize",
			output: researchOutput,
			stopReason: "stop",
			steps: [],
			turns: 1,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			durationMs: 1,
		};
		const confirmedPlan = {
			objective: "Complete the requested workflow.",
			constraints: ["Keep worktree isolation."],
			assumptions: ["One operator owns the task."],
			nonGoals: [],
			successCriteria: ["The task is complete."],
			futurePhases: [
				{
					title: "Implement the change",
					objective: "Change the tracked candidate.",
					successCriteria: ["The candidate is verified."],
					verification: ["node --test focused.test.ts"],
				},
				{
					title: "Connect the change",
					objective: "Complete the tracked candidate.",
					successCriteria: ["The integration is verified."],
					verification: ["node --test integration.test.ts"],
				},
			],
		};

		const harness = await createRuntimeHarness({
			agentDir,
			cwd: source,
			sessionManager: SessionManager.create(source),
			promptTemplates: [grill],
			stubTools: ["delegate"],
			stubResult: (name) => name === "delegate" ? synthesis : undefined,
			registerJuruc,
			probe: (pi) => {
				pi.on("session_start", () => {
					try {
						const task = loadTask(paths, slug);
						const phase = task.document.plan?.completed.length ?? 0;
						if (task.document.stage === "building" && !writtenPhases.has(phase)) {
							writeFileSync(
								join(task.document.repository.worktree, "tracked.txt"),
								`candidate ${phase + 1}\n`,
							);
							writtenPhases.add(phase);
						}
					} catch {}
				});
			},
		});

		try {
			harness.selections.push("New task…");
			harness.editorValues.push("Simplify runtime workflow");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize reports." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_plan", confirmedPlan)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_block_phase", { reason: "Confirm the retry path." })],
					{ stopReason: "toolUse" },
				),
			]);
			await harness.runtime.session.prompt("/juruc");

			let task = loadTask(paths, slug);
			assert.equal(task.document.stage, "blocked");
			assert.ok(task.document.sessions.research);
			assert.ok(task.document.sessions.planning);
			assert.notEqual(task.document.sessions.research, task.document.sessions.planning);
			assert.equal(readFileSync(join(task.directory, "research.md"), "utf8"), researchOutput);
			assert.equal(existsSync(join(task.directory, "state.json")), false);
			assert.equal(existsSync(join(task.directory, "plan.json")), false);
			assert.equal(task.document.blockReason, "Confirm the retry path.");
			const buildSession = task.document.sessions.build;
			assert.ok(buildSession);
			assert.equal(
				git(task.document.repository.worktree, "rev-parse", "HEAD"),
				task.document.repository.sourceHead,
			);
			assert.equal(readFileSync(join(task.document.repository.worktree, "tracked.txt"), "utf8"), "candidate 1\n");

			harness.selections.push(
				"Simplify runtime workflow — simplify-runtime-workflow · blocked",
				"Continue planning",
			);
			const finish = {
				resolution: "Implemented and verified the candidate.",
				commitMessage: "Implement runtime workflow",
				verificationEvidence: [{
					command: "node --test focused.test.ts",
					exitCode: 0,
					summary: "Focused test passed.",
				}],
			};
			const finishIntegration = {
				resolution: "Connected and verified the candidate.",
				commitMessage: "Connect runtime workflow",
				verificationEvidence: [{
					command: "node --test integration.test.ts",
					exitCode: 0,
					summary: "Integration test passed.",
				}],
			};
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_plan", confirmedPlan)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_finish_phase", finish)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_finish_phase", finishIntegration)],
					{ stopReason: "toolUse" },
				),
			]);
			await harness.runtime.session.prompt("/juruc");

			task = loadTask(paths, slug);
			assert.equal(task.document.stage, "done");
			assert.equal(task.document.sessions.build, null);
			assert.equal(task.document.plan?.completed.length, 2);
			assert.ok(task.document.plan?.completed[0].commit);
			assert.ok(task.document.plan?.completed[1].commit);
			assert.deepEqual(task.document.plan?.completed[0].verificationEvidence, finish.verificationEvidence);
			assert.deepEqual(
				task.document.plan?.completed[1].verificationEvidence,
				finishIntegration.verificationEvidence,
			);
			assert.equal(task.document.plan?.remaining.length, 0);
			assert.equal(
				git(task.document.repository.worktree, "log", "-2", "--format=%s"),
				"Connect runtime workflow\nImplement runtime workflow",
			);
			assert.equal(git(task.document.repository.worktree, "status", "--porcelain"), "");
			assert.equal(buildSession === task.document.sessions.planning, false);
			assert.equal(
				harness.instances.at(-1)?.pi.getActiveTools().some((name) => name.startsWith("juruc_")),
				false,
			);
			assert.equal(harness.notices.some((notice) => /transaction|acceptance|recovery/iu.test(notice)), false);
		} finally {
			await harness.dispose();
		}
	});
} finally {
	process.removeListener("exit", cleanup);
	cleanup();
}
