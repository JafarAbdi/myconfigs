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
		{ CLEARED_WIDGET, fauxAssistantMessage, fauxToolCall, createRuntimeHarness },
		{ SessionManager },
		{ prepareReview, registerJuruc },
		{ runtimePaths },
		{ loadTask, saveTask },
		{
			addTaskReviewComment,
			currentTaskCorrectionRound,
			currentTaskReviewRound,
			decideTaskReview,
			findTaskSession,
			loadTaskDocument,
			registerTaskReviewerStart,
			saveTaskDocument,
		},
		reviewServerModule,
		{ demoReviewPatch, demoReviewTask },
		{ PLAN_DECISION_TITLE, PLAN_DECISION_UNRESOLVED, PLAN_REVISION_TITLE },
	] = await Promise.all([
		import("./runtime-harness.ts"),
		import("@earendil-works/pi-coding-agent"),
		import("./index.ts"),
		import("./runtime.ts"),
		import("./tasks.ts"),
		import("./task.ts"),
		import("./review-server.ts"),
		import("./review-fixture.ts"),
		import("./planning.ts"),
	]);
	const { activeReviewServer } = reviewServerModule;
	const liveReviewUrl = (task: ReturnType<typeof loadTask>): string | undefined => {
		const round = currentTaskReviewRound(task.document);
		return round
			? activeReviewServer.liveUrl({
				taskPath: join(task.directory, "task.json"),
				baseCommit: round.baseCommit,
				headCommit: round.headCommit,
			})
			: undefined;
	};
	const requireLiveReviewUrl = (task: ReturnType<typeof loadTask>): string => {
		const url = liveReviewUrl(task);
		assert.ok(url, `${task.document.slug}: expected a live review URL`);
		return url;
	};
	assert.equal("openSystemBrowser" in reviewServerModule, false);

	await test("one explicit /juruc opens exactly one fresh Q, R, S, P, or implementation stage", async () => {
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
			registerJuruc: (pi) => registerJuruc(pi, { reviewerDriver }),
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

		// Every stage boundary stops; the operator's next /juruc resumes the owning task
		// directly, so only the very first invocation goes through the picker.
		const advance = async (responses: unknown[]) => {
			harness.setResponses(responses);
			await harness.runtime.session.prompt("/juruc");
		};

		try {
			harness.selections.push("New task…");
			harness.editorValues.push("QRSPI runtime workflow");
			await advance([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_questions", questions)],
					{ stopReason: "toolUse" },
				),
			]);
			const interviewed = loadTask(paths, slug);
			assert.equal(interviewed.document.stage, "research");
			assert.equal(findTaskSession(interviewed.document, { kind: "research" }), undefined);

			await advance([
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize facts." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
			]);
			assert.equal(loadTask(paths, slug).document.stage, "specification");

			await advance([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_specification", specification)],
					{ stopReason: "toolUse" },
				),
			]);
			assert.equal(loadTask(paths, slug).document.stage, "plan");

			harness.selections.push("Accept plan");
			await advance([
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", plan)], { stopReason: "toolUse" }),
				fauxAssistantMessage("Activation remains pending.", { stopReason: "stop" }),
			]);

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

			// A retried activation opens implementation phase 1 without reopening the picker.
			await advance([
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
			]);
			const checkpointed = loadTask(paths, slug);
			assert.equal(checkpointed.document.checkpoints.length, 1);
			assert.equal(
				findTaskSession(checkpointed.document, { kind: "implementation", phase: 2 }),
				undefined,
			);

			await advance([
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

			// The final checkpoint creates the round only: reviewers, the server, and the
			// browser wait for the explicit /juruc that opens Review.
			const committed = loadTask(paths, slug);
			assert.equal(committed.document.stage, "review");
			assert.deepEqual(committed.document.reviewRounds[0].reviewers, {
				deviation: null,
				correctness: null,
			});
			assert.deepEqual(reviewerCalls, []);
			assert.equal(liveReviewUrl(committed), undefined);
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 1 · Ready"));

			await advance([]);

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
			assert.match(requireLiveReviewUrl(task), /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/\?/u);
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
		const confirmedFeedback = {
			sharedUnderstanding: "INCLUDED_CONFIRMED_FEEDBACK",
			corrections: ["Describe the candidate concretely."],
			decisions: ["Keep the candidate readable."],
			acceptedAssumptions: [],
		};
		const correctionPlan = {
			goal: "INCLUDED_CORRECTION_PLAN",
			fileScopes: ["tracked.txt"],
			dependencies: [],
			instructions: ["Describe the candidate concretely."],
			verification: [verification],
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
		const servedUrls: string[] = [];
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
			registerJuruc: (pi) => registerJuruc(pi, { reviewerDriver }),
			probe: (pi, record) => {
				pi.on("session_start", () => {
					record.activeTools = pi.getActiveTools();
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

		const feedbackResponses = () => [
			fauxAssistantMessage(
				[fauxToolCall("juruc_set_feedback", confirmedFeedback)],
				{ stopReason: "toolUse" },
			),
		];
		const correctionPlanResponses = (proposal = correctionPlan) => [
			fauxAssistantMessage(
				[fauxToolCall("juruc_set_correction_plan", proposal)],
				{ stopReason: "toolUse" },
			),
		];
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

		const advance = async (responses: unknown[]) => {
			harness.setResponses(responses);
			await harness.runtime.session.prompt("/juruc");
		};
		const idle = async () => {
			await harness.runtime.session.agent.waitForIdle();
		};

		try {
			harness.selections.push("New task…");
			harness.editorValues.push("Correction flow task");
			await advance([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_questions", {
						sharedUnderstanding: "Implement and correct the candidate.",
						decisions: [],
						acceptedAssumptions: [],
						researchTargets: [],
					})],
					{ stopReason: "toolUse" },
				),
			]);
			await advance([
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize facts." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
			]);
			await advance([
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
			]);
			harness.selections.push("Accept plan");
			await advance([
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", plan)], { stopReason: "toolUse" }),
			]);
			await advance([
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
			assert.deepEqual(reviewerCalls, []);
			await advance([]);
			const opened = loadTask(paths, slug);
			assert.equal(opened.document.stage, "review");
			assert.deepEqual(reviewerCalls, ["deviation", "correctness"]);
			const firstUrl = requireLiveReviewUrl(opened);
			servedUrls.push(firstUrl);
			assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/\?/u);
			assert.equal(harness.notices.some((notice) => notice.includes(firstUrl)), false);
			// RPC keeps its plain lifecycle fallback and does not expose or open the URL.
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 1 · Awaiting decision"));

			const api = new URL("api/", firstUrl);
			assert.equal((await post(new URL("comments", api), comment)).status, 201);
			const sessionsBeforeDecision = harness.instances.length;
			assert.equal((await post(new URL("decision", api), { kind: "send-feedback" })).status, 200);
			await settle(() => liveReviewUrl(loadTask(paths, slug)) === undefined);
			await idle();
			const decided = loadTask(paths, slug);
			assert.equal(harness.instances.length, sessionsBeforeDecision);
			assert.equal(findTaskSession(decided.document, { kind: "feedback-grill", round: 1 }), undefined);
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Feedback Grill 1 · Ready"));

			await advance(feedbackResponses());
			const grilled = loadTask(paths, slug);
			assert.equal(harness.instances.length, sessionsBeforeDecision + 1);
			assert.deepEqual(grilled.document.reviewRounds[0].correction?.feedbackGrill?.confirmedFeedback,
				confirmedFeedback);
			assert.equal(findTaskSession(grilled.document, { kind: "correction-plan", round: 1 }), undefined);
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction Plan 1 · Ready"));

			// Revise returns the exact words to the model; Cancel then persists nothing.
			const revision = "  Keep the correction bounded to the reviewed file.  ";
			harness.selections.push("Revise plan", "Cancel");
			harness.inputValues.push(revision);
			await advance([
				...correctionPlanResponses(),
				...correctionPlanResponses({ ...correctionPlan, instructions: [revision.trim()] }),
			]);
			const rejectedPlan = loadTask(paths, slug);
			assert.equal(harness.instances.length, sessionsBeforeDecision + 2);
			assert.equal(rejectedPlan.document.reviewRounds[0].correction?.correctionPlan?.acceptedPlan, null);
			const planSession = findTaskSession(rejectedPlan.document, { kind: "correction-plan", round: 1 })!.path;
			assert.match(readFileSync(planSession, "utf8"), /Keep the correction bounded to the reviewed file/);

			harness.selections.push(
				`Correction flow task — ${slug} · review`,
				"Accept plan",
			);
			await advance(correctionPlanResponses());
			const plannedCorrection = loadTask(paths, slug);
			assert.equal(harness.instances.length, sessionsBeforeDecision + 3);
			assert.deepEqual(plannedCorrection.document.reviewRounds[0].correction?.correctionPlan?.acceptedPlan,
				correctionPlan);
			assert.equal(findTaskSession(plannedCorrection.document, { kind: "correction", round: 1 }), undefined);
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction 1 · Ready"));

			await advance(correctionResponses(1));
			assert.equal(harness.instances.length, sessionsBeforeDecision + 4);
			assert.deepEqual(harness.instances[sessionsBeforeDecision].activeTools,
				["read", "grep", "find", "ls", "juruc_set_feedback"]);
			for (const index of [sessionsBeforeDecision + 1, sessionsBeforeDecision + 2])
				assert.deepEqual(harness.instances[index].activeTools,
					["read", "grep", "find", "ls", "juruc_set_correction_plan"]);
			assert.deepEqual(harness.instances[sessionsBeforeDecision + 3].activeTools, [
				"read", "edit", "write", "grep", "find", "ls",
				"juruc_run_verification", "juruc_finish_correction",
			]);
			assert.deepEqual(reviewerCalls, ["deviation", "correctness"]);
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction 1 · Implementing"));
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 2 · Ready"));
			await advance([]);

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
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction 1 · Implementing"));
			const secondUrl = requireLiveReviewUrl(corrected);
			servedUrls.push(secondUrl);
			assert.notEqual(secondUrl, firstUrl);

			const feedbackSession = findTaskSession(corrected.document, {
				kind: "feedback-grill",
				round: 1,
			})!.path;
			const correctionPlanSession = findTaskSession(corrected.document, {
				kind: "correction-plan",
				round: 1,
			})!.path;
			const correctionSession = findTaskSession(corrected.document, {
				kind: "correction",
				round: 1,
			})!.path;
			for (const path of [feedbackSession, correctionPlanSession, correctionSession]) {
				const [header] = readFileSync(path, "utf8").split("\n", 1);
				assert.equal(Object.hasOwn(JSON.parse(header), "parentSession"), false);
				assert.equal(realpathSync(SessionManager.open(path).getCwd()),
					realpathSync(corrected.document.repository.worktree));
			}
			const feedbackText = readFileSync(feedbackSession, "utf8");
			assert.match(feedbackText, /Describe the candidate concretely/);
			assert.match(feedbackText, /Keep the candidate readable/);
			assert.doesNotMatch(feedbackText, /Never leak this plan rationale|The candidate line is terse/);
			const correctionPlanText = readFileSync(correctionPlanSession, "utf8");
			assert.match(correctionPlanText, /INCLUDED_CONFIRMED_FEEDBACK/);
			assert.doesNotMatch(correctionPlanText, /Never leak this plan rationale|The candidate line is terse/);
			const correctionText = readFileSync(correctionSession, "utf8");
			assert.match(correctionText, /INCLUDED_CONFIRMED_FEEDBACK/);
			assert.match(correctionText, /INCLUDED_CORRECTION_PLAN/);
			assert.doesNotMatch(correctionText, /Never leak this plan rationale|The candidate line is terse/);

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
			const sessionsBeforeRestartedFlow = harness.instances.length;
			await advance(feedbackResponses());
			harness.selections.push("Accept plan");
			await advance(correctionPlanResponses());
			await advance(correctionResponses(2));
			assert.equal(harness.instances.length, sessionsBeforeRestartedFlow + 3);
			await advance([]);

			const restarted = loadTask(paths, slug);
			const finalUrl = requireLiveReviewUrl(restarted);
			servedUrls.push(finalUrl);
			assert.equal(restarted.document.reviewRounds.length, 3);
			assert.equal(restarted.document.reviewRounds[1].correction?.result?.commit,
				restarted.document.reviewRounds[2].headCommit);
			assert.equal(
				git(restarted.document.repository.worktree, "log", "-1", "--format=%s"),
				"Apply review feedback 2",
			);
			assert.equal(new Set(servedUrls).size, 3);
			assert.ok(findTaskSession(restarted.document, { kind: "correction", round: 2 }));

			// Approve on the commentless third round reaches done and closes the live server.
			const finalApi = new URL("api/", finalUrl);
			const sessionsBeforeApproval = harness.instances.length;
			assert.equal((await post(new URL("decision", finalApi), { kind: "approve" })).status, 200);
			await settle(() => loadTask(paths, slug).document.stage === "done");
			const done = loadTask(paths, slug);
			assert.equal(done.document.reviewRounds.at(-1)?.decision?.kind, "approve");
			assert.equal(done.document.reviewRounds.at(-1)?.correction, null);
			await assert.rejects(fetch(new URL("state", finalApi)));
			assert.ok(harness.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Done"));
			// The completed task shows branch, worktree, and short approved HEAD only.
			const approvedHead = git(done.document.repository.worktree, "rev-parse", "HEAD");
			const summary =
				`${slug}: done · ${done.document.repository.branch} · ${done.document.repository.worktree} · ${approvedHead.slice(0, 12)}`;
			assert.ok(harness.notices.includes(summary));
			assert.equal(done.document.reviewRounds.at(-1)?.headCommit, approvedHead);
			assert.equal(harness.instances.length, sessionsBeforeApproval);

			// Enter on the done task summarizes again without a session switch or Plan.
			harness.selections.push(`Correction flow task — ${slug} · done`);
			await harness.runtime.session.prompt("/juruc");
			assert.equal(loadTask(paths, slug).document.stage, "done");
			assert.equal(harness.instances.length, sessionsBeforeApproval);
			assert.deepEqual(
				harness.notices.filter((notice) => notice.startsWith(`${slug}: done · `)),
				[summary, summary],
			);
			// Across every round and every served URL, an RPC session rendered plain lines only.
			assert.equal(harness.widgets.some((line) => line.includes("\x1b]8;;")), false);
			assert.equal(
				harness.widgets.some((line) => servedUrls.some((url) => line.includes(url))),
				false,
			);
		} finally {
			await activeReviewServer.close();
			await harness.dispose();
		}
		assert.equal(
			existsSync(join(loadTask(runtimePaths(agentDir), slug).directory, "task.json.review.lock")),
			false,
		);
	});

	await test("one TUI Enter crosses each stage boundary, keeps drafts, and survives restart", async () => {
		const source = join(scratch, "restart-flow");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");

		const paths = runtimePaths(agentDir);
		const slug = "restart-flow-task";
		const verification = "node -e \"console.log('verified')\"";
		const plan = {
			phases: [
				{
					id: "implement-change",
					title: "Implement change",
					goal: "Implement the candidate.",
					fileScopes: ["tracked.txt"],
					instructions: ["Write the candidate."],
					verification: [verification],
				},
				{
					id: "connect-change",
					title: "Connect change",
					goal: "Complete the candidate.",
					fileScopes: ["tracked.txt"],
					instructions: ["Write the integrated candidate."],
					verification: [verification],
				},
			],
		};
		const confirmedFeedback = {
			sharedUnderstanding: "Describe the candidate concretely.",
			corrections: ["Describe the candidate concretely."],
			decisions: [],
			acceptedAssumptions: [],
		};
		const correctionPlan = {
			goal: "Describe the candidate concretely.",
			fileScopes: ["tracked.txt"],
			dependencies: [],
			instructions: ["Update the candidate description."],
			verification: [verification],
		};
		const servedUrls: string[] = [];
		const reviewerCalls: string[] = [];
		const written = new Set<number>();
		// The TUI picker resolves through its custom component instead of a select dialog.
		const picks: unknown[] = [];
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
		const runtime = () =>
			createRuntimeHarness({
				agentDir,
				cwd: source,
				sessionManager: SessionManager.create(source),
				promptTemplates: [],
				mode: "tui",
				custom: async () => picks.shift(),
				stubTools: ["delegate"],
				stubResult: (name) => name === "delegate" ? synthesis : undefined,
				registerJuruc: (pi) =>
					registerJuruc(pi, {
						reviewerDriver: async ({ kind }: { kind: string }) => {
							reviewerCalls.push(kind);
							return {
								assistantMessages: [{
									role: "assistant",
									content: [{ type: "text", text: '{"annotations":[]}' }],
									stopReason: "stop",
								}],
							};
						},
					}),
				probe: (pi) => {
					pi.on("session_start", () => {
						try {
							const task = loadTask(paths, slug);
							const phase = task.document.checkpoints.length;
							if (task.document.stage === "implementation" && !written.has(phase)) {
								writeFileSync(
									join(task.document.repository.worktree, "tracked.txt"),
									`candidate ${phase + 1}\n`,
								);
								written.add(phase);
							}
							// Negative keys are correction rounds; positive ones are phase positions.
							const round = currentTaskCorrectionRound(task.document);
							if (round && !written.has(-round.number)) {
								writeFileSync(
									join(task.document.repository.worktree, "tracked.txt"),
									`candidate corrected ${round.number}\n`,
								);
								written.add(-round.number);
							}
						} catch {}
					});
				},
			});

		// One Pi runtime creates the task and runs a genuine multi-turn interview: the
		// confirmation arrives on a later user prompt, not on the kickoff turn.
		const interrupted = await runtime();
		let questionsSession: string;
		try {
			picks.push({ action: "new" });
			interrupted.editorValues.push("Restart flow task");
			interrupted.setResponses([
				fauxAssistantMessage("Which outcome do you want?", { stopReason: "stop" }),
			]);
			await interrupted.runtime.session.prompt("/juruc");
			const asking = loadTask(paths, slug);
			assert.equal(asking.document.stage, "questions");
			assert.equal(interrupted.getEditorText(), "");
			assert.ok(interrupted.widgets.includes("● Q  ○ R  ○ S  ○ P  ○ I   Questions"));
			questionsSession = findTaskSession(asking.document, { kind: "questions" })!.path;

			// An occupied editor is never touched, so the result text may not promise Enter.
			interrupted.setEditorText("half-written answer");
			interrupted.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_questions", {
						sharedUnderstanding: "Implement and review the candidate.",
						decisions: [],
						acceptedAssumptions: [],
						researchTargets: [],
					})],
					{ stopReason: "toolUse" },
				),
			]);
			await interrupted.runtime.session.prompt("The terminal outcome.");
			const pending = loadTask(paths, slug);
			assert.equal(pending.document.stage, "research");
			assert.equal(findTaskSession(pending.document, { kind: "research" }), undefined);
			assert.equal(interrupted.getEditorText(), "half-written answer");
			const interviewText = readFileSync(questionsSession, "utf8");
			assert.match(interviewText, /Questions confirmed\. Research ready\./);
			assert.doesNotMatch(interviewText, /Press Enter/);
			assert.ok(interrupted.widgets.includes("✓ Q  ○ R  ○ S  ○ P  ○ I   Research · Ready"));
			assert.equal(picks.length, 0);
		} finally {
			await interrupted.dispose();
		}

		// A fresh runtime lost only the editor text; /juruc resumes from task.json alone.
		const resumed = await runtime();
		try {
			assert.equal(resumed.getEditorText(), "");
			picks.push({ action: "select", slug });
			resumed.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize facts." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
			]);
			await resumed.runtime.session.prompt("/juruc");
			const researched = loadTask(paths, slug);
			assert.equal(researched.document.stage, "specification");
			assert.equal(findTaskSession(researched.document, { kind: "questions" })!.path, questionsSession);
			assert.equal(findTaskSession(researched.document, { kind: "specification" }), undefined);
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.notices.includes(
				`${slug}: research saved. Specification ready. Press Enter to continue.`,
			));
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ○ S  ○ P  ○ I   Specification · Ready"));

			// From here every boundary is one Enter on the pre-filled command, and the owning
			// session resumes its own task without ever showing the picker again.
			resumed.setResponses([
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
			]);
			await resumed.submitEditor();
			assert.equal(loadTask(paths, slug).document.stage, "plan");
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ○ P  ○ I   Plan · Ready"));

			resumed.selections.push("Accept plan");
			resumed.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", plan)], { stopReason: "toolUse" }),
			]);
			await resumed.submitEditor();
			const planned = loadTask(paths, slug);
			assert.equal(planned.document.stage, "implementation");
			assert.equal(findTaskSession(planned.document, { kind: "implementation", phase: 1 }), undefined);
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ○ I   Phase 1/2 · Ready"));

			const phaseResponses = (position: number) => [
				fauxAssistantMessage(
					[fauxToolCall("juruc_run_verification", { command: verification })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_finish_phase", {
						resolution: "Implemented and verified.",
						commitMessage: `Implement candidate ${position}`,
						verificationEvidence: [{
							command: verification,
							exitCode: 0,
							summary: "Verification passed.",
						}],
					})],
					{ stopReason: "toolUse" },
				),
			];
			resumed.setResponses(phaseResponses(1));
			await resumed.submitEditor();
			assert.equal(loadTask(paths, slug).document.checkpoints.length, 1);
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ○ I   Phase 2/2 · Ready"));

			resumed.setResponses(phaseResponses(2));
			await resumed.submitEditor();
			const committed = loadTask(paths, slug);
			assert.equal(committed.document.stage, "review");
			assert.equal(committed.document.checkpoints.length, 2);
			// Reviewers and the server both wait for the Enter that opens Review.
			assert.deepEqual(reviewerCalls, []);
			assert.equal(liveReviewUrl(committed), undefined);
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 1 · Ready"));

			await resumed.submitEditor();
			const task = loadTask(paths, slug);
			assert.deepEqual(reviewerCalls, ["deviation", "correctness"]);
			const firstUrl = requireLiveReviewUrl(task);
			servedUrls.push(firstUrl);
			// Review is the last stage before a human decision, so nothing is pre-filled.
			assert.equal(resumed.getEditorText(), "");
			assert.equal(picks.length, 0);
			const action = "Open review ↗";
			// The harness renders at width 80 and the action is pinned to the right edge.
			const linked = (url: string) => {
				const left = "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 1 · Awaiting decision";
				const pad = " ".repeat(80 - left.length - action.length);
				return `${left}${pad}\x1b]8;;${url}\x07${action}\x1b]8;;\x07`;
			};
			assert.ok(resumed.widgets.includes(linked(firstUrl)));
			assert.equal(resumed.notices.some((notice) => notice.includes(firstUrl)), false);

			// /juruc on the same open review reuses the live capability URL without opening it.
			await resumed.runtime.session.prompt("/juruc");
			assert.equal(requireLiveReviewUrl(loadTask(paths, slug)), firstUrl);
			assert.equal(loadTask(paths, slug).document.reviewRounds.length, 1);

			// Once the server process is gone, /juruc issues a fresh capability URL.
			await activeReviewServer.close();
			await resumed.runtime.session.prompt("/juruc");
			const replacementUrl = requireLiveReviewUrl(loadTask(paths, slug));
			servedUrls.push(replacementUrl);
			assert.notEqual(replacementUrl, firstUrl);
			assert.equal(new URL(replacementUrl).pathname === new URL(firstUrl).pathname, false);
			assert.ok(resumed.widgets.includes(linked(replacementUrl)));
			assert.equal(resumed.widgets.filter((line) => line.includes(firstUrl)).length, 2);

			// The browser only records the decision. Each following pre-filled Enter opens
			// exactly one fresh nested session, in order.
			const api = new URL("api/", replacementUrl);
			const post = async (path: string, body: unknown): Promise<Response> =>
				fetch(new URL(path, api), {
					method: "POST",
					body: JSON.stringify(body),
					headers: { "content-type": "application/json" },
				});
			assert.equal((await post("comments", {
				filePath: "tracked.txt",
				side: "additions",
				startLine: 1,
				endLine: 1,
				body: "Describe the candidate concretely.",
			})).status, 201);
			const sessionsBeforeDecision = resumed.instances.length;
			assert.equal((await post("decision", { kind: "send-feedback" })).status, 200);
			for (let attempt = 0; resumed.getEditorText() !== "/juruc"; attempt += 1) {
				if (attempt === 200) throw new Error("Send Feedback did not offer Feedback Grill");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(resumed.instances.length, sessionsBeforeDecision);
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Feedback Grill 1 · Ready"));

			resumed.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_feedback", confirmedFeedback)],
					{ stopReason: "toolUse" }),
			]);
			await resumed.submitEditor();
			assert.equal(resumed.instances.length, sessionsBeforeDecision + 1);
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction Plan 1 · Ready"));

			resumed.selections.push("Accept plan");
			resumed.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_correction_plan", correctionPlan)],
					{ stopReason: "toolUse" }),
			]);
			await resumed.submitEditor();
			assert.equal(resumed.instances.length, sessionsBeforeDecision + 2);
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Correction 1 · Ready"));

			resumed.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("juruc_run_verification", { command: verification })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("juruc_finish_correction", {
						resolution: "Applied every comment from round 1.",
						commitMessage: "Apply review feedback 1",
						verificationEvidence: [{
							command: verification,
							exitCode: 0,
							summary: "Correction verification passed.",
						}],
					})],
					{ stopReason: "toolUse" },
				),
			]);
			await resumed.submitEditor();
			assert.equal(resumed.instances.length, sessionsBeforeDecision + 3);
			assert.equal(liveReviewUrl(loadTask(paths, slug)), undefined);
			assert.equal(resumed.getEditorText(), "/juruc");
			assert.ok(resumed.widgets.includes("✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Review 2 · Ready"));

			await resumed.submitEditor();
			servedUrls.push(requireLiveReviewUrl(loadTask(paths, slug)));
			assert.equal(servedUrls.length, 3);
			assert.deepEqual(reviewerCalls, [
				"deviation",
				"correctness",
				"deviation",
				"correctness",
			]);
			assert.equal(picks.length, 0);
		} finally {
			await activeReviewServer.close();
			await resumed.dispose();
		}
	});

	await test("deleting the task owning this worktree session lands safely and still creates tasks", async () => {
		const source = join(scratch, "active-deletion");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");

		const paths = runtimePaths(agentDir);
		const slug = "active-deletion-task";
		// The exact slug whose valid syntax the removed cwd used to make Git deny.
		const nextSlug = "i-want-to-support-terminal-based";
		const verification = "node -e \"console.log('verified')\"";
		const plan = {
			phases: [{
				id: "implement-change",
				title: "Implement change",
				goal: "Implement the candidate.",
				fileScopes: ["tracked.txt"],
				instructions: ["Write the candidate."],
				verification: [verification],
			}],
		};
		const picks: unknown[] = [];
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
			mode: "tui",
			custom: async () => picks.shift(),
			stubTools: ["delegate"],
			stubResult: (name) => name === "delegate" ? synthesis : undefined,
			registerJuruc: (pi) =>
				registerJuruc(pi, {
					reviewerDriver: async () => ({
						assistantMessages: [{
							role: "assistant",
							content: [{ type: "text", text: '{"annotations":[]}' }],
							stopReason: "stop",
						}],
					}),
				}),
			probe: (pi) => {
				pi.on("session_start", () => {
					try {
						const task = loadTask(paths, slug);
						if (task.document.stage === "implementation" && !written.has("phase")) {
							writeFileSync(
								join(task.document.repository.worktree, "tracked.txt"),
								"candidate\n",
							);
							written.add("phase");
						}
					} catch {}
				});
			},
		});

		// Each pre-filled Enter opens exactly one stage, all the way to the open review.
		const enter = async (responses: unknown[]) => {
			harness.setResponses(responses);
			await harness.submitEditor();
		};

		try {
			picks.push({ action: "new" });
			harness.editorValues.push("Active deletion task");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("juruc_set_questions", {
						sharedUnderstanding: "Implement and complete the candidate.",
						decisions: [],
						acceptedAssumptions: [],
						researchTargets: [],
					})],
					{ stopReason: "toolUse" },
				),
			]);
			await harness.runtime.session.prompt("/juruc");
			await enter([
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize facts." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
			]);
			await enter([
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
			]);
			harness.selections.push("Accept plan");
			await enter([
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", plan)], { stopReason: "toolUse" }),
			]);
			await enter([
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
			await enter([]);
			assert.equal(picks.length, 0);

			const reviewed = loadTask(paths, slug);
			assert.equal(reviewed.document.stage, "review");
			const worktree = reviewed.document.repository.worktree;
			// The final implementation session is still live and its cwd is that worktree.
			assert.equal(realpathSync(harness.instances.at(-1)!.cwd!), realpathSync(worktree));
			await activeReviewServer.close();
			const completed = saveTask(
				reviewed,
				decideTaskReview(reviewed.document, "approve", "2026-08-03T00:00:00.000Z"),
			);
			assert.equal(completed.document.stage, "done");
			const questionsSession = findTaskSession(completed.document, { kind: "questions" })!.path;

			// An unavailable landing session refuses the deletion and keeps the picker.
			const questionsBytes = readFileSync(questionsSession);
			rmSync(questionsSession);
			const instancesBeforeRefusal = harness.instances.length;
			picks.push({ action: "remove", slug }, { action: "cancel" });
			await harness.runtime.session.prompt("/juruc");
			assert.ok(harness.notices.includes(
				`${slug}: deletion failed — its Questions session is unavailable`,
			));
			assert.equal(harness.instances.length, instancesBeforeRefusal);
			assert.equal(existsSync(worktree), true);
			assert.equal(existsSync(completed.directory), true);
			assert.equal(gitSucceeds(source, "show-ref", "--verify", "--quiet", `refs/heads/${slug}`), true);
			assert.equal(harness.getEditorText(), "");
			writeFileSync(questionsSession, questionsBytes, { mode: 0o600 });

			// Deleting the current worktree session's own task switches first, removes second.
			picks.push({ action: "remove", slug });
			harness.confirmations.push(true);
			await harness.runtime.session.prompt("/juruc");
			assert.ok(harness.notices.includes(`${slug}: task and worktree removed; branch retained`));
			assert.equal(existsSync(worktree), false);
			assert.equal(existsSync(completed.directory), false);
			assert.equal(gitSucceeds(source, "show-ref", "--verify", "--quiet", `refs/heads/${slug}`), true);
			assert.equal(harness.instances.length, instancesBeforeRefusal + 1);
			assert.equal(realpathSync(harness.instances.at(-1)!.cwd!), realpathSync(source));
			// The replacement session painted the stale Done line before the deletion cleared it.
			assert.equal(harness.widgets.at(-2), "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I   Done");
			assert.equal(harness.widgets.at(-1), CLEARED_WIDGET);
			assert.equal(harness.getEditorText(), "/juruc");

			// One Enter on the pre-filled command creates the next task from the source repository.
			picks.push({ action: "new" });
			harness.editorValues.push("I want to support terminal based");
			await enter([
				fauxAssistantMessage("Which outcome do you want?", { stopReason: "stop" }),
			]);
			assert.equal(harness.getEditorText(), "");
			assert.equal(loadTask(paths, nextSlug).document.stage, "questions");
			assert.equal(harness.notices.some((notice) => notice.includes("invalid Git branch name")), false);

			// A task that does not own the current cwd is removed in place, keeping the picker.
			const instancesBeforeOrdinary = harness.instances.length;
			picks.push({ action: "remove", slug: nextSlug }, { action: "cancel" });
			harness.confirmations.push(true);
			await harness.runtime.session.prompt("/juruc");
			assert.ok(harness.notices.includes(`${nextSlug}: task removed; branch retained if present`));
			assert.equal(existsSync(join(paths.tasks, nextSlug)), false);
			assert.equal(harness.instances.length, instancesBeforeOrdinary);
		} finally {
			await activeReviewServer.close();
			await harness.dispose();
		}
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
			]);
			await harness.runtime.session.prompt("/juruc");
			harness.setResponses([
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

	await test("the native plan selector owns acceptance, and only Accept touches the workspace", async () => {
		const source = join(scratch, "plan-decision");
		mkdirSync(source);
		git(source, "init", "-b", "main");
		git(source, "config", "user.name", "JURUC pipeline test");
		git(source, "config", "user.email", "juruc-pipeline@example.invalid");
		writeFileSync(join(source, "tracked.txt"), "baseline\n");
		git(source, "add", "-A");
		git(source, "commit", "-m", "baseline");

		const paths = runtimePaths(agentDir);
		const slug = "plan-decision-task";
		const verification = "node -e \"console.log('verified')\"";
		const phase = (id: string, title: string) => ({
			id,
			title,
			goal: "Implement the candidate.",
			fileScopes: ["tracked.txt"],
			instructions: ["Write the candidate."],
			verification: [verification],
		});
		const proposed = { phases: [phase("implement-change", "Implement change")] };
		const revised = {
			phases: [phase("implement-change", "Implement change"), phase("connect-change", "Connect change")],
		};
		const feedback = "  Split the work into two phases.\nKeep each verification exact.  ";
		// The picker resolves through its TUI component, so every select is a plan decision.
		const picks: unknown[] = [];
		const decisions: Array<string | undefined> = [];
		const feedbacks: Array<string | undefined> = [];
		const shown: Array<{ title: string; options: string[] }> = [];
		const asked: string[] = [];
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
			mode: "tui",
			custom: async () => picks.shift(),
			select: async (title: string, options: string[]) => {
				shown.push({ title, options: [...options] });
				return decisions.shift();
			},
			input: async (title: string) => {
				asked.push(title);
				return feedbacks.shift();
			},
			stubTools: ["delegate"],
			stubResult: (name) => name === "delegate" ? synthesis : undefined,
			registerJuruc,
		});

		const branchExists = () =>
			gitSucceeds(source, "show-ref", "--verify", "--quiet", `refs/heads/${slug}`);
		const propose = async (message: string, sent: unknown) => {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", sent)], { stopReason: "toolUse" }),
				fauxAssistantMessage("The plan stands as presented.", { stopReason: "stop" }),
			]);
			await harness.runtime.session.prompt(message);
		};

		try {
			picks.push({ action: "new" });
			harness.editorValues.push("Plan decision task");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_questions", {
					sharedUnderstanding: "Decide the plan through the selector.",
					decisions: [],
					acceptedAssumptions: [],
					researchTargets: [],
				})], { stopReason: "toolUse" }),
			]);
			await harness.runtime.session.prompt("/juruc");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("delegate", { agent: "synthesizer", task: "Synthesize facts." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Research complete.", { stopReason: "stop" }),
			]);
			await harness.runtime.session.prompt("/juruc");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_specification", {
					summary: "Keep the candidate readable.",
					requirements: ["The candidate is readable."],
					nonGoals: [],
					constraints: [],
					acceptanceCriteria: ["Verification passes."],
					decisions: [],
				})], { stopReason: "toolUse" }),
			]);
			await harness.runtime.session.prompt("/juruc");
			assert.equal(loadTask(paths, slug).document.stage, "plan");

			// Revise keeps the turn: the model gets the operator's exact words back, presents the
			// replacement plan, and reaches the selector again without anything having moved.
			decisions.push("Revise plan", "Cancel");
			feedbacks.push(feedback);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", proposed)], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("juruc_set_plan", revised)], { stopReason: "toolUse" }),
				fauxAssistantMessage("The plan stands as presented.", { stopReason: "stop" }),
			]);
			await harness.runtime.session.prompt("/juruc");

			const rejected = loadTask(paths, slug);
			const planSession = findTaskSession(rejected.document, { kind: "plan" })!.path;
			assert.equal(rejected.document.stage, "plan");
			assert.equal(rejected.document.plan, null);
			assert.equal(branchExists(), false);
			assert.equal(existsSync(rejected.document.repository.worktree), false);
			const revisedSession = readFileSync(planSession, "utf8");
			assert.ok(revisedSession.includes("Operator revision feedback:"));
			const revisionResult = SessionManager.open(planSession).getBranch().find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "juruc_set_plan" &&
					entry.message.content.some(
						(part) => part.type === "text" && part.text.includes("Operator revision feedback:"),
					),
			);
			assert.ok(revisionResult?.type === "message" && revisionResult.message.role === "toolResult");
			const revisionText = revisionResult.message.content.find((part) => part.type === "text")?.text;
			assert.ok(revisionText?.includes(feedback));
			assert.deepEqual(asked, [PLAN_REVISION_TITLE]);
			assert.equal(shown.length, 2);

			// An abandoned feedback dialog and Esc likewise decide nothing at all.
			decisions.push("Revise plan", undefined);
			feedbacks.push(undefined);
			for (const attempt of ["Reconsider the plan.", "One more look."]) {
				await propose(attempt, proposed);
				assert.deepEqual(loadTask(paths, slug).document, rejected.document);
				assert.equal(branchExists(), false);
				assert.equal(existsSync(rejected.document.repository.worktree), false);
			}
			assert.deepEqual(asked, [PLAN_REVISION_TITLE, PLAN_REVISION_TITLE]);
			assert.ok(readFileSync(planSession, "utf8").includes(PLAN_DECISION_UNRESOLVED));

			// Accept persists the replacement plan the operator saw, then activates the workspace.
			decisions.push("Accept plan");
			await propose("The revised plan is ready.", revised);
			const accepted = loadTask(paths, slug);
			assert.equal(accepted.document.stage, "implementation");
			assert.deepEqual(accepted.document.plan, revised);
			assert.equal(branchExists(), true);
			assert.equal(existsSync(join(accepted.document.repository.worktree, "tracked.txt")), true);

			assert.equal(shown.length, 5);
			for (const dialog of shown) {
				assert.equal(dialog.title, PLAN_DECISION_TITLE);
				assert.deepEqual(dialog.options, ["Accept plan", "Revise plan", "Cancel"]);
			}
			assert.equal(decisions.length, 0);
			assert.equal(feedbacks.length, 0);
			assert.equal(picks.length, 0);
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
