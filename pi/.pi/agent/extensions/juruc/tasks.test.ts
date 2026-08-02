import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableActions, dispatchActions } from "./actions.ts";
import { firstPendingPhase, promoteCandidate, savePlanEnvelope, setCandidate, type PlanCandidate } from "./plan.ts";
import { buildingState, promotingState, saveExecutionState, startingState, transitionExecutionState } from "./state.ts";
import {
	branchHead,
	ensureManagedWorktree,
	git,
	removeManagedWorktree,
	repositoryEvidence,
} from "./repository.ts";
import { runtimePaths } from "./runtime.ts";
import {
	beginTaskDeletion,
	createTask,
	deletionEvidence,
	enterPlanning,
	listTasks,
	loadTask,
	recordBuildSession,
	recordPlanningSession,
	recordResearchSession,
	recoverTaskDeletion,
	returnToPlanning,
	slugify,
	taskIdentity,
	uniqueSlug,
	validGeneratedTitle,
} from "./tasks.ts";

for (const [key, value] of Object.entries({
	GIT_AUTHOR_NAME: "JURUC tests",
	GIT_AUTHOR_EMAIL: "juruc@example.invalid",
	GIT_COMMITTER_NAME: "JURUC tests",
	GIT_COMMITTER_EMAIL: "juruc@example.invalid",
}))
	process.env[key] = value;

