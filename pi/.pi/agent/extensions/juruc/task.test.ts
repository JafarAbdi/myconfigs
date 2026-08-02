import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	blockTaskPhase,
	completeTaskPhase,
	createTaskDocument,
	finishTaskResearch,
	loadTaskDocument,
	parseTaskDocument,
	recordTaskSession,
	resumeTaskPhase,
	returnTaskToPlanning,
	returnTaskToResearch,
	saveTaskDocument,
	serializeTaskDocument,
	setTaskPlan,
	type NewTaskInput,
	type TaskDocument,
	type TaskPhase,
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

test("task.json round-trips through atomic persistence", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-task-"));
	try {
		const path = join(directory, "task.json");
		const task = createTaskDocument(input());
		saveTaskDocument(path, task);
		assert.deepEqual(loadTaskDocument(path), task);
		assert.equal(readFileSync(path, "utf8"), serializeTaskDocument(task));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
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

test("replanning preserves completed phases and the blocked build session", () => {
	let task = recordTaskSession(plannedTask(), "build", "/sessions/build-1.jsonl");
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
	task = recordTaskSession(task, "build", "/sessions/build-2.jsonl");
	task = blockTaskPhase(task, "The integration contract needs revision.");
	const completed = structuredClone(task.plan?.completed);
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
	assert.equal(task.sessions.build, "/sessions/build-2.jsonl");
	assert.equal(task.stage, "building");
});

test("blocking and resuming retain dirty-work session continuity", () => {
	let task = recordTaskSession(plannedTask(), "build", "/sessions/build.jsonl");
	task = blockTaskPhase(task, "Need a user decision.");
	assert.equal(task.stage, "blocked");
	assert.equal(task.blockReason, "Need a user decision.");
	task = resumeTaskPhase(task);
	assert.equal(task.stage, "building");
	assert.equal(task.blockReason, null);
	assert.equal(task.sessions.build, "/sessions/build.jsonl");
});

test("research stays separate and phase completion advances to done", () => {
	let task = recordTaskSession(
		createTaskDocument(input()),
		"research",
		"/sessions/research.jsonl",
	);
	task = finishTaskResearch(task);
	task = recordTaskSession(task, "planning", "/sessions/planning.jsonl");
	task = returnTaskToResearch(task);
	assert.equal(task.sessions.research, null);
	assert.equal(task.sessions.planning, "/sessions/planning.jsonl");
	task = finishTaskResearch(task);
	task = setTaskPlan(task, {
		objective: "Finish one phase.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		successCriteria: ["The task is complete."],
		remaining: [first],
	});
	task = recordTaskSession(task, "build", "/sessions/build.jsonl");
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
	assert.equal(task.stage, "done");
	assert.equal(task.plan?.remaining.length, 0);
	assert.equal(task.plan?.completed[0].commit, oid("2"));
	assert.deepEqual(task.plan?.completed[0].verificationEvidence, verificationEvidence);
	assert.equal(task.sessions.build, null);
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
