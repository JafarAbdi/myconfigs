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
	closingState,
	committingState,
	createTask,
	decidePersistedRun,
	decideSessionPrompt,
	deletingState,
	identityState,
	invariantError,
	PHASES,
	parseTaskState,
	plainState,
	prState,
	safeRelativePath,
	stagingState,
} from "./state.ts";

const SHA_A = "a".repeat(40);
const identity = identityState("main", "/repo");
const phaseLine1 = "- [ ] Phase 1: First change";
const phaseLine2 = "- [ ] Phase 2: Second change";

assert.deepEqual(PHASES, [
	"creating",
	"questions",
	"research",
	"design",
	"outline",
	"build",
	"closing",
	"staging",
	"committing",
	"pr",
	"done",
	"deleting",
]);
assert.equal(identity.phase, "creating");
assert.equal(
	parseTaskState({ ...identity, phase: "branch" }),
	undefined,
	"the legacy branch phase must fail",
);
assert.equal(
	parseTaskState({ version: 1, phase: "questions" }),
	undefined,
	"old state must fail",
);
assert.equal(
	parseTaskState({ ...identity, version: 3 }),
	undefined,
	"schema-v3 states must fail",
);
assert.equal(
	parseTaskState({ ...identity, sourceRoot: "relative" }),
	undefined,
	"creating requires an absolute sourceRoot",
);
assert.equal(
	parseTaskState({
		...identity,
		sourceRoot: "/repo",
		gitCommonDir: "/repo/.git",
	}),
	undefined,
	"creating keys must be exact",
);
assert.equal(
	parseTaskState({ ...identity, extra: true }),
	undefined,
	"unknown state fields must fail",
);
const { baseBranch: _baseBranch, ...identityWithoutBranch } = identity;
assert.equal(
	parseTaskState(identityWithoutBranch),
	undefined,
	"identity requires the canonical base branch",
);
assert.deepEqual(parseTaskState(identity), identity);
const { sourceRoot: _sourceRoot, ...creatingWithoutSource } = identity;
assert.equal(parseTaskState(creatingWithoutSource), undefined);
for (const phase of [
	"questions",
	"research",
	"design",
	"outline",
	"done",
] as const) {
	const plain = plainState(identity, phase);
	assert.deepEqual(parseTaskState(plain), plain);
	assert.equal(plain.baseBranch, "main");
	for (const forbidden of [
		{ gitCommonDir: "/repo/.git" },
		{ baseSha: SHA_A },
		{ build: { head: SHA_A } },
		{ pr: { head: SHA_A } },
	]) {
		assert.equal(
			parseTaskState({ ...plain, ...forbidden }),
			undefined,
			`${phase} must reject persisted repository/range evidence`,
		);
	}
}
const deleting = deletingState(identity, "/repo/.git");
assert.deepEqual(parseTaskState(deleting), deleting);
const { gitDirectory: _gitDirectory, ...deletingWithoutDirectory } = deleting;
assert.equal(parseTaskState(deletingWithoutDirectory), undefined);
assert.equal(
	parseTaskState({ ...deleting, gitDirectory: "relative" }),
	undefined,
);
assert.equal(parseTaskState({ ...deleting, sourceRoot: "/repo" }), undefined);

const firstBuild = buildState(identity, phaseLine1);
assert.equal(firstBuild.build.status, "pending");
assert.equal(firstBuild.build.session, undefined);
assert.equal(decidePersistedRun(0, "other"), "full");
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
const nextBuild = buildState(activeBuild, phaseLine2);
assert.equal(nextBuild.build.phaseLine, phaseLine2);
assert.equal(
	nextBuild.build.status,
	"pending",
	"a settled phase must leave the next phase pending",
);
assert.equal(
	nextBuild.build.session,
	undefined,
	"the next build must discard the previous implementation session",
);
assert.deepEqual(parseTaskState(nextBuild), nextBuild);
assert.equal(nextBuild.baseBranch, "main");
assert.equal(
	parseTaskState({
		...firstBuild,
		build: { ...firstBuild.build, session: "relative.jsonl" },
	}),
	undefined,
	"pending builds must not contain a session",
);
assert.equal(
	parseTaskState({
		...firstBuild,
		build: { ...firstBuild.build, head: SHA_A },
	}),
	undefined,
	"build state must reject persisted HEAD",
);
assert.equal(
	parseTaskState({
		...firstBuild,
		build: { ...firstBuild.build, extra: true },
	}),
	undefined,
	"build ownership keys must be exact",
);

const closing = closingState(
	activeBuild,
	phaseLine1,
	"/sessions/build.jsonl",
	"No implementation was needed.",
);
assert.deepEqual(parseTaskState(closing), closing);
for (const invalid of [
	{ ...closing, session: "sessions/build.jsonl" },
	{ ...closing, head: SHA_A },
	{ ...closing, resolution: "" },
	{ ...closing, resolution: "  padded" },
	{ ...closing, resolution: "two  spaces" },
	{ ...closing, resolution: "two\nlines" },
	{ ...closing, extra: true },
]) {
	assert.equal(parseTaskState(invalid), undefined);
}

