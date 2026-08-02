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
import {
	blockCurrentPhase,
	FINISH_PHASE_SCHEMA,
	finishCurrentPhase,
	type FinishPhaseInput,
} from "./execution.ts";
import {
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

const phase = (title: string, verification = [`verify ${title}`]): TaskPhase => ({
	title,
	objective: `Complete ${title}.`,
	successCriteria: [`${title} is verified.`],
	verification,
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

function finishInput(
	commands: readonly string[],
	overrides: Partial<FinishPhaseInput> = {},
): FinishPhaseInput {
	return {
		resolution: "Implemented and verified the candidate.",
		commitMessage: "Implement candidate",
		verificationEvidence: commands.map((command) => ({
			command,
			exitCode: 0,
			summary: `${command} passed.`,
		})),
		...overrides,
	};
}

async function assertUnstaged(task: TaskDocument): Promise<void> {
	assert.equal(
		(await git(task.repository.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"]))
			.code,
		0,
	);
}

test("finish schema requires strict structured verification evidence", () => {
	assert.deepEqual(FINISH_PHASE_SCHEMA.required, [
		"resolution",
		"commitMessage",
		"verificationEvidence",
	]);
	assert.equal(FINISH_PHASE_SCHEMA.additionalProperties, false);
	const evidence = FINISH_PHASE_SCHEMA.properties.verificationEvidence;
	assert.equal(evidence.minItems, 1);
	assert.equal(evidence.items.additionalProperties, false);
	assert.deepEqual(evidence.items.required, ["command", "exitCode", "summary"]);
});

test("verification evidence must exactly match declared command count and order", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-match-"));
	try {
		const commands = ["verify first", "verify second"];
		const task = await buildingTask(root, [phase("one", commands)]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		const invalid = [
			finishInput(commands.slice(0, 1)),
			finishInput([...commands, "verify extra"]),
			finishInput([...commands].reverse()),
			finishInput([commands[0], commands[0]]),
		];
		for (const input of invalid) {
			await assert.rejects(finishCurrentPhase(task, input), /verification evidence/i);
			await assertUnstaged(task);
			assert.equal(task.plan?.completed.length, 0);
			assert.equal(task.sessions.build, "/sessions/build.jsonl");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nonzero verification rejects before staging and leaves the phase resumable", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-fail-"));
	try {
		const task = await buildingTask(root, [phase("one")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		const input = finishInput(["verify one"]);
		input.verificationEvidence[0].exitCode = 1;
		input.verificationEvidence[0].summary = "Focused test failed.";
		await assert.rejects(finishCurrentPhase(task, input), /exited with code 1/i);
		await assertUnstaged(task);
		assert.deepEqual((await workspaceStatus(task.repository.worktree)).paths, ["tracked.txt"]);
		assert.equal(task.stage, "building");
		assert.equal(task.sessions.build, "/sessions/build.jsonl");
		assert.equal(task.plan?.completed.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("all-zero evidence is persisted with the commit and advances to a fresh phase", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-pass-"));
	try {
		const task = await buildingTask(root);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		const input = finishInput(["verify phase one"], {
			resolution: " Implemented and tested phase one. ",
			commitMessage: " Implement phase one ",
		});
		const result = await finishCurrentPhase(task, input);
		assert.ok(result.commit);
		assert.equal(result.task.stage, "building");
		assert.equal(result.task.sessions.build, null);
		assert.equal(result.task.plan?.completed[0].resolution, "Implemented and tested phase one.");
		assert.equal(result.task.plan?.completed[0].commit, result.commit);
		assert.deepEqual(
			result.task.plan?.completed[0].verificationEvidence,
			input.verificationEvidence,
		);
		assert.equal(result.task.plan?.remaining[0].title, "phase two");
		assert.equal(run(task.repository.worktree, "log", "-1", "--format=%s"), "Implement phase one");
		assert.deepEqual((await workspaceStatus(task.repository.worktree)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the final changed phase creates a commit and completes the task", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-final-"));
	try {
		const task = await buildingTask(root, [phase("only phase")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "complete\n");
		const result = await finishCurrentPhase(task, finishInput(["verify only phase"]));
		assert.equal(result.task.stage, "done");
		assert.equal(result.task.plan?.remaining.length, 0);
		assert.equal(result.task.plan?.completed.length, 1);
		assert.ok(result.task.plan?.completed[0].commit);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unchanged candidate is refused without advancing", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-no-change-"));
	try {
		const task = await buildingTask(root, [phase("verification")]);
		const initialHead = run(task.repository.worktree, "rev-parse", "HEAD");
		await assert.rejects(
			finishCurrentPhase(task, finishInput(["verify verification"])),
			/unchanged candidate|no changes/i,
		);
		assert.equal(run(task.repository.worktree, "rev-parse", "HEAD"), initialHead);
		assert.equal(task.stage, "building");
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
		await assertUnstaged(task);
		assert.equal(readFileSync(join(task.repository.worktree, "tracked.txt"), "utf8"), "blocked work\n");
		const researching = returnTaskToResearch(blocked);
		assert.equal(researching.stage, "research");
		assert.equal(researching.blockReason, "Need an API decision.");
		assert.equal(researching.sessions.build, "/sessions/build.jsonl");
		const resumed = resumeTaskPhase(blocked);
		assert.equal(resumed.stage, "building");
		assert.equal(resumed.sessions.build, "/sessions/build.jsonl");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an implementation-authored commit is rejected before staging", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-direct-commit-"));
	try {
		const task = await buildingTask(root, [phase("one")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "unauthorized\n");
		run(task.repository.worktree, "add", "-A");
		run(task.repository.worktree, "commit", "-m", "unauthorized");
		await assert.rejects(
			finishCurrentPhase(task, finishInput(["verify one"])),
			/changed Git HEAD outside JURUC/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