async function must(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
	assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function writeSession(
	path: string,
	cwd: string,
	id: string,
	body = "",
): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date().toISOString(),
			cwd,
		})}\n${body}`,
	);
}

function worktreeRemoveArgs(trace: string): string[] | undefined {
	return readFileSync(trace, "utf8")
		.trimEnd()
		.split("\n")
		.map(
			(line) => JSON.parse(line) as { event?: string; argv?: string[] },
		)
		.find(
			({ event, argv }) =>
				event === "start" &&
				argv?.includes("worktree") &&
				argv.includes("remove"),
		)?.argv;
}

const root = mkdtempSync(join(tmpdir(), "juruc-tasks-test-"));
try {
	const source = join(root, "source");
	mkdirSync(source);
	await must(source, ["init", "-b", "main"]);
	writeFileSync(join(source, "baseline.txt"), "baseline\n");
	await must(source, ["add", "baseline.txt"]);
	await must(source, ["commit", "-m", "Baseline"]);
	const repository = (await repositoryEvidence(source))!;

	const agent = join(root, "agent");
	const rpiTask = join(agent, "tasks", "rpi-sentinel");
	const rpiWorktree = join(agent, "worktrees", "rpi-sentinel");
	mkdirSync(rpiTask, { recursive: true });
	mkdirSync(rpiWorktree, { recursive: true });
	writeFileSync(join(rpiTask, "state.json"), "RPI state must remain untouched\n");
	writeFileSync(join(rpiWorktree, "sentinel"), "RPI worktree must remain untouched\n");
	const paths = runtimePaths(agent);
	assert.equal(paths.tasks, join(agent, "juruc", "tasks"));
	assert.equal(paths.worktrees, join(agent, "juruc", "worktrees"));
	const agentLink = join(root, "agent-link");
	symlinkSync(agent, agentLink);
	assert.deepEqual(runtimePaths(agentLink), paths, "the agent path is canonicalized");

	for (const component of ["juruc", "tasks", "worktrees"] as const) {
		const badAgent = join(root, `bad-${component}-agent`);
		const target = join(root, `bad-${component}-target`);
		mkdirSync(badAgent);
		mkdirSync(target);
		if (component === "juruc") symlinkSync(target, join(badAgent, "juruc"));
		else {
			mkdirSync(join(badAgent, "juruc"));
			if (component === "worktrees") mkdirSync(join(badAgent, "juruc", "tasks"));
			symlinkSync(target, join(badAgent, "juruc", component));
		}
		assert.throws(
			() => runtimePaths(badAgent),
			/exact non-symlink directory/,
			`${component} symlinks are rejected`,
		);
	}

	assert.equal(validGeneratedTitle("Replace Piper transport"), true);
	assert.equal(validGeneratedTitle("Replace\nPiper transport"), false);
	assert.equal(validGeneratedTitle("Replace Café transport"), false);
	assert.equal(slugify("Replace Piper ROS with ZMQ everywhere"), "replace-piper-ros-with-zmq");
	mkdirSync(join(paths.tasks, "collision"), { recursive: true });
	mkdirSync(join(paths.tasks, "collision-2"));
	assert.equal(uniqueSlug(paths.tasks, "collision"), "collision-3");
	const unpublished = join(paths.tasks, ".interrupted-task.tmp");
	mkdirSync(unpublished);
	writeFileSync(join(unpublished, "plan.json"), "partial\n");
	assert.equal(
		listTasks(paths).some(({ slug }) => slug === "interrupted-task"),
		false,
		"an interrupted temporary directory is not published as a task",
	);

	const slug = "replace-piper-ros-with-zmq";
	const identity = taskIdentity(
		paths,
		slug,
		repository.root,
		repository.branch,
		repository.head,
	);
	let task = createTask(
		paths,
		"Replace Piper ROS with ZMQ",
		slug,
		"Replace the Piper ROS transport.\nKeep compatibility during rollout.",
		identity,
	);
	assert.equal(task.state.phase, "creating");
	assert.deepEqual(readdirSync(task.directory).sort(), ["plan.json", "state.json"]);
	assert.equal(task.plan.title, "Replace Piper ROS with ZMQ");
	assert.equal(task.state.slug, slug);
	assert.equal(
		task.plan.request,
		"Replace the Piper ROS transport.\nKeep compatibility during rollout.",
	);
	assert.equal(task.state.version, 7);
	assert.equal(task.state.sourceRoot, source);
	assert.equal(task.state.baseBranch, "main");
	assert.equal(task.state.sourceHead, repository.head);
	assert.equal(task.state.branch, slug);
	assert.equal(task.state.worktree, join(paths.worktrees, slug));

	await ensureManagedWorktree(task.state);
	task = enterPlanning(task);
	assert.equal(task.state.phase, "planning");
	if (task.state.phase !== "planning") throw new Error("expected planning state");
	assert.equal(task.state.reason, "initial");
	assert.equal(task.state.subject, task.plan.request);
	assert.equal(task.state.step, "research");
	assert.equal(task.state.researchProgress, "orientation");
	assert.equal(task.state.researchSession, null);

	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	const planningSession = join(sessions, "plan.jsonl");
	const researchSession = join(sessions, "research.jsonl");
	const buildSession = join(sessions, "build.jsonl");
	const unrelatedSession = join(sessions, "unrelated.jsonl");
	writeSession(planningSession, identity.worktree, "planning-session");
	writeSession(researchSession, identity.worktree, "research-session");
	writeSession(buildSession, identity.worktree, "build-session");
	writeSession(unrelatedSession, identity.worktree, "unrelated-session");
	const sessionLink = join(sessions, "build-link.jsonl");
	symlinkSync(buildSession, sessionLink);
	assert.throws(
		() =>
			recordBuildSession(task, {
				path: sessionLink,
				id: "build-session",
			}),
		/not starting/,
	);
	assert.throws(
		() =>
			recordBuildSession(task, {
				path: buildSession,
				id: "replacement-session",
			}),
		/not starting/,
	);
	task = recordPlanningSession(task, {
		path: planningSession,
		id: "planning-session",
	});
	assert.throws(() => recordBuildSession(task, {
		path: buildSession,
		id: "build-session",
	}), /not starting/);
	assert.equal(loadTask(paths, slug).state.phase, "planning");
	assert.deepEqual(task.state.planningSession, {
		path: planningSession,
		id: "planning-session",
	});
	task = recordResearchSession(task, {
		path: researchSession,
		id: "research-session",
	});
	if (task.state.phase !== "planning" || task.state.step !== "research") throw new Error("expected research planning state");
	assert.deepEqual(task.state.researchSession, {
		path: researchSession,
		id: "research-session",
	});
	assert.equal(task.state.researchProgress, "orientation");
	assert.deepEqual(recordResearchSession(task, task.state.researchSession), task);
	assert.throws(
		() => recordResearchSession(task, task.state.planningSession!),
		/research session is already owned|planning session cannot be reused/u,
	);
	assert.deepEqual(task.state.buildSessions, []);
	assert.deepEqual(availableActions(task).map(({ id }) => id), ["continue-planning"]);

	const candidate: PlanCandidate = {
		expectedRevision: 0,
		objective: "Replace the transport.",
		desiredEndState: "ZMQ carries all supported traffic.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		decisions: [],
		risks: [],
		successCriteria: ["Transport tests pass."],
		future: [
			{
				title: "Replace transport",
				objective: "Implement the ZMQ transport.",
				successCriteria: ["The transport is verified."],
				hints: [],
				amendments: [],
			},
		],
		worktreeSnapshot: {
			head: repository.head,
			paths: [],
			tree: "1".repeat(64),
		},
		activeWorkDisposition: null,
	};
	const awaiting = { ...task, plan: setCandidate(task.plan, candidate) };
	assert.deepEqual(availableActions(awaiting).map(({ id }) => id), [
		"build-candidate",
		"revise-candidate",
	]);
	const promoting = {
		...awaiting,
		plan: promoteCandidate(awaiting.plan, candidate.worktreeSnapshot),
		state: promotingState(awaiting.state, candidate),
	};
	savePlanEnvelope(join(task.directory, "plan.json"), promoting.plan);
	saveExecutionState(join(task.directory, "state.json"), promoting.state);
	const pending = firstPendingPhase(promoting.plan)!;
	task = {
		...promoting,
		state: transitionExecutionState(promoting.state, startingState(promoting.state, pending)),
	};
	saveExecutionState(join(task.directory, "state.json"), task.state);
	assert.throws(() => recordBuildSession(task, { path: sessionLink, id: "build-session" }), /not an exact regular file/);
	assert.throws(() => recordBuildSession(task, { path: buildSession, id: "replacement-session" }), /identity changed/);
	assert.throws(() => recordBuildSession(task, { path: planningSession, id: "planning-session" }), /planning session cannot be reused/);
	const wrongCwdSession = join(sessions, "wrong-cwd.jsonl");
	writeSession(wrongCwdSession, source, "wrong-cwd");
	assert.throws(() => recordBuildSession(task, { path: wrongCwdSession, id: "wrong-cwd" }), /cwd differs/);
	task = recordBuildSession(task, { path: buildSession, id: "build-session" });
	assert.equal(task.state.phase, "starting");
	if (task.state.phase !== "starting") throw new Error("expected starting state");
	assert.deepEqual(task.state.phaseSession, { path: buildSession, id: "build-session" });
	assert.deepEqual(recordBuildSession(task, task.state.phaseSession), task);
	const ownedStarting = task;
	if (task.state.phaseSession === null) throw new Error("expected owned phase session");
	const activeBuilding = buildingState(task.state, pending, task.state.phaseSession);
	saveExecutionState(join(task.directory, "state.json"), activeBuilding);
	const returned = returnToPlanning(
		{ ...task, state: activeBuilding },
		"blocked",
		"Investigate the blocked transport build.",
	);
	assert.equal(returned.state.phase, "planning");
	if (returned.state.phase !== "planning") throw new Error("expected returned planning state");
	assert.equal(returned.state.subject, "Investigate the blocked transport build.");
	assert.equal(returned.state.reason, "blocked");
	assert.equal(returned.state.step, "research");
	assert.equal(returned.state.researchProgress, "orientation");
	assert.equal(returned.state.researchSession, null);
	assert.deepEqual(availableActions(returned).map(({ id }) => id), ["continue-planning"]);
	saveExecutionState(join(task.directory, "state.json"), ownedStarting.state);
	task = ownedStarting;
	assert.deepEqual(availableActions(promoting).map(({ id }) => id), [
		"recover-transaction",
	]);
	assert.deepEqual(availableActions(undefined), []);

	let performed = "";
	assert.equal(
		await dispatchActions(
			availableActions(task),
			async () => {
				throw new Error("one action must dispatch directly");
			},
			async (action) => {
				performed = action.id;
			},
		),
		"performed",
	);
	assert.equal(performed, "recover-transaction");
	assert.equal(
		await dispatchActions(
			availableActions(awaiting),
			async () => "revise-candidate",
			async (action) => {
				performed = action.id;
			},
		),
		"performed",
	);
	assert.equal(performed, "revise-candidate");
	assert.equal(
		await dispatchActions([], async () => undefined, async () => {}),
		"none",
	);

	const malformed = join(paths.tasks, "malformed");
	mkdirSync(malformed);
	writeFileSync(join(malformed, "plan.json"), "{}\n");
	writeFileSync(join(malformed, "state.json"), "{}\n");
	assert.equal(listTasks(paths).find(({ slug }) => slug === "malformed")?.valid, false);
	assert.throws(() => loadTask(paths, "malformed"), /invalid plan envelope/);
	await assert.rejects(() => deletionEvidence(paths, "malformed"), /invalid plan envelope/);

	writeFileSync(join(identity.worktree, "dirty.txt"), "uncommitted work\n");
	const staleEvidence = await deletionEvidence(paths, slug);
	assert.match(staleEvidence.status ?? "", /dirty\.txt/);
	writeFileSync(join(identity.worktree, "changed-after-confirmation.txt"), "late work\n");
	await assert.rejects(
		() => beginTaskDeletion(staleEvidence),
		/worktree changed after deletion confirmation/,
	);
	const nestedDirectory = join(identity.worktree, "generated", "nested");
	mkdirSync(nestedDirectory, { recursive: true });
	const firstNestedPath = join(nestedDirectory, "first.txt");
	const secondNestedPath = join(nestedDirectory, "second.txt");
	writeFileSync(firstNestedPath, "first\n");
	const beforeNestedAddition = await deletionEvidence(paths, slug);
	writeFileSync(secondNestedPath, "second\n");
	await assert.rejects(
		() => beginTaskDeletion(beforeNestedAddition),
		/worktree changed after deletion confirmation/,
		"adding a nested path invalidates confirmed deletion evidence",
	);
	rmSync(secondNestedPath);
	const beforeNestedRemoval = await deletionEvidence(paths, slug);
	rmSync(firstNestedPath);
	await assert.rejects(
		() => beginTaskDeletion(beforeNestedRemoval),
		/worktree changed after deletion confirmation/,
		"removing a nested path invalidates confirmed deletion evidence",
	);
	rmSync(join(identity.worktree, "generated"), { recursive: true });
	let evidence = await deletionEvidence(paths, slug);
	let deletingTask = await beginTaskDeletion(evidence);
	assert.deepEqual(deletingTask.state.phase, "deleting");
	if (deletingTask.state.phase !== "deleting")
		throw new Error("expected deleting state");
	assert.deepEqual(deletingTask.state.worktreeSnapshot, evidence.worktreeSnapshot);
	assert.deepEqual(deletingTask.state.buildSessions, [
		{ path: buildSession, id: "build-session" },
	]);
	assert.deepEqual(availableActions(deletingTask).map(({ id }) => id), [
		"recover-deletion",
	]);
	writeFileSync(join(identity.worktree, "dirty.txt"), "changed content, same path\n");
	assert.deepEqual(
		(await deletionEvidence(paths, slug)).worktreeSnapshot,
		deletingTask.state.worktreeSnapshot,
		"deletion consent is path-level and does not hash changed content",
	);
	const dirtyRemovalTrace = join(root, "dirty-removal-trace.jsonl");
	process.env.GIT_TRACE2_EVENT = dirtyRemovalTrace;
	try {
		await recoverTaskDeletion(deletingTask);
	} finally {
		delete process.env.GIT_TRACE2_EVENT;
	}
	assert.equal(
		worktreeRemoveArgs(dirtyRemovalTrace)?.includes("--force"),
		true,
		"confirmed dirty deletion still forces worktree removal",
	);
	assert.equal(existsSync(task.directory), false);
	assert.equal(existsSync(identity.worktree), false);
	assert.equal(existsSync(planningSession), true, "planning session is preserved");
	assert.equal(
		existsSync(buildSession),
		false,
		"only the persisted exact owned build session is deleted",
	);
	assert.equal(existsSync(unrelatedSession), true, "unowned session is preserved");
	assert.equal(await branchHead(slug, source), repository.head);

	const absentSlug = "absent-worktree";
	const absentIdentity = taskIdentity(
		paths,
		absentSlug,
		repository.root,
		repository.branch,
		repository.head,
	);
	let absentTask = createTask(
		paths,
		"Absent worktree",
		absentSlug,
		"Delete stale metadata explicitly.",
		absentIdentity,
	);
	await ensureManagedWorktree(absentTask.state);
	absentTask = enterPlanning(absentTask);
	const cleanRemovalTrace = join(root, "clean-removal-trace.jsonl");
	process.env.GIT_TRACE2_EVENT = cleanRemovalTrace;
	try {
		await removeManagedWorktree(absentTask.state);
	} finally {
		delete process.env.GIT_TRACE2_EVENT;
	}
	assert.equal(
		worktreeRemoveArgs(cleanRemovalTrace)?.includes("--force"),
		false,
		"clean worktree deletion does not force removal",
	);
	const explicitBuildSession = join(sessions, "absent-build.jsonl");
	const replacedBuildSession = join(sessions, "z-absent-build.jsonl");
	const unpersistedSibling = join(sessions, "absent-build-copy.jsonl");
	writeSession(explicitBuildSession, absentIdentity.worktree, "absent-build");
	writeSession(replacedBuildSession, absentIdentity.worktree, "replaced-build");
	writeSession(unpersistedSibling, absentIdentity.worktree, "absent-build-copy");
	// Build sessions are now owned one per explicit starting phase.
	const absentPlan = promoteCandidate(setCandidate(absentTask.plan, candidate), candidate.worktreeSnapshot);
	savePlanEnvelope(join(absentTask.directory, "plan.json"), absentPlan);
	const absentPromoting = promotingState(absentTask.state, candidate);
	saveExecutionState(join(absentTask.directory, "state.json"), absentPromoting);
	absentTask = { ...absentTask, plan: absentPlan, state: startingState(absentPromoting, firstPendingPhase(absentPlan)!) };
	saveExecutionState(join(absentTask.directory, "state.json"), absentTask.state);
	absentTask = recordBuildSession(absentTask, { path: explicitBuildSession, id: "absent-build" });
	const absentEvidence = await deletionEvidence(paths, absentSlug);
	assert.deepEqual(absentEvidence.worktreeSnapshot, { kind: "absent" });
	const absentDeleting = await beginTaskDeletion(absentEvidence);
	assert.equal(absentDeleting.state.phase, "deleting");
	if (absentDeleting.state.phase !== "deleting")
		throw new Error("expected deleting state");
	assert.deepEqual(absentDeleting.state.worktreeSnapshot, { kind: "absent" });
	assert.deepEqual(absentDeleting.state.buildSessions, [
		{ path: explicitBuildSession, id: "absent-build" },
	]);
	rmSync(explicitBuildSession);
	writeSession(
		replacedBuildSession,
		absentIdentity.worktree,
		"replacement-at-same-path",
	);
	await recoverTaskDeletion(absentDeleting);
	assert.equal(existsSync(absentTask.directory), false);
	assert.equal(
		existsSync(explicitBuildSession),
		false,
		"an already absent exact build session is recovered",
	);
	assert.equal(
		existsSync(replacedBuildSession),
		true,
		"a replacement session at an owned path is preserved",
	);
	assert.equal(
		existsSync(unpersistedSibling),
		true,
		"session deletion never infers related names",
	);

	const interruptedSlug = "interrupted-removal";
	const interruptedIdentity = taskIdentity(
		paths,
		interruptedSlug,
		repository.root,
		repository.branch,
		repository.head,
	);
	let interruptedTask = createTask(
		paths,
		"Interrupted removal",
		interruptedSlug,
		"Recover after Git removed the worktree.",
		interruptedIdentity,
	);
	await ensureManagedWorktree(interruptedTask.state);
	interruptedTask = enterPlanning(interruptedTask);
	const interruptedBuildSession = join(sessions, "interrupted-build.jsonl");
	const interruptedOtherSession = join(sessions, "interrupted-other.jsonl");
	writeSession(
		interruptedBuildSession,
		interruptedIdentity.worktree,
		"interrupted-build",
	);
	writeSession(
		interruptedOtherSession,
		interruptedIdentity.worktree,
		"interrupted-other",
	);
	const interruptedPlan = promoteCandidate(setCandidate(interruptedTask.plan, candidate), candidate.worktreeSnapshot);
	savePlanEnvelope(join(interruptedTask.directory, "plan.json"), interruptedPlan);
	const interruptedPromoting = promotingState(interruptedTask.state, candidate);
	saveExecutionState(join(interruptedTask.directory, "state.json"), interruptedPromoting);
	interruptedTask = { ...interruptedTask, plan: interruptedPlan, state: startingState(interruptedPromoting, firstPendingPhase(interruptedPlan)!) };
	saveExecutionState(join(interruptedTask.directory, "state.json"), interruptedTask.state);
	interruptedTask = recordBuildSession(interruptedTask, { path: interruptedBuildSession, id: "interrupted-build" });
	const interruptedEvidence = await deletionEvidence(paths, interruptedSlug);
	assert.equal(interruptedEvidence.worktreeSnapshot.kind, "present");
	const interruptedDeleting = await beginTaskDeletion(interruptedEvidence);
	rmSync(interruptedIdentity.worktree, { recursive: true });
	await assert.rejects(
		() => recoverTaskDeletion(interruptedDeleting),
		/remains registered/,
		"absent worktree cleanup verifies that Git registration is gone",
	);
	assert.equal(existsSync(interruptedTask.directory), true);
	assert.equal(existsSync(interruptedBuildSession), true);
	await must(source, ["worktree", "prune", "--expire", "now"]);
	await recoverTaskDeletion(interruptedDeleting);
	assert.equal(existsSync(interruptedTask.directory), false);
	assert.equal(existsSync(interruptedBuildSession), false);
	assert.equal(
		existsSync(interruptedOtherSession),
		true,
		"present-to-absent recovery removes only persisted exact build sessions",
	);

	assert.equal(
		readFileSync(join(rpiTask, "state.json"), "utf8"),
		"RPI state must remain untouched\n",
	);
	assert.equal(
		readFileSync(join(rpiWorktree, "sentinel"), "utf8"),
		"RPI worktree must remain untouched\n",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("juruc task lifecycle and action dispatch: ok");
