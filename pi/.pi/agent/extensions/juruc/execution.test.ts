import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuditResult } from "../subagent/runtimes.ts";
import {
	blockCurrentPhase,
	currentAuditRequest,
	finishCurrentPhase,
} from "./execution.ts";
import {
	completeTaskPhase,
	createTaskDocument,
	finishTaskResearch,
	recordTaskSession,
	resumeTaskPhase,
	returnTaskToResearch,
	setTaskPlan,
	type TaskDocument,
	type TaskPhase,
} from "./task.ts";
import {
	createTaskWorktree,
	git,
	workspaceStatus,
	type RepositoryEvidence,
} from "./workspace.ts";

function run(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initializeRepository(root: string): RepositoryEvidence {
	mkdirSync(root, { recursive: true });
	run(root, "init", "-b", "main");
	run(root, "config", "user.name", "JURUC Test");
	run(root, "config", "user.email", "juruc@example.invalid");
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	run(root, "add", "-A");
	run(root, "commit", "-m", "baseline");
	return {
		root,
		head: run(root, "rev-parse", "HEAD"),
		branch: "main",
	};
}

const phase = (title: string): TaskPhase => ({
	title,
	objective: `Complete ${title}.`,
	successCriteria: [`${title} is verified.`],
	hints: [],
});

async function buildingTask(
	root: string,
	phases: TaskPhase[] = [phase("phase one"), phase("phase two")],
): Promise<TaskDocument> {
	const source = join(root, "source");
	const repository = initializeRepository(source);
	mkdirSync(join(root, "worktrees"));
	const identity = await createTaskWorktree(
		repository,
		"task",
		join(root, "worktrees", "task"),
	);
	let task = createTaskDocument({
		slug: "task",
		title: "Task",
		request: "Complete the task.",
		repository: identity,
	});
	task = finishTaskResearch(task);
	task = setTaskPlan(task, {
		objective: "Complete all work.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		successCriteria: ["All phases work together."],
		remaining: phases,
	});
	return recordTaskSession(task, "build", "/sessions/build.jsonl");
}

const passingAudit = (
	summary = "Candidate satisfies every criterion.",
): AuditResult => ({
	verdict: "pass",
	summary,
});

const failingAudit = (): AuditResult => ({
	verdict: "fail",
	findings: [
		{
			basis: { source: "phase", criterion: 1 },
			path: "tracked.txt",
			evidence: "The expected value is absent.",
			failure: "Phase behavior is incomplete.",
		},
	],
});

test("audit failure runs once, unstages, and retains the same build session", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-fail-"));
	try {
		const task = await buildingTask(root);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		let calls = 0;
		const result = await finishCurrentPhase(
			task,
			{ resolution: "Implemented the candidate.", commitMessage: "Implement candidate" },
			async (request) => {
				calls++;
				assert.deepEqual(request.stagedPaths, ["tracked.txt"]);
				assert.equal(
					(await git(task.repository.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"]))
						.code,
					1,
				);
				return failingAudit();
			},
		);
		assert.equal(calls, 1);
		assert.equal(result.kind, "audit-failed");
		assert.equal(result.task.stage, "building");
		assert.equal(result.task.sessions.build, "/sessions/build.jsonl");
		assert.equal(result.task.plan?.completed.length, 0);
		assert.match(result.feedback, /Phase behavior is incomplete/);
		assert.equal(
			(await git(task.repository.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"]))
				.code,
			0,
		);
		assert.deepEqual((await workspaceStatus(task.repository.worktree)).paths, ["tracked.txt"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a passing changed candidate is committed once and advances to a fresh phase", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-pass-"));
	try {
		const task = await buildingTask(root);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		let calls = 0;
		const result = await finishCurrentPhase(
			task,
			{
				resolution: " Implemented and tested phase one. ",
				commitMessage: " Implement phase one ",
			},
			async (request) => {
				calls++;
				assert.equal(request.phase.position, 1);
				assert.equal(request.phase.total, 2);
				assert.deepEqual(request.overallCriteria, []);
				return passingAudit();
			},
		);
		assert.equal(calls, 1);
		assert.equal(result.kind, "completed");
		assert.ok(result.commit);
		assert.equal(result.task.stage, "building");
		assert.equal(result.task.sessions.build, null);
		assert.equal(result.task.plan?.completed[0].resolution, "Implemented and tested phase one.");
		assert.equal(result.task.plan?.completed[0].commit, result.commit);
		assert.equal(result.task.plan?.remaining[0].title, "phase two");
		assert.equal(run(task.repository.worktree, "log", "-1", "--format=%s"), "Implement phase one");
		assert.deepEqual((await workspaceStatus(task.repository.worktree)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the final phase audit includes overall criteria and completes the task", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-final-"));
	try {
		const task = await buildingTask(root, [phase("only phase")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "complete\n");
		const result = await finishCurrentPhase(
			task,
			{ resolution: "Completed the task.", commitMessage: "Complete task" },
			async (request) => {
				assert.equal(request.phase.position, request.phase.total);
				assert.deepEqual(request.overallCriteria, ["All phases work together."]);
				return passingAudit("Phase and overall criteria pass.");
			},
		);
		assert.equal(result.kind, "completed");
		assert.equal(result.task.stage, "done");
		assert.equal(result.task.plan?.remaining.length, 0);
		assert.equal(result.task.plan?.completed.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a passing no-change phase records null commit after an audit", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-no-change-"));
	try {
		const task = await buildingTask(root, [phase("verification")]);
		const initialHead = run(task.repository.worktree, "rev-parse", "HEAD");
		let calls = 0;
		const result = await finishCurrentPhase(
			task,
			{ resolution: "Verified without changes.", commitMessage: "Unused message" },
			async (request) => {
				calls++;
				assert.deepEqual(request.stagedPaths, []);
				return passingAudit();
			},
		);
		assert.equal(calls, 1);
		assert.equal(result.kind, "completed");
		assert.equal(result.commit, null);
		assert.equal(result.task.plan?.completed[0].commit, null);
		assert.equal(run(task.repository.worktree, "rev-parse", "HEAD"), initialHead);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("audit runtime failure unstages and does not advance", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-audit-error-"));
	try {
		const task = await buildingTask(root, [phase("one")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		await assert.rejects(
			finishCurrentPhase(
				task,
				{ resolution: "Candidate ready.", commitMessage: "Candidate" },
				async () => {
					throw new Error("audit unavailable");
				},
			),
			/audit unavailable/,
		);
		assert.equal(
			(await git(task.repository.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"]))
				.code,
			0,
		);
		assert.equal(task.plan?.completed.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("blocking preserves dirty work and resumes the same build session", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-block-"));
	try {
		const task = await buildingTask(root, [phase("one")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "blocked work\n");
		run(task.repository.worktree, "add", "-A");
		const blocked = await blockCurrentPhase(task, " Need an API decision. ");
		assert.equal(blocked.stage, "blocked");
		assert.equal(blocked.blockReason, "Need an API decision.");
		assert.equal(blocked.sessions.build, "/sessions/build.jsonl");
		assert.equal(
			(await git(task.repository.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"]))
				.code,
			0,
		);
		assert.equal(readFileSync(join(task.repository.worktree, "tracked.txt"), "utf8"), "blocked work\n");
		const researching = returnTaskToResearch(blocked);
		assert.equal(researching.stage, "research");
		assert.equal(researching.blockReason, "Need an API decision.");
		assert.equal(researching.sessions.build, "/sessions/build.jsonl");
		assert.equal(readFileSync(join(task.repository.worktree, "tracked.txt"), "utf8"), "blocked work\n");
		const resumed = resumeTaskPhase(blocked);
		assert.equal(resumed.stage, "building");
		assert.equal(resumed.sessions.build, "/sessions/build.jsonl");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an implementation-authored commit is rejected before audit", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-direct-commit-"));
	try {
		const task = await buildingTask(root, [phase("one")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "unauthorized\n");
		run(task.repository.worktree, "add", "-A");
		run(task.repository.worktree, "commit", "-m", "unauthorized");
		let calls = 0;
		await assert.rejects(
			finishCurrentPhase(
				task,
				{ resolution: "Done.", commitMessage: "Done" },
				async () => {
					calls++;
					return passingAudit();
				},
			),
			/changed Git HEAD outside JURUC/,
		);
		assert.equal(calls, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("currentAuditRequest uses cumulative source evidence only for the final phase", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-request-"));
	try {
		let task = await buildingTask(root);
		const first = currentAuditRequest(task, ["tracked.txt"]);
		assert.equal(first.phase.position, 1);
		assert.equal(first.phase.total, 2);
		assert.equal(first.baseRef, task.repository.sourceHead);
		assert.deepEqual(first.overallCriteria, []);
		task = completeTaskPhase(task, "First complete.", "2".repeat(40));
		task = recordTaskSession(task, "build", "/sessions/build-2.jsonl");
		const final = currentAuditRequest(task, ["final.txt"]);
		assert.equal(final.phase.position, 2);
		assert.equal(final.phase.total, 2);
		assert.equal(final.baseRef, task.repository.sourceHead);
		assert.deepEqual(final.overallCriteria, ["All phases work together."]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
