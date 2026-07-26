import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	activeBranchMessageCount,
	activeBuildState,
	activePrState,
	buildState,
	CANCELLED,
	createTask,
	decidePersistedRun,
	decideSessionPrompt,
	identityState,
	parseTaskState,
	prNeedsRestart,
	prState,
	repositoryProblem,
} from "./state.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const identity = identityState("/repo/.git", SHA_A);
const phaseLine1 = "- [ ] Phase 1: First change";
const phaseLine2 = "- [ ] Phase 2: Second change";

assert.equal(
	parseTaskState({ version: 1, phase: "questions" }),
	undefined,
	"old state must fail",
);
assert.equal(
	parseTaskState({ ...identity, version: 2 }),
	undefined,
	"the previous boolean-run schema must fail",
);
assert.equal(
	parseTaskState({ ...identity, baseSha: [SHA_A] }),
	undefined,
	"SHA must be a string",
);
assert.equal(
	parseTaskState({ ...identity, baseSha: "a".repeat(41) }),
	undefined,
	"SHA length must be exact",
);
assert.equal(
	parseTaskState({ ...identity, extra: true }),
	undefined,
	"unknown state fields must fail",
);
assert.deepEqual(parseTaskState(identity), identity);

const firstBuild = buildState(identity, phaseLine1);
assert.equal(firstBuild.build.status, "pending");
assert.equal(firstBuild.build.session, undefined);
assert.equal(decidePersistedRun(firstBuild.build.status, 0, "other"), "full");
assert.equal(
	decidePersistedRun(firstBuild.build.status, 4, "current"),
	"continuation",
);
const activeBuild = activeBuildState(
	firstBuild,
	phaseLine1,
	"/sessions/build.jsonl",
);
assert.equal(activeBuild.build.status, "active");
assert.equal(activeBuild.build.session, "/sessions/build.jsonl");
assert.deepEqual(parseTaskState(activeBuild), activeBuild);
assert.equal(
	parseTaskState({
		...firstBuild,
		build: { phaseLine: phaseLine1, status: "active" },
	}),
	undefined,
	"active builds require an absolute owner session",
);
const nextBuild = buildState(
	activeBuild,
	phaseLine2,
	activeBuild.build.session,
);
assert.equal(nextBuild.build.phaseLine, phaseLine2);
assert.equal(
	nextBuild.build.status,
	"pending",
	"a settled phase must leave the next phase pending",
);
assert.equal(
	nextBuild.build.session,
	activeBuild.build.session,
	"the next build should reuse its initialized build session without activating the run",
);
assert.deepEqual(parseTaskState(nextBuild), nextBuild);
assert.equal(decidePersistedRun("active", 4, "current"), "gate");
const zeroActiveBranch: { type: string }[] = [];
assert.equal(activeBranchMessageCount(zeroActiveBranch), 0);
assert.equal(
	decidePersistedRun(
		"active",
		activeBranchMessageCount(zeroActiveBranch),
		"current",
	),
	"full",
	"a zero-message active branch must resend the full prompt regardless of file-wide session metadata",
);
assert.equal(
	decidePersistedRun("active", 4, "other"),
	"resume",
	"initialized resumed sessions must only switch",
);
assert.equal(decideSessionPrompt(0, "none"), "full");
assert.equal(decideSessionPrompt(3, "none"), "resume");
assert.equal(decideSessionPrompt(3, "provided"), "continuation");

const stalePr = activePrState(identity, SHA_B, "/sessions/pr.jsonl");
assert.equal(prNeedsRestart(stalePr, SHA_B), false);
assert.equal(
	prNeedsRestart(stalePr, SHA_A),
	true,
	"a changed HEAD must restart PR auditing",
);
const restartedPr = prState(stalePr, SHA_A);
assert.equal(restartedPr.pr.status, "pending");
assert.equal(
	restartedPr.pr.session,
	undefined,
	"a stale PR range must discard its previous session owner",
);
assert.equal(
	parseTaskState({ ...stalePr, pr: { head: SHA_B, status: "active" } }),
	undefined,
	"active PR audits require an owner session",
);
assert.equal(
	repositoryProblem(identity, {
		gitCommonDir: "/other/.git",
		base: "present",
	}),
	"wrong-repository",
);
assert.equal(
	repositoryProblem(identity, {
		gitCommonDir: "/repo/.git",
		base: "missing",
	}),
	"missing-base",
);
assert.equal(
	repositoryProblem(
		identity,
		{
			gitCommonDir: "/repo/.git",
			base: "present",
			branch: "task",
			ancestry: "invalid",
		},
		"task",
	),
	"base-not-ancestor",
);
assert.equal(typeof CANCELLED, "symbol");
assert.notEqual(
	CANCELLED,
	undefined,
	"cancellation has an unambiguous sentinel",
);

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
for (const phase of [
	"questions",
	"research",
	"design",
	"outline",
	"build",
	"pr",
]) {
	const prompt = readFileSync(
		join(extensionDirectory, "prompts", `rpi-${phase}.md`),
		"utf-8",
	);
	const runContext = prompt.lastIndexOf("## Run context");
	assert.notEqual(
		runContext,
		-1,
		`${phase} prompt must end in dynamic Run context`,
	);
	for (const match of prompt.matchAll(/\$1|\$\{@:2\}|\{\{RPI_[A-Z_]+\}\}/g)) {
		assert.ok(
			(match.index ?? -1) > runContext,
			`${phase} placeholder must stay in the static tail`,
		);
	}
}

const root = mkdtempSync(join(tmpdir(), "rpi-state-test-"));
try {
	const tasks = join(root, "tasks");
	createTask(tasks, "new-task", "# New task\n", identity);
	assert.equal(
		readFileSync(join(tasks, "new-task", "ticket.md"), "utf-8"),
		"# New task\n",
	);
	assert.throws(
		() => createTask(tasks, "new-task", "overwrite", identity),
		/already exists/,
	);
	assert.equal(
		readFileSync(join(tasks, "new-task", "ticket.md"), "utf-8"),
		"# New task\n",
	);

	mkdirSync(join(tasks, "broken-task"));
	assert.throws(
		() => createTask(tasks, "broken-task", "overwrite", identity),
		/already exists/,
		"an existing task directory with missing artifacts must never be overwritten",
	);
	assert.equal(existsSync(join(tasks, "broken-task", "ticket.md")), false);
	assert.equal(
		existsSync(tasks) &&
			readFileSync(join(tasks, "new-task", "state.json"), "utf-8").includes(
				'"version": 3',
			),
		true,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("rpi state characterization: ok");
