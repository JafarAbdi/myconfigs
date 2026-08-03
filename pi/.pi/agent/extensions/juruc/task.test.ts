import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acceptTaskPlan,
	appendTaskSession,
	completeTaskPhase,
	completeTaskResearch,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	currentTaskPhase,
	findTaskSession,
	loadTaskDocument,
	parseTaskDocument,
	saveTaskDocument,
	serializeTaskDocument,
	TASK_VERSION,
	type NewTaskInput,
	type TaskDocument,
	type TaskPhase,
	type TaskPlan,
	type TaskQuestions,
	type TaskSessionRun,
	type TaskSpecification,
} from "./task.ts";

const oid = (digit: string): string => digit.repeat(40);
const questions: TaskQuestions = {
	sharedUnderstanding: "Build the confirmed workflow.",
	decisions: ["Keep the API small."],
	acceptedAssumptions: ["One operator owns the task."],
	researchTargets: [],
};
const specification: TaskSpecification = {
	summary: "Implement the confirmed workflow.",
	requirements: ["The workflow advances automatically."],
	nonGoals: ["No remote publication."],
	constraints: ["Keep strict persisted state."],
	acceptanceCriteria: ["Focused tests pass."],
	decisions: ["Use local commits."],
};
const first: TaskPhase = {
	id: "build-core",
	title: "Build core",
	goal: "Implement the core.",
	fileScopes: ["src/**", "test/core.test.ts"],
	instructions: ["Implement the smallest core.", "Add focused tests."],
	verification: ["node --test test/core.test.ts"],
};
const second: TaskPhase = {
	id: "connect-workflow",
	title: "Connect workflow",
	goal: "Connect the core.",
	fileScopes: ["src/index.ts"],
	instructions: ["Wire the core into the workflow."],
	verification: ["npm test"],
};
const plan: TaskPlan = { phases: [first, second] };

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

function implementationTask(): TaskDocument {
	let task = createTaskDocument(input());
	task = confirmTaskQuestions(task, questions);
	task = completeTaskResearch(task);
	task = confirmTaskSpecification(task, specification);
	return acceptTaskPlan(task, plan);
}

const sessionRuns: TaskSessionRun[] = [
	{ kind: "questions", path: "/sessions/questions.jsonl" },
	{ kind: "research", path: "/sessions/research.jsonl" },
	{ kind: "specification", path: "/sessions/specification.jsonl" },
	{ kind: "plan", path: "/sessions/plan.jsonl" },
	{ kind: "implementation", phase: 1, path: "/sessions/implementation-1.jsonl" },
	{ kind: "deviation-review", round: 1, path: "/sessions/deviation-1.jsonl" },
	{ kind: "correctness-review", round: 1, path: "/sessions/correctness-1.jsonl" },
	{ kind: "correction", round: 1, path: "/sessions/correction-1.jsonl" },
];

