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

const agentDir = mkdtempSync(join(tmpdir(), "juruc-qrspi-agent-"));
const scratch = mkdtempSync(join(tmpdir(), "juruc-qrspi-repository-"));
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

function gitSucceeds(cwd: string, ...args: string[]): boolean {
	try {
		execFileSync("git", args, { cwd, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

try {
	const [
		{ fauxAssistantMessage, fauxToolCall, createRuntimeHarness },
		{ SessionManager },
		{ prepareReview, registerJuruc },
		{ runtimePaths },
		{ loadTask, saveTask },
		{
			addTaskReviewComment,
			currentTaskCorrectionRound,
			decideTaskReview,
			findTaskSession,
			loadTaskDocument,
			registerTaskReviewerStart,
			saveTaskDocument,
		},
		{ activeReviewServer },
		{ demoReviewPatch, demoReviewTask },
	] = await Promise.all([
		import("./runtime-harness.ts"),
		import("@earendil-works/pi-coding-agent"),
		import("./index.ts"),
		import("./runtime.ts"),
		import("./tasks.ts"),
		import("./task.ts"),
		import("./review-server.ts"),
		import("./review-fixture.ts"),
	]);

	await test("runtime automatically cuts over Q to R to S to P to fresh implementation phases", async () => {
		const source = join(scratch, "source");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		writeFileSync(
			join(source, ".gitignore"),
			".env*\nCLAUDE.local.md\n.claude/settings.local.json\n",
		);
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");
		writeFileSync(join(source, ".env.local"), "PIPELINE_SECRET=local\n");
		writeFileSync(join(source, "CLAUDE.local.md"), "local instructions\n");
		mkdirSync(join(source, ".claude"));
		writeFileSync(join(source, ".claude", "settings.local.json"), "{\"local\":true}\n");
		mkdirSync(join(source, "nested"));
		writeFileSync(join(source, "nested", ".env"), "nested must not copy\n");
		writeFileSync(join(source, "other.local"), "other must not copy\n");

		const paths = runtimePaths(agentDir);
		const slug = "qrspi-runtime-workflow";
		const researchOutput = "Independent verified facts.\n";
		const writtenPhases = new Set<number>();
		const openedUrls: string[] = [];
		const preImplementation: Array<{ stage: string; branch: boolean; worktree: boolean }> = [];
		let injectedActivationFailure = false;
		const questions = {
			sharedUnderstanding: "Implement the confirmed local workflow.",
			decisions: ["Use two phases."],
			acceptedAssumptions: [],
			researchTargets: [],
		};
		const specification = {
			summary: "Implement the local workflow.",
			requirements: ["Advance through two committed phases."],
			nonGoals: ["No publication."],
			constraints: ["Keep strict state."],
			acceptanceCriteria: ["Both phase checks pass."],
			decisions: ["Use two phases."],
		};
		const phaseOneVerification = "node -e \"console.log('phase one verified')\"";
		const phaseTwoVerification = "node -e \"console.log('phase two verified')\"";
		const undeclaredVerification =
			"node -e \"require('node:fs').writeFileSync('undeclared.txt', 'forbidden')\"";
		const plan = {
			phases: [
				{
					id: "implement-change",
					title: "Implement change",
					goal: "Implement the candidate.",
					fileScopes: ["tracked.txt"],
					instructions: ["Write the first candidate."],
					verification: [phaseOneVerification],
				},
				{
					id: "connect-change",
					title: "Connect change",
					goal: "Complete the candidate.",
					fileScopes: ["tracked.txt"],
					instructions: ["Write the integrated candidate."],
					verification: [phaseTwoVerification],
				},
			],
		};
		const reviewerCalls: string[] = [];
		const reviewerDriver = async (input: { kind: string }) => {
			reviewerCalls.push(input.kind);
			return {
				assistantMessages: [{
					role: "assistant",
					content: [{ type: "text", text: '{"annotations":[]}' }],
					stopReason: "stop",
				}],
			};
		};
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

		const harness = await createRuntimeHarness({
			agentDir,
			cwd: source,
			sessionManager: SessionManager.create(source),
			promptTemplates: [],
			stubTools: ["delegate"],
			stubResult: (name) => name === "delegate" ? synthesis : undefined,
			registerJuruc: (pi) =>
				registerJuruc(pi, {
					reviewerDriver,
					openBrowser: async (url: string) => {
						openedUrls.push(url);
					},
				}),
			probe: (pi, record) => {
				pi.on("session_start", () => {
					record.activeTools = pi.getActiveTools();
					try {
						const task = loadTask(paths, slug);
						const phase = task.document.checkpoints.length;
						if (["questions", "research", "specification", "plan"].includes(task.document.stage)) {
							preImplementation.push({
								stage: task.document.stage,
								branch: gitSucceeds(source, "show-ref", "--verify", "--quiet", `refs/heads/${slug}`),
								worktree: existsSync(task.document.repository.worktree),
							});
						}
						if (task.document.stage === "plan" && !task.document.plan && !injectedActivationFailure) {
							mkdirSync(task.document.repository.worktree);
							injectedActivationFailure = true;
						}
						if (task.document.stage === "implementation" && !writtenPhases.has(phase)) {
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
			harness.editorValues.push("QRSPI runtime workflow");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_questions", questions)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize facts." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_specification", specification)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_plan", plan)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Activation remains pending.", { stopReason: "stop" }),
			]);
			await harness.runtime.session.prompt("/juruc");

			const pending = loadTask(paths, slug);
			assert.equal(pending.document.stage, "plan");
			assert.deepEqual(pending.document.plan, plan);
			assert.equal(findTaskSession(pending.document, { kind: "implementation", phase: 1 }), undefined);
			assert.equal(gitSucceeds(source, "show-ref", "--verify", "--quiet", `refs/heads/${slug}`), false);
			assert.equal(existsSync(pending.document.repository.worktree), true);
			assert.deepEqual(harness.instances.at(-1)!.pi.getActiveTools(), []);
			assert.match(
				readFileSync(findTaskSession(pending.document, { kind: "plan" })!.path, "utf8"),
				/run \/juruc to retry/,
			);
			rmSync(pending.document.repository.worktree, { recursive: true });

			harness.selections.push("QRSPI runtime workflow — qrspi-runtime-workflow · plan");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("juruc_run_verification", { command: undeclaredVerification })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_run_verification", { command: phaseOneVerification })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_finish_phase", {
						resolution: "Implemented and verified.",
						commitMessage: "Implement runtime workflow",
						verificationEvidence: [{
							command: phaseOneVerification,
							exitCode: 0,
							summary: "Phase one verification passed.",
						}],
					})],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_run_verification", { command: phaseTwoVerification })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_finish_phase", {
						resolution: "Connected and verified.",
						commitMessage: "Connect runtime workflow",
						verificationEvidence: [{
							command: phaseTwoVerification,
							exitCode: 0,
							summary: "Phase two verification passed.",
						}],
					})],
					{ stopReason: "toolUse" },
				),
			]);
			await harness.runtime.session.prompt("/juruc");

			const task = loadTask(paths, slug);
			assert.equal(task.document.stage, "review");
			assert.deepEqual(preImplementation.map(({ stage }) => stage), [
				"questions",
				"research",
				"specification",
				"plan",
			]);
			assert.ok(preImplementation.every(({ branch, worktree }) => !branch && !worktree));
			assert.deepEqual(task.document.questions, questions);
			assert.deepEqual(task.document.specification, specification);
			assert.deepEqual(task.document.plan, plan);
			assert.equal(task.document.checkpoints.length, 2);
			assert.equal(readFileSync(join(task.directory, "research.md"), "utf8"), researchOutput);
			assert.equal(readFileSync(join(task.document.repository.worktree, ".env.local"), "utf8"), "PIPELINE_SECRET=local\n");
			assert.equal(readFileSync(join(task.document.repository.worktree, "CLAUDE.local.md"), "utf8"), "local instructions\n");
			assert.equal(
				readFileSync(join(task.document.repository.worktree, ".claude", "settings.local.json"), "utf8"),
				"{\"local\":true}\n",
			);
			assert.equal(existsSync(join(task.document.repository.worktree, "nested", ".env")), false);
			assert.equal(existsSync(join(task.document.repository.worktree, "other.local")), false);
			assert.equal("research" in task.document, false);
			assert.equal(new Set(task.document.sessions.map(({ path }) => path)).size, 8);
			for (const kind of ["questions", "research", "specification", "plan"] as const)
				assert.ok(findTaskSession(task.document, { kind }));
			assert.notEqual(
				findTaskSession(task.document, { kind: "implementation", phase: 1 })?.path,
				findTaskSession(task.document, { kind: "implementation", phase: 2 })?.path,
			);
			assert.deepEqual(reviewerCalls, ["deviation", "correctness"]);
			assert.equal(openedUrls.length, 1);
			assert.match(openedUrls[0], /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/\?/u);
			const round = task.document.reviewRounds[0];
			assert.equal(round.baseCommit, task.document.repository.sourceHead);
			assert.equal(round.headCommit, task.document.checkpoints[1].commit);
			assert.equal(round.reviewers.deviation?.outcome?.status, "completed");
			assert.equal(round.reviewers.correctness?.outcome?.status, "completed");
			assert.ok(findTaskSession(task.document, { kind: "deviation-review", round: 1 }));
			assert.ok(findTaskSession(task.document, { kind: "correctness-review", round: 1 }));
			assert.equal(existsSync(join(task.directory, "review.json")), false);

			assert.equal(harness.instances.length, 7);
			assert.ok(harness.instances[0].activeTools?.includes("read"));
			for (const index of [1, 2, 4])
				assert.equal(realpathSync(harness.instances[index].cwd!), realpathSync(source));
			assert.equal(realpathSync(harness.instances[3].cwd!), realpathSync(task.directory));
			for (const instance of harness.instances.slice(5))
				assert.equal(realpathSync(instance.cwd!), realpathSync(task.document.repository.worktree));
			assert.deepEqual(harness.instances[2].activeTools, ["delegate"]);
			assert.deepEqual(harness.instances[3].activeTools, ["juruc_set_specification"]);
			assert.ok(harness.instances[1].activeTools?.includes("juruc_set_questions"));
			assert.equal(harness.instances[1].activeTools?.includes("bash"), false);
			assert.equal(harness.instances[1].activeTools?.includes("edit"), false);
			assert.ok(harness.instances[4].activeTools?.includes("juruc_set_plan"));
			assert.equal(harness.instances[4].activeTools?.includes("write"), false);
			assert.ok(harness.instances[5].activeTools?.includes("juruc_run_verification"));
			assert.ok(harness.instances[5].activeTools?.includes("juruc_finish_phase"));
			assert.equal(harness.instances[5].activeTools?.includes("bash"), false);
			assert.equal(harness.instances[5].activeTools?.includes("juruc_set_plan"), false);
			for (const instance of harness.instances.slice(1))
				assert.deepEqual(instance.toolActivations.at(-1), []);

			const sessionText = (kind: "questions" | "research" | "specification" | "plan") => {
				const path = findTaskSession(task.document, { kind })!.path;
				return readFileSync(path, "utf8");
			};
			assert.match(sessionText("questions"), /Original request/);
			assert.match(sessionText("research"), /Confirmed Questions result/);
			assert.match(sessionText("specification"), /Research report/);
			assert.doesNotMatch(sessionText("specification"), /Implementation phase/);
			assert.match(sessionText("plan"), /Validated Specification/);
			assert.doesNotMatch(sessionText("plan"), /Research report|sharedUnderstanding/);
			const implementationPath = findTaskSession(task.document, {
				kind: "implementation",
				phase: 1,
			})!.path;
			const implementationText = readFileSync(implementationPath, "utf8");
			assert.match(implementationText, /Validated Specification/);
			assert.match(implementationText, /Authoritative current phase/);
			assert.match(implementationText, /not declared by the active phase/);
			assert.match(implementationText, /phase one verified/);
			assert.doesNotMatch(implementationText, /Research report|sharedUnderstanding/);
			assert.equal(existsSync(join(task.document.repository.worktree, "undeclared.txt")), false);
			assert.equal(git(task.document.repository.worktree, "status", "--porcelain"), "");
			assert.equal(
				git(task.document.repository.worktree, "log", "-2", "--format=%s"),
				"Connect runtime workflow\nImplement runtime workflow",
			);

			const staleSessions = [
				findTaskSession(task.document, { kind: "research" })!.path,
				findTaskSession(task.document, { kind: "plan" })!.path,
				findTaskSession(task.document, { kind: "implementation", phase: 1 })!.path,
			];
			for (const stale of staleSessions) {
				await harness.runtime.switchSession(stale);
				assert.deepEqual(harness.instances.at(-1)!.pi.getActiveTools(), []);
			}
			harness.instances.at(-1)!.pi.setActiveTools(["juruc_run_verification"]);
			harness.setResponses([
				fauxAssistantMessage([
					fauxToolCall("juruc_run_verification", { command: phaseOneVerification }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage("Stopped.", { stopReason: "stop" }),
			]);
			await harness.runtime.session.prompt("Try a stale tool.");
			assert.match(readFileSync(staleSessions.at(-1)!, "utf8"), /run \/juruc to resume/);
		} finally {
			await activeReviewServer.close();
			await harness.dispose();
		}
	});

	await test("review preparation is resumable, sequential, and crash-safe", async () => {
		const root = join(scratch, "review-preparation");
		mkdirSync(root);
		const worktree = join(root, "worktree");
		const source = join(root, "source");
		mkdirSync(worktree);
		mkdirSync(source);
		const freshTask = () => {
			const task = demoReviewTask();
			task.repository.sourceRoot = source;
			task.repository.worktree = worktree;
			task.sessions = [];
			task.reviewRounds[0].reviewers = { deviation: null, correctness: null };
			return task;
		};
		const patch = demoReviewPatch();
		const failedPath = join(root, "patch-failed.json");
		saveTaskDocument(failedPath, freshTask());
		let failedDriverCalls = 0;
		await assert.rejects(
			prepareReview({
				taskPath: failedPath,
				readPatch: async () => { throw new Error("patch infrastructure failed"); },
				reviewerDriver: async () => {
					failedDriverCalls++;
					return { assistantMessages: [] };
				},
			}),
			/patch infrastructure failed/,
		);
		assert.equal(failedDriverCalls, 0);
		assert.deepEqual(loadTaskDocument(failedPath).reviewRounds[0].reviewers, {
			deviation: null,
			correctness: null,
		});

		const concurrentPath = join(root, "concurrent.json");
		saveTaskDocument(concurrentPath, freshTask());
		let releaseDeviation!: () => void;
		const deviationGate = new Promise<void>((resolve) => { releaseDeviation = resolve; });
		let signalDeviationStarted!: () => void;
		const deviationStarted = new Promise<void>((resolve) => { signalDeviationStarted = resolve; });
		const concurrentCalls: string[] = [];
		const firstPreparation = prepareReview({
			taskPath: concurrentPath,
			readPatch: async () => patch,
			reviewerDriver: async ({ kind }) => {
				concurrentCalls.push(kind);
				if (kind === "deviation") {
					signalDeviationStarted();
					await deviationGate;
				}
				return {
					assistantMessages: [{
						role: "assistant",
						content: [{ type: "text", text: '{"annotations":[]}' }],
						stopReason: "stop",
					}],
				};
			},
		});
		await deviationStarted;
		const running = loadTaskDocument(concurrentPath).reviewRounds[0];
		assert.equal(running.reviewers.deviation?.outcome, null);
		assert.equal(running.reviewers.correctness, null);
		let secondPatchReads = 0;
		let secondDriverCalls = 0;
		await assert.rejects(
			prepareReview({
				taskPath: concurrentPath,
				readPatch: async () => {
					secondPatchReads++;
					return patch;
				},
				reviewerDriver: async () => {
					secondDriverCalls++;
					return { assistantMessages: [] };
				},
			}),
			/another review operation already owns/,
		);
		assert.equal(secondPatchReads, 0);
		assert.equal(secondDriverCalls, 0);
		assert.deepEqual(concurrentCalls, ["deviation"]);
		const stillRunning = loadTaskDocument(concurrentPath).reviewRounds[0];
		assert.equal(stillRunning.reviewers.deviation?.outcome, null);
		assert.equal(stillRunning.reviewers.correctness, null);
		releaseDeviation();
		await firstPreparation;
		assert.deepEqual(concurrentCalls, ["deviation", "correctness"]);
		assert.equal(existsSync(`${concurrentPath}.review.lock`), false);

		const advisoryPath = join(root, "advisory.json");
		saveTaskDocument(advisoryPath, freshTask());
		const calls: string[] = [];
		await prepareReview({
			taskPath: advisoryPath,
			readPatch: async () => patch,
			reviewerDriver: async ({ kind }) => {
				calls.push(kind);
				return {
					assistantMessages: [{
						role: "assistant",
						content: [{ type: "text", text: '{"annotations":[]}' }],
						stopReason: kind === "deviation" ? "error" : "stop",
						errorMessage: kind === "deviation" ? "provider failed" : undefined,
					}],
				};
			},
		});
		const advisory = loadTaskDocument(advisoryPath).reviewRounds[0];
		assert.deepEqual(calls, ["deviation", "correctness"]);
		assert.equal(advisory.reviewers.deviation?.outcome?.status, "failed");
		assert.equal(advisory.reviewers.correctness?.outcome?.status, "completed");

		const interruptedPath = join(root, "interrupted.json");
		let interrupted = registerTaskReviewerStart(
			freshTask(),
			"deviation",
			join(root, "interrupted-session.jsonl"),
		);
		saveTaskDocument(interruptedPath, interrupted);
		const resumedCalls: string[] = [];
		await prepareReview({
			taskPath: interruptedPath,
			readPatch: async () => patch,
			reviewerDriver: async ({ kind }) => {
				resumedCalls.push(kind);
				return {
					assistantMessages: [{
						role: "assistant",
						content: [{ type: "text", text: '{"annotations":[]}' }],
						stopReason: "stop",
					}],
				};
			},
		});
		interrupted = loadTaskDocument(interruptedPath);
		assert.deepEqual(resumedCalls, ["correctness"]);
		assert.equal(
			interrupted.reviewRounds[0].reviewers.deviation?.outcome?.status,
			"failed",
		);
		assert.match(
			interrupted.reviewRounds[0].reviewers.deviation?.outcome?.status === "failed"
				? interrupted.reviewRounds[0].reviewers.deviation!.outcome.message
				: "",
			/interrupted/,
		);
		await prepareReview({
			taskPath: interruptedPath,
			readPatch: async () => patch,
			reviewerDriver: async () => {
				throw new Error("terminal reviewers must skip");
			},
		});
	});

	await test("Send Feedback runs corrections and fresh rounds, /juruc reroutes persisted decisions, and Approve reaches done", async () => {
		const source = join(scratch, "correction-flow");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");

		const paths = runtimePaths(agentDir);
		const slug = "correction-flow-task";
		const verification = "node -e \"console.log('verified')\"";
		const plan = {
			phases: [{
				id: "implement-change",
				title: "Implement change",
				goal: "Implement the candidate.",
				fileScopes: ["tracked.txt"],
				instructions: ["Never leak this plan rationale into a correction."],
				verification: [verification],
			}],
		};
		const reviewerCalls: string[] = [];
		const reviewerDriver = async ({ kind }: { kind: string }) => {
			reviewerCalls.push(kind);
			return {
				assistantMessages: [{
					role: "assistant",
					content: [{
						type: "text",
						text: kind === "deviation"
							? '{"annotations":[{"filePath":"tracked.txt","side":"additions","line":1,"summary":"The candidate line is terse."}]}'
							: '{"annotations":[]}',
					}],
					stopReason: "stop",
				}],
			};
		};
		const openedUrls: string[] = [];
		const written = new Set<string>();
		const synthesis = {
			agent: "synthesizer",
			task: "synthesize",
			output: "Independent verified facts.\n",
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

		const harness = await createRuntimeHarness({
			agentDir,
			cwd: source,
			sessionManager: SessionManager.create(source),
			promptTemplates: [],
			stubTools: ["delegate"],
			stubResult: (name) => name === "delegate" ? synthesis : undefined,
			registerJuruc: (pi) =>
				registerJuruc(pi, {
					reviewerDriver,
					openBrowser: async (url: string) => {
						openedUrls.push(url);
					},
				}),
			probe: (pi) => {
				pi.on("session_start", () => {
					try {
						const task = loadTask(paths, slug);
						const candidate = join(task.document.repository.worktree, "tracked.txt");
						if (task.document.stage === "implementation" && !written.has("phase")) {
							writeFileSync(candidate, "candidate\n");
							written.add("phase");
						}
						const round = currentTaskCorrectionRound(task.document);
						if (round && !written.has(`correction-${round.number}`)) {
							writeFileSync(candidate, `candidate corrected ${round.number}\n`);
							written.add(`correction-${round.number}`);
						}
					} catch {}
				});
			},
		});

		const correctionResponses = (round: number) => [
			fauxAssistantMessage(
				[fauxToolCall("juruc_run_verification", { command: verification })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("juruc_finish_correction", {
					resolution: `Applied every comment from round ${round}.`,
					commitMessage: `Apply review feedback ${round}`,
					verificationEvidence: [{
						command: verification,
						exitCode: 0,
						summary: "Correction verification passed.",
					}],
				})],
				{ stopReason: "toolUse" },
			),
		];
		const comment = {
			filePath: "tracked.txt",
			side: "additions",
			startLine: 1,
			endLine: 1,
			body: "Describe the candidate concretely.",
		};
		const post = async (url: URL, body: unknown): Promise<Response> =>
			fetch(url, {
				method: "POST",
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
			});
		const settle = async (done: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 600; attempt += 1) {
				if (done()) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(
				`JURUC did not settle the routed transition: ${JSON.stringify(harness.notices.slice(-4))}`,
			);
		};

		try {
			harness.selections.push("New task…");
			harness.editorValues.push("Correction flow task");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_questions", {
						sharedUnderstanding: "Implement and correct the candidate.",
						decisions: [],
						acceptedAssumptions: [],
						researchTargets: [],
					})],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize facts." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_specification", {
						summary: "Keep the candidate readable.",
						requirements: ["The candidate is readable."],
						nonGoals: [],
						constraints: [],
						acceptanceCriteria: ["Verification passes."],
						decisions: [],
					})],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", plan)], { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[fauxToolCall("juruc_run_verification", { command: verification })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_finish_phase", {
						resolution: "Implemented and verified.",
						commitMessage: "Implement candidate",
						verificationEvidence: [{
							command: verification,
							exitCode: 0,
							summary: "Verification passed.",
						}],
					})],
					{ stopReason: "toolUse" },
				),
			]);
			await harness.runtime.session.prompt("/juruc");
			assert.equal(loadTask(paths, slug).document.stage, "review");
			assert.deepEqual(reviewerCalls, ["deviation", "correctness"]);
			assert.equal(openedUrls.length, 1);
			assert.match(openedUrls[0], /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/\?/u);
			assert.ok(harness.notices.some((notice) => notice.includes(`review 1 is open at ${openedUrls[0]}`)));
			assert.ok(harness.widgets.includes("Q✓ R✓ S✓ P✓ I✓ · review 1 · awaiting decision"));

			const api = new URL("api/", openedUrls[0]);
			assert.equal((await post(new URL("comments", api), comment)).status, 201);
			harness.setResponses(correctionResponses(1));
			assert.equal((await post(new URL("decision", api), { kind: "send-feedback" })).status, 200);
			await settle(() => openedUrls.length === 2);

			const corrected = loadTask(paths, slug);
			assert.equal(corrected.document.stage, "review");
			assert.equal(corrected.document.reviewRounds.length, 2);
			const [firstRound, secondRound] = corrected.document.reviewRounds;
			assert.equal(firstRound.decision?.kind, "send-feedback");
			assert.equal(firstRound.humanComments.length, 1);
			assert.equal(firstRound.correction?.result?.resolution, "Applied every comment from round 1.");
			assert.deepEqual(firstRound.correction?.result?.verificationEvidence, [{
				command: verification,
				exitCode: 0,
				summary: "Correction verification passed.",
			}]);
			assert.equal(secondRound.number, 2);
			assert.equal(secondRound.baseCommit, corrected.document.repository.sourceHead);
			assert.equal(secondRound.headCommit, firstRound.correction?.result?.commit);
			assert.deepEqual(secondRound.humanComments, []);
			assert.equal(secondRound.reviewers.deviation?.outcome?.status, "completed");
			assert.equal(secondRound.reviewers.correctness?.outcome?.status, "completed");
			assert.deepEqual(reviewerCalls, ["deviation", "correctness", "deviation", "correctness"]);
			assert.equal(
				git(corrected.document.repository.worktree, "log", "-1", "--format=%s"),
				"Apply review feedback 1",
			);
			assert.equal(git(corrected.document.repository.worktree, "status", "--porcelain"), "");
			assert.ok(harness.widgets.includes("Q✓ R✓ S✓ P✓ I✓ · correction 1 · verifying"));
			assert.notEqual(openedUrls[1], openedUrls[0]);

			const correctionSession = findTaskSession(corrected.document, {
				kind: "correction",
				round: 1,
			})!.path;
			const correctionText = readFileSync(correctionSession, "utf8");
			assert.match(correctionText, /Describe the candidate concretely/);
			assert.match(correctionText, /Deviation reviewer: The candidate line is terse/);
			assert.match(correctionText, /Keep the candidate readable/);
			assert.doesNotMatch(correctionText, /Never leak this plan rationale/);

			// A persisted Send Feedback decision must route from state alone, exactly as it
			// does after a Pi restart that lost the deciding server.
			await activeReviewServer.close();
			const timestamp = "2026-08-03T00:00:00.000Z";
			saveTask(
				corrected,
				decideTaskReview(
					addTaskReviewComment(
						corrected.document,
						comment,
						"9abcdef0-1234-4234-8234-123456789abc",
						timestamp,
					),
					"send-feedback",
					timestamp,
				),
			);
			harness.selections.push(`Correction flow task — ${slug} · review`);
			harness.setResponses(correctionResponses(2));
			await harness.runtime.session.prompt("/juruc");
			await settle(() => openedUrls.length === 3);

			const restarted = loadTask(paths, slug);
			assert.equal(restarted.document.reviewRounds.length, 3);
			assert.equal(restarted.document.reviewRounds[1].correction?.result?.commit,
				restarted.document.reviewRounds[2].headCommit);
			assert.equal(
				git(restarted.document.repository.worktree, "log", "-1", "--format=%s"),
				"Apply review feedback 2",
			);
			assert.equal(new Set(openedUrls).size, 3);
			assert.ok(findTaskSession(restarted.document, { kind: "correction", round: 2 }));

			// Approve on the commentless third round reaches done and closes the live server.
			const finalApi = new URL("api/", openedUrls[2]);
			assert.equal((await post(new URL("decision", finalApi), { kind: "approve" })).status, 200);
			await settle(() => loadTask(paths, slug).document.stage === "done");
			const done = loadTask(paths, slug);
			assert.equal(done.document.reviewRounds.at(-1)?.decision?.kind, "approve");
			assert.equal(done.document.reviewRounds.at(-1)?.correction, null);
			await assert.rejects(fetch(new URL("state", finalApi)));
			assert.ok(harness.widgets.includes("Q✓ R✓ S✓ P✓ I✓ · done"));
			assert.ok(harness.notices.some((notice) => notice.includes(`${slug}: done · 1 phases`)));
		} finally {
			await activeReviewServer.close();
			await harness.dispose();
		}
		assert.equal(
			existsSync(join(loadTask(runtimePaths(agentDir), slug).directory, "task.json.review.lock")),
			false,
		);
	});

	await test("parallel synthesizer siblings cannot advance Research", async () => {
		const source = join(scratch, "parallel-source");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");
		const paths = runtimePaths(agentDir);
		let delegateExecutions = 0;
		const harness = await createRuntimeHarness({
			agentDir,
			cwd: source,
			sessionManager: SessionManager.create(source),
			promptTemplates: [],
			stubTools: ["delegate"],
			stubResult: () => {
				delegateExecutions++;
				return {
					agent: "synthesizer",
					output: "must not persist\n",
					stopReason: "stop",
					steps: [],
				};
			},
			registerJuruc,
		});
		try {
			harness.selections.push("New task…");
			harness.editorValues.push("Parallel synthesis guard");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_questions", {
					sharedUnderstanding: "Guard synthesis.",
					decisions: [],
					acceptedAssumptions: [],
					researchTargets: [],
				})], { stopReason: "toolUse" }),
				fauxAssistantMessage([
					fauxToolCall("delegate", { agent: "synthesizer", task: "first" }),
					fauxToolCall("delegate", { agent: "synthesizer", task: "second" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage("Research remains open.", { stopReason: "stop" }),
			]);
			await harness.runtime.session.prompt("/juruc");
			const task = loadTask(paths, "parallel-synthesis-guard");
			assert.equal(task.document.stage, "research");
			assert.equal(delegateExecutions, 0);
			assert.equal(existsSync(join(task.directory, "research.md")), false);
			assert.match(readFileSync(findTaskSession(task.document, { kind: "research" })!.path, "utf8"), /sole tool call/);
		} finally {
			await harness.dispose();
		}
	});

	await test("a missing ordinary declared stage tool fails clearly", async () => {
		const source = join(scratch, "missing-tool-source");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");
		const paths = runtimePaths(agentDir);
		const harness = await createRuntimeHarness({
			agentDir,
			cwd: source,
			sessionManager: SessionManager.create(source),
			promptTemplates: [],
			stubTools: ["delegate"],
			omitTools: ["grep"],
			registerJuruc,
		});
		try {
			harness.selections.push("New task…");
			harness.editorValues.push("Missing grep guard");
			harness.setResponses([
				fauxAssistantMessage("Cannot interview without every declared tool.", { stopReason: "stop" }),
			]);
			await harness.runtime.session.prompt("/juruc");
			assert.equal(loadTask(paths, "missing-grep-guard").document.stage, "questions");
			assert.deepEqual(harness.instances.at(-1)!.pi.getActiveTools(), []);
			assert.ok(harness.notices.some((notice) => /required questions tools are unavailable: grep/.test(notice)));
		} finally {
			await harness.dispose();
		}
	});
} finally {
	process.removeListener("exit", cleanup);
	cleanup();
}