const staging = stagingState(
	activeBuild,
	phaseLine1,
	"/sessions/build.jsonl",
	SHA_A,
	["src/a.ts", "src/b.ts"],
);
assert.deepEqual(parseTaskState(staging), staging);
assert.equal(staging.baseBranch, "main");
for (const paths of [
	[],
	["src/b.ts", "src/a.ts"],
	["src/a.ts", "src/a.ts"],
	["/src/a.ts"],
	["../src/a.ts"],
	["src/../a.ts"],
	["src//a.ts"],
]) {
	assert.equal(
		parseTaskState({ ...staging, paths }),
		undefined,
		"staging paths must be nonempty, sorted, unique, and safe",
	);
}
assert.equal(
	parseTaskState({ ...staging, session: "sessions/build.jsonl" }),
	undefined,
	"staging requires an absolute owner session",
);
assert.equal(
	parseTaskState({ ...staging, parent: "a".repeat(39) }),
	undefined,
	"staging requires an exact parent SHA",
);
assert.equal(
	parseTaskState({ ...staging, extra: true }),
	undefined,
	"staging keys must be exact",
);

const committing = committingState(
	staging,
	phaseLine1,
	"/sessions/build.jsonl",
	SHA_A,
);
assert.deepEqual(parseTaskState(committing), committing);
assert.equal(committing.baseBranch, "main");
assert.equal(
	parseTaskState({ ...committing, session: "sessions/build.jsonl" }),
	undefined,
	"committing requires an absolute owner session",
);
assert.equal(
	parseTaskState({ ...committing, parent: "not-a-sha" }),
	undefined,
	"committing requires a parent SHA",
);
assert.equal(
	parseTaskState({ ...committing, diff: "c".repeat(64) }),
	undefined,
	"committing has no diff digest or unknown fields",
);

assert.equal(decidePersistedRun(4, "current"), "gate");
const zeroActiveBranch: { type: string }[] = [];
assert.equal(activeBranchMessageCount(zeroActiveBranch), 0);
assert.equal(
	decidePersistedRun(activeBranchMessageCount(zeroActiveBranch), "current"),
	"full",
	"a zero-message active branch must resend the full prompt regardless of file-wide session metadata",
);
assert.equal(
	decidePersistedRun(4, "other"),
	"resume",
	"initialized resumed sessions must only switch",
);
assert.equal(decideSessionPrompt(0, "none"), "full");
assert.equal(decideSessionPrompt(3, "none"), "resume");
assert.equal(decideSessionPrompt(3, "provided"), "continuation");

const stalePr = activePrState(identity, "/sessions/pr.jsonl");
const restartedPr = prState(stalePr);
assert.equal(restartedPr.pr.status, "pending");
assert.equal(restartedPr.baseBranch, "main");
assert.equal(
	restartedPr.pr.session,
	undefined,
	"a stale PR range must discard its previous session owner",
);
assert.equal(
	parseTaskState({
		...restartedPr,
		pr: { ...restartedPr.pr, session: "/old" },
	}),
	undefined,
	"pending PR audits must not contain a session",
);
assert.equal(
	parseTaskState({ ...stalePr, pr: { status: "active" } }),
	undefined,
	"active PR audits require an owner session",
);
assert.equal(
	parseTaskState({ ...restartedPr, pr: { ...restartedPr.pr, head: SHA_A } }),
	undefined,
	"PR state must reject persisted HEAD",
);
for (const ordinary of [
	firstBuild,
	activeBuild,
	closing,
	staging,
	committing,
	restartedPr,
	stalePr,
]) {
	assert.equal(
		parseTaskState({ ...ordinary, gitCommonDir: "/repo/.git" }),
		undefined,
	);
	assert.equal(parseTaskState({ ...ordinary, baseSha: SHA_A }), undefined);
}
for (const path of [
	"src/a.ts",
	"a",
	"dir/file name",
	"src\\a.ts",
	"src\na.ts",
	"src\ra.ts",
	"a".repeat(4096),
]) {
	assert.equal(safeRelativePath(path), true, `${path} must be safe`);
}
for (const path of [
	"",
	".",
	"..",
	"/src/a.ts",
	"../src/a.ts",
	"src/../a.ts",
	"src/./a.ts",
	"src//a.ts",
	"src\0a.ts",
]) {
	assert.equal(safeRelativePath(path), false, `${path} must be unsafe`);
}
assert.equal(
	invariantError("clean HEAD abc", "dirty HEAD def").message,
	"RPI invariant failed\n\nExpected: clean HEAD abc\n\nFound: dirty HEAD def\n\nRPI stopped without attempting repair.",
);
assert.equal(typeof CANCELLED, "symbol");
assert.notEqual(
	CANCELLED,
	undefined,
	"cancellation has an unambiguous sentinel",
);

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const prompts = new Map<string, string>();
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
	prompts.set(phase, prompt);
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
for (const phase of ["design", "outline"]) {
	const prompt = prompts.get(phase);
	assert.ok(prompt?.includes("rpi_add_design_questions"));
	assert.match(prompt ?? "", /never hand-write a new `####`/i);
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
				'"version": 4',
			),
		true,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("rpi state characterization: ok");