test("version 3 task.json round-trips atomically from Questions", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-task-"));
	try {
		const path = join(directory, "task.json");
		const task = createTaskDocument(input());
		assert.equal(task.version, TASK_VERSION);
		assert.equal(task.stage, "questions");
		assert.deepEqual(task.sessions, []);
		assert.deepEqual(task.checkpoints, []);
		saveTaskDocument(path, task);
		assert.deepEqual(loadTaskDocument(path), task);
		assert.equal(readFileSync(path, "utf8"), serializeTaskDocument(task));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("strict forward transitions produce Q to R to S to P to I", () => {
	let task = createTaskDocument(input());
	assert.throws(() => completeTaskResearch(task), /not researching/);
	task = confirmTaskQuestions(task, questions);
	assert.equal(task.stage, "research");
	task = completeTaskResearch(task);
	assert.equal(task.stage, "specification");
	task = confirmTaskSpecification(task, specification);
	assert.equal(task.stage, "plan");
	task = acceptTaskPlan(task, plan);
	assert.equal(task.stage, "implementation");
	assert.deepEqual(currentTaskPhase(task), first);
	assert.throws(() => acceptTaskPlan(task, plan), /not planning/);
});

test("accepted plan is exact, nonempty, safe, and immutable in checkpoints", () => {
	const base = confirmTaskSpecification(
		completeTaskResearch(confirmTaskQuestions(createTaskDocument(input()), questions)),
		specification,
	);
	for (const phases of [
		[],
		[{ ...first, id: "Not-Kebab" }],
		[{ ...first, fileScopes: ["../escape.ts"] }],
		[{ ...first, fileScopes: ["/absolute.ts"] }],
		[{ ...first, fileScopes: [":(glob)**"] }],
		[{ ...first, fileScopes: ["!excluded.ts"] }],
		[{ ...first, fileScopes: ["^excluded.ts"] }],
		[first, { ...second, id: first.id }],
		[{ ...first, verification: ["npm test", "npm test"] }],
	]) assert.throws(() => acceptTaskPlan(base, { phases }), /invalid/);
	for (const scope of ["!excluded.ts", "^excluded.ts"]) {
		const persisted = structuredClone(acceptTaskPlan(base, plan));
		persisted.plan!.phases[0].fileScopes = [scope];
		assert.throws(() => parseTaskDocument(JSON.stringify(persisted)), /invalid/);
	}

	let task = appendTaskSession(acceptTaskPlan(base, plan), {
		kind: "implementation",
		phase: 1,
		path: "/sessions/implementation-1.jsonl",
	});
	const evidence = [{
		command: "node --test test/core.test.ts",
		exitCode: 0,
		summary: "Core tests passed.",
	}];
	task = completeTaskPhase(task, "Core complete.", evidence, oid("2"));
	assert.equal(task.stage, "implementation");
	assert.deepEqual(task.checkpoints[0], {
		...first,
		resolution: "Core complete.",
		verificationEvidence: evidence,
		commit: oid("2"),
	});
	assert.deepEqual(currentTaskPhase(task), second);
	const changed = structuredClone(task) as unknown as { checkpoints: Array<{ goal: string }> };
	changed.checkpoints[0].goal = "Different goal.";
	assert.throws(() => parseTaskDocument(JSON.stringify(changed)), /invalid/);
});

test("final checkpoint advances temporarily to done and sessions remain append-only", () => {
	let task = implementationTask();
	for (const run of sessionRuns) task = appendTaskSession(task, run);
	task = completeTaskPhase(
		task,
		"Core complete.",
		[{ command: first.verification[0], exitCode: 0, summary: "Passed." }],
		oid("2"),
	);
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 2,
		path: "/sessions/implementation-2.jsonl",
	});
	task = completeTaskPhase(
		task,
		"Workflow complete.",
		[{ command: second.verification[0], exitCode: 0, summary: "Passed." }],
		oid("3"),
	);
	assert.equal(task.stage, "done");
	assert.equal(task.checkpoints.length, 2);
	assert.equal(task.sessions.length, sessionRuns.length + 1);
	assert.equal(findTaskSession(task, { kind: "implementation", phase: 1 })?.path, sessionRuns[4].path);
	assert.equal(findTaskSession(task, { kind: "implementation", phase: 2 })?.path, "/sessions/implementation-2.jsonl");
});

test("artifacts, sessions, stages, and old task shapes are strictly rejected", () => {
	const fresh = createTaskDocument(input());
	const invalidQuestions = {
		...questions,
		decisions: ["duplicate", "duplicate"],
	};
	assert.throws(() => confirmTaskQuestions(fresh, invalidQuestions), /invalid/);
	for (const sessions of [
		[{ kind: "research", path: "relative.jsonl" }],
		[{ kind: "implementation", phase: 0, path: "/sessions/a" }],
		[
			{ kind: "research", path: "/sessions/shared" },
			{ kind: "plan", path: "/sessions/shared" },
		],
		[
			{ kind: "implementation", phase: 1, path: "/sessions/a" },
			{ kind: "implementation", phase: 1, path: "/sessions/b" },
		],
	]) assert.throws(
		() => parseTaskDocument(JSON.stringify({ ...fresh, sessions })),
		/invalid/,
	);
	for (const old of [
		{ ...fresh, version: 2 },
		{ ...fresh, stage: "building" },
		{ ...fresh, blockReason: null },
		{ ...fresh, completed: [] },
		{ ...fresh, research: {} },
		{ ...fresh, researchComplete: false },
	]) assert.throws(() => parseTaskDocument(JSON.stringify(old)), /invalid/);
	assert.throws(() => parseTaskDocument("{"), /not valid JSON/);
});
