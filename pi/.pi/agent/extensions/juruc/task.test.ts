import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendTaskSession,
	blockTaskPhase,
	completeTaskPhase,
	createTaskDocument,
	findTaskSession,
	findTaskSessionByPath,
	finishTaskResearch,
	loadTaskDocument,
	parseTaskDocument,
	resumeTaskPhase,
	returnTaskToPlanning,
	returnTaskToResearch,
	saveTaskDocument,
	serializeTaskDocument,
	setTaskPlan,
	TASK_VERSION,
	type NewTaskInput,
	type TaskDocument,
	type TaskPhase,
	type TaskSessionRun,
} from "./task.ts";

const oid = (digit: string): string => digit.repeat(40);

const first: TaskPhase = {
	title: "Build the core",
	objective: "Implement the smallest useful core.",
	successCriteria: ["The focused tests pass."],
	verification: ["node --test core.test.ts"],
	hints: [],
};

const second: TaskPhase = {
	title: "Connect the workflow",
	objective: "Use the core from the extension.",
	successCriteria: ["The extension loads."],
	verification: ["node --test integration.test.ts"],
	hints: ["Delete the old path after cutover."],
};

function input(): NewTaskInput {
	return {
		slug: "small-task",
		title: "Small task",
		request: "Make the workflow smaller.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: oid("1"),
			branch: "small-task",
			worktree: "/runtime/worktrees/small-task",
		},
	};
}

function plannedTask(): TaskDocument {
	return setTaskPlan(finishTaskResearch(createTaskDocument(input())), {
		objective: "Simplify the workflow.",
		constraints: ["Keep Git worktree isolation."],
		assumptions: ["One operator owns the task."],
		nonGoals: ["No crash-perfect recovery."],
		successCriteria: ["Every phase is verified before completion."],
		remaining: [first, second],
	});
}

const sessionRuns: TaskSessionRun[] = [
	{ kind: "questions", path: "/sessions/questions.jsonl" },
	{ kind: "research", path: "/sessions/research.jsonl" },
	{ kind: "specification", path: "/sessions/specification.jsonl" },
	{ kind: "plan", path: "/sessions/plan.jsonl" },
	{ kind: "implementation", phase: 1, path: "/sessions/implementation-1.jsonl" },
	{ kind: "implementation", phase: 2, path: "/sessions/implementation-2.jsonl" },
	{ kind: "deviation-review", round: 1, path: "/sessions/deviation-1.jsonl" },
	{ kind: "correctness-review", round: 1, path: "/sessions/correctness-1.jsonl" },
	{ kind: "correction", round: 1, path: "/sessions/correction-1.jsonl" },
];

test("task.json round-trips through atomic persistence", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-task-"));
	try {
		const path = join(directory, "task.json");
		const task = createTaskDocument(input());
		assert.equal(task.version, TASK_VERSION);
		assert.deepEqual(task.sessions, []);
		saveTaskDocument(path, task);
		assert.deepEqual(loadTaskDocument(path), task);
		assert.equal(readFileSync(path, "utf8"), serializeTaskDocument(task));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session runs support every final kind with explicit scoped lookup", () => {
	let task = createTaskDocument(input());
	for (const run of sessionRuns) task = appendTaskSession(task, run);
	assert.deepEqual(task.sessions, sessionRuns);
	assert.deepEqual(findTaskSession(task, { kind: "research" }), sessionRuns[1]);
	assert.deepEqual(
		findTaskSession(task, { kind: "implementation", phase: 2 }),
		sessionRuns[5],
	);
	assert.deepEqual(
		findTaskSession(task, { kind: "correctness-review", round: 1 }),
		sessionRuns[7],
	);
	assert.deepEqual(findTaskSessionByPath(task, sessionRuns[8].path), sessionRuns[8]);
	assert.equal(findTaskSession(task, { kind: "implementation", phase: 3 }), undefined);
	assert.deepEqual(parseTaskDocument(serializeTaskDocument(task)), task);
});

test("session runs reject unknown fields, kinds, scopes, paths, and logical duplicates", () => {
	const task = createTaskDocument(input());
	const invalidRuns: unknown[] = [
		{ kind: "research", path: "/sessions/research.jsonl", extra: true },
		{ kind: "build", path: "/sessions/build.jsonl" },
		{ kind: "implementation", phase: 0, path: "/sessions/build.jsonl" },
		{ kind: "implementation", phase: 1.5, path: "/sessions/build.jsonl" },
		{ kind: "correction", round: 0, path: "/sessions/correction.jsonl" },
		{ kind: "research", path: "sessions/research.jsonl" },
	];
	for (const run of invalidRuns)
		assert.throws(
			() => parseTaskDocument(JSON.stringify({ ...task, sessions: [run] })),
			/invalid/,
		);
	assert.throws(
		() =>
			parseTaskDocument(JSON.stringify({
				...task,
				sessions: [
					{ kind: "research", path: "/sessions/shared.jsonl" },
					{ kind: "plan", path: "/sessions/shared.jsonl" },
				],
			})),
		/invalid/,
	);
	assert.throws(
		() =>
			parseTaskDocument(JSON.stringify({
				...task,
				sessions: [
					{ kind: "implementation", phase: 1, path: "/sessions/one.jsonl" },
					{ kind: "implementation", phase: 1, path: "/sessions/two.jsonl" },
				],
			})),
		/invalid/,
	);
	assert.throws(
		() =>
			parseTaskDocument(JSON.stringify({
				...task,
				sessions: [
					{ kind: "research", path: "/sessions/research-one.jsonl" },
					{ kind: "research", path: "/sessions/research-two.jsonl" },
				],
			})),
		/invalid/,
	);
	assert.throws(
		() =>
			appendTaskSession(
				appendTaskSession(task, { kind: "research", path: "/sessions/one.jsonl" }),
				{ kind: "research", path: "/sessions/two.jsonl" },
			),
		/already recorded/,
	);
	assert.throws(
		() =>
			parseTaskDocument(JSON.stringify({
				...task,
				version: 1,
				sessions: { research: null, planning: null, build: null },
			})),
		/invalid/,
	);
});

