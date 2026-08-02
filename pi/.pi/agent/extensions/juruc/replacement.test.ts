import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireTestLock } from "./test-lock.ts";

const agentDir = mkdtempSync(join(tmpdir(), "juruc-replacement-agent-"));
const scratch = mkdtempSync(join(tmpdir(), "juruc-replacement-repository-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const [name, value] of Object.entries({
	GIT_AUTHOR_NAME: "JURUC replacement test",
	GIT_AUTHOR_EMAIL: "juruc-replacement@example.invalid",
	GIT_COMMITTER_NAME: "JURUC replacement test",
	GIT_COMMITTER_EMAIL: "juruc-replacement@example.invalid",
})) process.env[name] = value;

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const releaseTestLock = await acquireTestLock("juruc-extension-node-modules.lock");
const localModules = join(extensionDirectory, "node_modules");
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
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
process.once("exit", cleanup);

try {
	const [
		{ createRuntimeHarness },
		{ SessionManager },
		{ canonicalTurnAuthorization, settlementLease },
	] = await Promise.all([
		import("./runtime-harness.ts"),
		import("@earendil-works/pi-coding-agent"),
		import("./lease.ts"),
	]);

	const prompts = join(agentDir, "canonical");
	mkdirSync(prompts, { recursive: true });
	const grill = join(prompts, "grill.md");
	const commitMessage = join(prompts, "commit-message.md");
	writeFileSync(grill, "Canonical grill ${ARGUMENTS:-the task}.\n");
	writeFileSync(commitMessage, "Return the canonical commit message.\n");

	const cwd = join(scratch, "workspace");
	mkdirSync(cwd, { recursive: true });

	let probedCommands: string[] = [];
	let staleContextThrew = false;
	let stalePiThrew = false;
	let staleManagerSessionFile: string | undefined;
	let oldSessionFile: string | undefined;
	let replacementSessionFile: string | undefined;

	const harness = await createRuntimeHarness({
		agentDir,
		cwd,
		sessionManager: SessionManager.create(cwd),
		promptTemplates: [grill, commitMessage],
		stubTools: ["delegate"],
		probe: (pi, record) => {
			pi.registerCommand("probe", {
				description: "probe replacement lifecycle",
				handler: async (_args, ctx) => {
					probedCommands = pi.getCommands()
						.filter((command) => command.source === "prompt")
						.map((command) => command.name);
					oldSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
					const rawManager = record.rawManager as { getSessionFile(): string | null };
					await ctx.newSession({
						parentSession: oldSessionFile,
						withSession: async (replacement) => {
							harness.noteWithSession(record.instance);
							replacementSessionFile =
								replacement.sessionManager.getSessionFile() ?? undefined;
							try {
								ctx.sessionManager.getSessionFile();
							} catch {
								staleContextThrew = true;
							}
							try {
								pi.getActiveTools();
							} catch {
								stalePiThrew = true;
							}
							staleManagerSessionFile = rawManager.getSessionFile() ?? undefined;
						},
					});
				},
			});
		},
	});
	harness.setResponses([]);

	assert.deepEqual(harness.events, ["start:1"], "one fresh instance starts the build");
	await harness.runtime.session.prompt("/probe");

	assert.deepEqual(
		harness.events,
		["start:1", "shutdown:1:new", "start:2", "with:1"],
		"Pi starts the fresh instance before invoking the old closure",
	);
	assert.equal(harness.instances.length, 2, "each replacement constructs a fresh JURUC instance");
	assert.notEqual(harness.instances[0].pi, harness.instances[1].pi);
	assert.deepEqual(probedCommands.sort(), ["commit-message", "grill"], "canonical prompts resolve");
	assert.ok(replacementSessionFile);
	assert.notEqual(replacementSessionFile, oldSessionFile);
	assert.equal(staleContextThrew, true, "the old extension context throws after shutdown");
	assert.equal(stalePiThrew, true, "the old ExtensionAPI throws after shutdown");
	assert.equal(
		staleManagerSessionFile,
		oldSessionFile,
		"an extracted raw SessionManager stays bound to the old session",
	);

	await harness.dispose();

	const [
		{ fauxAssistantMessage, fauxToolCall },
		{ ensureManagedWorktree, git, managedWorktreeSnapshot, repositoryEvidence },
		{ runtimePaths },
		{ candidateFromInput },
		{ promoteCandidate, setCandidate, savePlanEnvelope, firstPendingPhase },
		{ createTask, enterPlanning, loadTask, recordBuildSession, recordPlanningSession, taskIdentity },
		{ buildingAuditState, buildingState, promotingState, saveExecutionState, startingState, transitionExecutionState },
		{ stageExactSnapshot },
	] = await Promise.all([
		import("./runtime-harness.ts"),
		import("./repository.ts"),
		import("./runtime.ts"),
		import("./planning.ts"),
		import("./plan.ts"),
		import("./tasks.ts"),
		import("./state.ts"),
		import("./execution.ts"),
	]);

	const source = join(scratch, "source");
	mkdirSync(source);
	writeFileSync(join(source, "baseline.txt"), "baseline\n");
	for (const args of [["init", "-b", "main"], ["add", "baseline.txt"], ["commit", "-m", "Baseline"]]) {
		const result = await git(source, args);
		assert.equal(result.code, 0, result.stderr);
	}
	const repository = await repositoryEvidence(source);
	assert.ok(repository);
	const paths = runtimePaths(agentDir);
	const slug = "real-replacement";
	const identity = taskIdentity(paths, slug, repository.root, repository.branch, repository.head);
	let task = createTask(paths, "Real replacement", slug, "Prove real replacement.", identity);
	await ensureManagedWorktree(task.state);
	task = enterPlanning(task);

	function appendSession(cwd: string, label: string, parentSession?: string) {
		const manager = SessionManager.create(cwd, undefined, parentSession ? { parentSession } : undefined);
		manager.appendSessionInfo(label);
		const path = manager.getSessionFile();
		const header = manager.getHeader();
		assert.ok(path && header);
		writeFileSync(
			path,
			`${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		return { path: realpathSync(path), id: manager.getSessionId() };
	}

	const planningIdentity = appendSession(task.state.worktree, `${slug} · plan`);
	task = recordPlanningSession(task, planningIdentity);

	const clean = await managedWorktreeSnapshot(task.state);
	assert.equal(clean.kind, "present");
	if (clean.kind !== "present") throw new Error("expected a present worktree");
	const cleanSnapshot = { head: clean.head, paths: clean.paths, tree: clean.tree };
	const candidate = candidateFromInput({
		objective: "Prove real Pi replacement.",
		desiredEndState: "Replacement arms the committing destination from a fresh instance.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		decisions: [],
		risks: [],
		successCriteria: ["The canonical turn runs in the fresh runtime."],
		futurePhases: [
			{ title: "Changed phase", objective: "Change one file.", successCriteria: ["The change is committed."] },
			{ title: "No-code phase", objective: "Verify without changing files.", successCriteria: ["The phase completes without a commit."] },
			{ title: "Final phase", objective: "Prove the final handoff.", successCriteria: ["The final change is committed."] },
			{ title: "Final no-code", objective: "Verify the terminal no-code handoff.", successCriteria: ["The terminal phase completes without a commit."] },
		],
	}, task.plan, cleanSnapshot, null);
	const proposed = setCandidate(task.plan, candidate);
	savePlanEnvelope(join(task.directory, "plan.json"), proposed);
	const promoting = transitionExecutionState(task.state, promotingState(task.state, candidate));
	saveExecutionState(join(task.directory, "state.json"), promoting);
	const approved = promoteCandidate(proposed, cleanSnapshot);
	savePlanEnvelope(join(task.directory, "plan.json"), approved);
	const phase = firstPendingPhase(approved);
	assert.ok(phase);
	saveExecutionState(
		join(task.directory, "state.json"),
		transitionExecutionState(promoting, startingState(promoting, phase)),
	);
	task = loadTask(paths, slug);
	const buildIdentity = appendSession(task.state.worktree, `${slug} · ${phase.id}`, planningIdentity.path);
	task = recordBuildSession(task, buildIdentity);
	let state = transitionExecutionState(
		task.state,
		buildingState(task.state, phase, buildIdentity),
	);
	writeFileSync(join(task.state.worktree, "implementation.txt"), "implemented\n");
	const changed = await managedWorktreeSnapshot(task.state);
	assert.equal(changed.kind, "present");
	if (changed.kind !== "present") throw new Error("expected a present worktree");
	const changedSnapshot = { head: changed.head, paths: changed.paths, tree: changed.tree };
	assert.deepEqual(changedSnapshot.paths, ["implementation.txt"]);
	await stageExactSnapshot(task.state, changedSnapshot);
	state = buildingAuditState(state, { kind: "phase", snapshot: changedSnapshot, summary: "Validated the exact candidate." });
	saveExecutionState(join(task.directory, "state.json"), state);

	const startProfiles: Array<{ instance: number; tools: string[]; phase: string }> = [];
	const committingProfiles: string[][] = [];
	const startingStateValue = startingState(state, phase, buildIdentity);
	saveExecutionState(join(task.directory, "state.json"), startingStateValue);
	const startingHarness = await createRuntimeHarness({
		agentDir,
		cwd: task.state.worktree,
		sessionManager: SessionManager.open(buildIdentity.path),
		promptTemplates: [grill, commitMessage],
		stubTools: ["delegate"],
	});
	startingHarness.setResponses([fauxAssistantMessage("starting owner response")]);
	await startingHarness.runtime.session.prompt("starting owner activity");
	const startingBranch = startingHarness.runtime.session.sessionManager.getBranch();
	assert.ok(startingBranch.at(-2));
	const startingTree = await startingHarness.runtime.session.navigateTree(startingBranch.at(-2)!.id, {
		label: "starting-owner-tree-test",
	});
	assert.equal(startingTree.cancelled, true, "a starting owner cannot navigate its active branch");
	await startingHarness.dispose();
	saveExecutionState(join(task.directory, "state.json"), state);
	const auditResult = {
		agent: "audit",
		task: "Audit the phase",
		audit: { verdict: "pass" as const, summary: "Validated the exact phase candidate." },
		output: "",
		stopReason: "stop",
		provider: "faux",
		model: "faux-1",
		steps: [{ tool: "read", detail: "followup.txt", outcome: "ok" }],
		turns: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		durationMs: 1,
	};
	const taskHarness = await createRuntimeHarness({
		agentDir,
		cwd: source,
		sessionManager: SessionManager.create(source),
		promptTemplates: [grill, commitMessage],
		stubTools: ["delegate"],
		stubResult: () => auditResult,
		probe: (pi, record) => {
			pi.on("session_start", () => {
				const phase = loadTask(paths, slug).state.phase;
				startProfiles.push({
					instance: record.instance,
					tools: [...pi.getActiveTools()].sort(),
					phase,
				});
				if (phase === "starting" && loadTask(paths, slug).state.phaseSnapshot.id === "P3") {
					writeFileSync(join(loadTask(paths, slug).state.worktree, "final.txt"), "final\n");
					taskHarness.appendResponses([
						fauxAssistantMessage([fauxToolCall("delegate", { agent: "audit" })], { stopReason: "toolUse" }),
						fauxAssistantMessage("The final audit passed"),
						fauxAssistantMessage([], { stopReason: "error", errorMessage: "temporary canonical failure" }),
					]);
				} else if (phase === "starting" && loadTask(paths, slug).state.phaseSnapshot.id === "P4") {
					taskHarness.appendResponses([
						fauxAssistantMessage([fauxToolCall("delegate", { agent: "audit" })], { stopReason: "toolUse" }),
						fauxAssistantMessage("The terminal no-code audit passed"),
					]);
				}
			});
			pi.on("message_start", (event) => {
				if (event.message.role === "custom" && event.message.customType === "juruc-commit-message")
					committingProfiles.push([...pi.getActiveTools()].sort());
			});
		},
	});
	taskHarness.setResponses([]);

	const openTask = `Open Real replacement — ${slug} · building`;
	taskHarness.selections.push(openTask);
	taskHarness.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "git diff --cached" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Implement the exact replacement change"),
		fauxAssistantMessage("Acknowledged the next phase"),
	]);
	await taskHarness.runtime.session.prompt("/juruc");

	const errors = taskHarness.notices.filter((notice) => /stale|destroyed|not available|is unavailable/i.test(notice));
	assert.deepEqual(errors, [], `no replacement callback touched stale runtime state: ${taskHarness.notices.join(" | ")}`);
	assert.ok(taskHarness.instances.length >= 2, "recovery constructed at least one fresh JURUC instance");
	const committingStart = startProfiles.find((entry) => entry.phase === "committing");
	assert.ok(committingStart, `a fresh instance observed the persisted committing destination: ${JSON.stringify(startProfiles)}`);
	assert.deepEqual(
		committingStart.tools,
		["bash", "juruc_block_phase"],
		"the fresh instance installs the committing-only profile before withSession sends anything",
	);

	const settled = loadTask(paths, slug);
	assert.equal(settled.plan.approved?.completed.length, 1, `the canonical turn settled the phase: ${taskHarness.notices.join(" | ")}`);
	const commit = settled.plan.approved?.completed[0].commit;
	assert.ok(commit);
	assert.equal(
		(await git(settled.state.worktree, ["log", "-1", "--format=%s"])).stdout.trim(),
		"Implement the exact replacement change",
		"the fresh runtime's canonical wording became the exact commit message",
	);
	assert.equal(settled.state.phase, "building", "the next phase handed off to its own fresh session");
	if (settled.state.phase !== "building") throw new Error("expected the next building phase");
	assert.equal(settled.state.phaseSnapshot.id, "P2");
	assert.notDeepEqual(settled.state.phaseSession, buildIdentity);
	assert.equal(
		taskHarness.runtime.session.sessionFile,
		settled.state.phaseSession.path,
		"the runtime ends in the next phase's own session",
	);
	assert.equal(canonicalTurnAuthorization(), undefined, "the one-use authorization was consumed");

	const inspections = SessionManager.open(buildIdentity.path).getBranch().filter(
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolName === "bash" && !entry.message.isError,
	);
	assert.equal(inspections.length, 1, "one permitted inspection ran after the recovered canonical prompt");

	// Non-final no-code completion, followed by a final changed phase.
	const noCodeStart = startProfiles.length;
	taskHarness.cancelNextSwitch();
	taskHarness.setResponses([
		fauxAssistantMessage([fauxToolCall("delegate", { agent: "audit" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The no-code audit passed"),
	]);
	await taskHarness.runtime.session.prompt("Implement P2 and then P3.");
	const interrupted = loadTask(paths, slug);
	assert.equal(interrupted.state.phase, "starting", "cancelled no-code handoff remains recoverable");
	assert.equal(canonicalTurnAuthorization(), undefined, "cancelled handoff leaves no canonical authorization");
	assert.equal(settlementLease(), undefined, "cancelled handoff releases its settlement lease");
	taskHarness.selections.push(`Open Real replacement — ${slug} · starting`);
	await taskHarness.runtime.session.prompt("/juruc");
	const absentRecovery = loadTask(paths, slug);
	assert.equal(absentRecovery.state.phase, "committing", "absent canonical response remains recoverable");
	assert.equal(canonicalTurnAuthorization(), undefined);
	assert.equal(settlementLease(), undefined);
	taskHarness.setResponses([fauxAssistantMessage("   ")]);
	taskHarness.selections.push(`Open Real replacement — ${slug} · committing`);
	await taskHarness.runtime.session.prompt("/juruc");
	assert.equal(loadTask(paths, slug).state.phase, "committing", "invalid canonical response remains recoverable");
	taskHarness.setResponses([fauxAssistantMessage("Add the final file")]);
	taskHarness.selections.push(`Open Real replacement — ${slug} · committing`);
	await taskHarness.runtime.session.prompt("/juruc");

	const done = loadTask(paths, slug);
	assert.equal(done.state.phase, "done", `the final phase completed: ${taskHarness.notices.join(" | ")}`);
	assert.equal(done.plan.approved?.completed.length, 4);
	assert.equal(done.plan.approved?.completed[1].commit, null, "non-final no-code phase has no commit");
	assert.equal(done.plan.approved?.completed[3].commit, null, "final no-code phase has no commit");
	assert.equal(
		(await git(done.state.worktree, ["log", "-1", "--format=%s"])).stdout.trim(),
		"Add the final file",
		"final canonical wording became the exact commit message",
	);
	assert.deepEqual(
		committingProfiles,
		[
			["bash", "juruc_block_phase"],
			["bash", "juruc_block_phase"],
			["bash", "juruc_block_phase"],
			["bash", "juruc_block_phase"],
		],
		"canonical turns retain the committing-only profile through recovery",
	);
	assert.deepEqual(
		startProfiles.slice(noCodeStart).map((entry) => entry.phase),
		["starting", "committing", "committing", "starting", "done"],
		"recovery and no-code handoffs start fresh owners before returning to planning",
	);
	const doneStart = startProfiles.at(-1);
	assert.ok(doneStart && doneStart.tools.every((name) => !name.startsWith("juruc_")), "planning handoff restores ordinary tools");
	assert.equal(taskHarness.runtime.session.sessionFile, planningIdentity.path);
	assert.equal(canonicalTurnAuthorization(), undefined, "no authorization outlives its one use");

	await taskHarness.dispose();
	console.log("juruc real replacement lifecycle: ok");
} finally {
	cleanup();
}
