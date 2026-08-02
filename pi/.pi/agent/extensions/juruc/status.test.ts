import assert from "node:assert/strict";
import test from "node:test";
import {
	appendTaskSession,
	blockTaskPhase,
	completeTaskPhase,
	createTaskDocument,
	finishTaskResearch,
	setTaskPlan,
} from "./task.ts";
import { lifecycleLine, lifecyclePlace } from "./status.ts";

function task() {
	return createTaskDocument({
		slug: "status-task",
		title: "Status task",
		request: "Show concise status.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "status-task",
			worktree: "/worktrees/status-task",
		},
	});
}

test("status is one lifecycle line derived from compact task state", () => {
	let current = task();
	assert.equal(lifecyclePlace(current).active, "research");
	assert.match(lifecycleLine(current), /^● research/);
	current = finishTaskResearch(current);
	assert.match(lifecycleLine(current), /✓ research  ● plan/);
	current = setTaskPlan(current, {
		objective: "Finish.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		successCriteria: ["Done."],
		remaining: [
			{
				title: "One",
				objective: "One.",
				successCriteria: ["One."],
				verification: ["test one"],
				hints: [],
			},
			{
				title: "Two",
				objective: "Two.",
				successCriteria: ["Two."],
				verification: ["test two"],
				hints: [],
			},
		],
	});
	current = appendTaskSession(current, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/build.jsonl",
	});
	assert.match(lifecycleLine(current), /● build · P1\/2 · building/);
	current = blockTaskPhase(current, "Need input.");
	assert.match(lifecycleLine(current), /P1\/2 · blocked: Need input\./);
});

test("done status derives its count from completed phases", () => {
	let current = finishTaskResearch(task());
	current = setTaskPlan(current, {
		objective: "Finish.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		successCriteria: ["Done."],
		remaining: [
			{
				title: "One",
				objective: "One.",
				successCriteria: ["One."],
				verification: ["test one"],
				hints: [],
			},
		],
	});
	current = appendTaskSession(current, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/build.jsonl",
	});
	current = completeTaskPhase(
		current,
		"Done.",
		[{ command: "test one", exitCode: 0, summary: "Passed." }],
		"2".repeat(40),
	);
	assert.equal(lifecycleLine(current), "✓ research  ✓ plan  ✓ build  ✓ done · 1/1 phases");
});