test("task.json rejects malformed and inconsistent persisted state", () => {
	assert.throws(() => parseTaskDocument("{"), /not valid JSON/);
	const task = plannedTask();
	assert.throws(
		() => parseTaskDocument(JSON.stringify({ ...task, stage: "blocked" })),
		/invalid/,
	);
	assert.throws(
		() =>
			parseTaskDocument(
				JSON.stringify({ ...task, repository: { ...task.repository, sourceHead: "HEAD" } }),
			),
		/invalid/,
	);
	const phase = task.plan?.remaining[0];
	assert.ok(phase);
	assert.throws(
		() =>
			parseTaskDocument(
				JSON.stringify({
					...task,
					plan: {
						...task.plan,
						remaining: [{ ...phase, verification: [] }],
					},
				}),
			),
		/invalid/,
	);
});

test("replanning preserves completed phases and append-only implementation runs", () => {
	let task = appendTaskSession(plannedTask(), {
		kind: "implementation",
		phase: 1,
		path: "/sessions/build-1.jsonl",
	});
	task = completeTaskPhase(
		task,
		"Implemented and tested the core.",
		[{
			command: "node --test core.test.ts",
			exitCode: 0,
			summary: "Core tests passed.",
		}],
		oid("2"),
	);
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 2,
		path: "/sessions/build-2.jsonl",
	});
	task = blockTaskPhase(task, "The integration contract needs revision.");
	const completed = structuredClone(task.plan?.completed);
	const sessions = structuredClone(task.sessions);
	task = returnTaskToPlanning(task);
	assert.equal(task.blockReason, "The integration contract needs revision.");
	task = setTaskPlan(task, {
		objective: "Simplify the workflow without losing isolation.",
		constraints: ["Keep Git worktree isolation."],
		assumptions: ["One operator owns the task."],
		nonGoals: [],
		successCriteria: ["The end-to-end workflow passes."],
		remaining: [{ ...second, objective: "Connect the revised core." }],
	});
	assert.deepEqual(task.plan?.completed, completed);
	assert.deepEqual(task.sessions, sessions);
	assert.equal(
		findTaskSession(task, { kind: "implementation", phase: 2 })?.path,
		"/sessions/build-2.jsonl",
	);
	assert.equal(task.stage, "building");
});

test("blocking and resuming retain implementation session continuity", () => {
	let task = appendTaskSession(plannedTask(), {
		kind: "implementation",
		phase: 1,
		path: "/sessions/build.jsonl",
	});
	task = blockTaskPhase(task, "Need a user decision.");
	assert.equal(task.stage, "blocked");
	assert.equal(task.blockReason, "Need a user decision.");
	task = resumeTaskPhase(task);
	assert.equal(task.stage, "building");
	assert.equal(task.blockReason, null);
	assert.equal(
		findTaskSession(task, { kind: "implementation", phase: 1 })?.path,
		"/sessions/build.jsonl",
	);
});

test("transitions retain prior runs and completion leaves the next phase unopened", () => {
	let task = appendTaskSession(createTaskDocument(input()), {
		kind: "research",
		path: "/sessions/research.jsonl",
	});
	task = finishTaskResearch(task);
	task = appendTaskSession(task, {
		kind: "plan",
		path: "/sessions/planning.jsonl",
	});
	task = returnTaskToResearch(task);
	assert.equal(findTaskSession(task, { kind: "research" })?.path, "/sessions/research.jsonl");
	assert.equal(findTaskSession(task, { kind: "plan" })?.path, "/sessions/planning.jsonl");
	task = finishTaskResearch(task);
	task = setTaskPlan(task, {
		objective: "Finish two phases.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		successCriteria: ["The task is complete."],
		remaining: [first, second],
	});
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/build.jsonl",
	});
	const verificationEvidence = [{
		command: "node --test core.test.ts",
		exitCode: 0,
		summary: "Focused tests passed.",
	}];
	task = completeTaskPhase(
		task,
		"Completed and verified.",
		verificationEvidence,
		oid("2"),
	);
	assert.equal(task.stage, "building");
	assert.equal(task.plan?.completed[0].commit, oid("2"));
	assert.deepEqual(task.plan?.completed[0].verificationEvidence, verificationEvidence);
	assert.equal(findTaskSession(task, { kind: "implementation", phase: 1 })?.path, "/sessions/build.jsonl");
	assert.equal(findTaskSession(task, { kind: "implementation", phase: 2 }), undefined);
	const invalid = structuredClone(task) as unknown as {
		plan: { completed: Array<{ verificationEvidence: unknown[] }> };
	};
	invalid.plan.completed[0].verificationEvidence = [{
		command: "node --test core.test.ts",
		exitCode: 0,
		result: "Focused tests passed.",
	}];
	assert.throws(() => parseTaskDocument(JSON.stringify(invalid)), /invalid/);
});
