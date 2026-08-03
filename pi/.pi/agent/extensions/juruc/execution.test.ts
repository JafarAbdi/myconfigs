import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BUILD_INSTRUCTION,
	BUILD_TOOL_NAMES,
	FINISH_PHASE_SCHEMA,
	finishCurrentPhase,
	RUN_VERIFICATION_SCHEMA,
	runDeclaredVerification,
	type FinishPhaseInput,
} from "./execution.ts";
import {
	acceptTaskPlan,
	appendTaskSession,
	completeTaskResearch,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	findTaskSession,
	MAX_TASK_TEXT_LENGTH,
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
	return { root, head: run(root, "rev-parse", "HEAD"), branch: "main" };
}

const phase = (
	id: string,
	verification = [`verify ${id}`],
	fileScopes = ["tracked.txt"],
): TaskPhase => ({
	id,
	title: id.replaceAll("-", " "),
	goal: `Complete ${id}.`,
	fileScopes,
	instructions: [`Implement ${id}.`],
	verification,
});

async function implementationTask(
	root: string,
	phases: TaskPhase[] = [phase("phase-one"), phase("phase-two")],
): Promise<TaskDocument> {
	const source = join(root, "source");
	const repository = initializeRepository(source);
	mkdirSync(join(root, "worktrees"));
	const identity = await createTaskWorktree(repository, "task", join(root, "worktrees", "task"));
	let task = createTaskDocument({
		slug: "task",
		title: "Task",
		request: "Complete the task.",
		repository: identity,
	});
	task = confirmTaskQuestions(task, {
		sharedUnderstanding: "Complete the task.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	task = completeTaskResearch(task);
	task = confirmTaskSpecification(task, {
		summary: "Complete it.",
		requirements: ["Complete every phase."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["All tests pass."],
		decisions: [],
	});
	task = acceptTaskPlan(task, { phases });
	return appendTaskSession(task, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/implementation-1.jsonl",
	});
}

function finishInput(commands: readonly string[]): FinishPhaseInput {
	return {
		resolution: "Implemented and verified.",
		commitMessage: "Implement phase",
		verificationEvidence: commands.map((command) => ({
			command,
			exitCode: 0,
			summary: `${command} passed.`,
		})),
	};
}

async function assertUnstaged(task: TaskDocument): Promise<void> {
	assert.equal(
		(await git(task.repository.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"])).code,
		0,
	);
}

test("implementation exposes only the strict verification runner schema", () => {
	assert.deepEqual(FINISH_PHASE_SCHEMA.required, [
		"resolution",
		"commitMessage",
		"verificationEvidence",
	]);
	assert.equal(FINISH_PHASE_SCHEMA.properties.resolution.maxLength, MAX_TASK_TEXT_LENGTH);
	assert.equal(FINISH_PHASE_SCHEMA.properties.verificationEvidence.items.additionalProperties, false);
	assert.deepEqual(RUN_VERIFICATION_SCHEMA.required, ["command"]);
	assert.equal(RUN_VERIFICATION_SCHEMA.additionalProperties, false);
	assert.equal(BUILD_TOOL_NAMES.includes("bash" as never), false);
	assert.ok(BUILD_TOOL_NAMES.includes("juruc_run_verification"));
	assert.match(BUILD_INSTRUCTION, /no shell tool/i);
	assert.match(BUILD_INSTRUCTION, /juruc_run_verification as a sole tool call/i);
});

test("declared verification runs in the worktree with bounded output", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-verification-run-"));
	try {
		const cwdCommand = "node -e \"console.log(process.cwd())\"";
		const failedCommand = "node -e \"console.error('failed'); process.exit(3)\"";
		const largeCommand = "node -e \"process.stdout.write('x'.repeat(60000))\"";
		const task = await implementationTask(root, [phase("verify", [
			cwdCommand,
			failedCommand,
			largeCommand,
		])]);
		const cwd = await runDeclaredVerification(task, cwdCommand);
		assert.equal(cwd.command, cwdCommand);
		assert.equal(cwd.exitCode, 0);
		assert.equal(cwd.output.trim(), task.repository.worktree);
		assert.equal(cwd.truncated, false);

		const failed = await runDeclaredVerification(task, failedCommand);
		assert.equal(failed.exitCode, 3);
		assert.match(failed.output, /failed/);

		const large = await runDeclaredVerification(task, largeCommand);
		assert.equal(large.exitCode, 0);
		assert.equal(large.truncated, true);
		assert.ok(Buffer.byteLength(large.output) <= 50 * 1024);

		const undeclared = join(task.repository.worktree, "undeclared.txt");
		assert.throws(
			() => runDeclaredVerification(task, `touch ${undeclared}`),
			/not declared by the active phase/,
		);
		assert.equal(existsSync(undeclared), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("declared verification reports cancellation and timeout", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-verification-stop-"));
	try {
		const command = "node -e \"setTimeout(() => {}, 10000)\"";
		const task = await implementationTask(root, [phase("verify", [command])]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const cancelled = await runDeclaredVerification(task, command, controller.signal);
		assert.equal(cancelled.cancelled, true);
		assert.equal(cancelled.timedOut, false);
		assert.equal(cancelled.exitCode, undefined);

		const timedOut = await runDeclaredVerification(task, command, undefined, 20);
		assert.equal(timedOut.cancelled, false);
		assert.equal(timedOut.timedOut, true);
		assert.equal(timedOut.exitCode, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("mismatched or nonzero evidence leaves the implementation phase resumable and unstaged", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-fail-"));
	try {
		const commands = ["verify first", "verify second"];
		const task = await implementationTask(root, [phase("one", commands)]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		for (const input of [
			finishInput(commands.slice(0, 1)),
			finishInput([...commands].reverse()),
			finishInput([commands[0], commands[0]]),
		]) {
			await assert.rejects(finishCurrentPhase(task, input), /verification evidence/i);
			await assertUnstaged(task);
		}
		const failed = finishInput(commands);
		failed.verificationEvidence[1].exitCode = 1;
		await assert.rejects(finishCurrentPhase(task, failed), /exited with code 1/);
		await assertUnstaged(task);
		assert.equal(task.stage, "implementation");
		assert.deepEqual(task.checkpoints, []);
		assert.deepEqual((await workspaceStatus(task.repository.worktree)).paths, ["tracked.txt"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid persisted resolutions are rejected before staging", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-resolution-"));
	try {
		const task = await implementationTask(root, [phase("one")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate\n");
		for (const resolution of [
			" not trimmed",
			"contains\0nul",
			"x".repeat(MAX_TASK_TEXT_LENGTH + 1),
		]) {
			await assert.rejects(
				finishCurrentPhase(task, { ...finishInput(["verify one"]), resolution }),
				/phase resolution/,
			);
			await assertUnstaged(task);
		}
		assert.equal(run(task.repository.worktree, "rev-parse", "HEAD"), task.repository.sourceHead);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("successful exact-scope evidence commits a checkpoint and leaves the next phase unopened", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-pass-"));
	try {
		const task = await implementationTask(root);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "candidate one\n");
		const input = finishInput(["verify phase-one"]);
		const result = await finishCurrentPhase(task, input);
		assert.equal(result.task.stage, "implementation");
		assert.equal(result.task.checkpoints.length, 1);
		assert.deepEqual(result.task.checkpoints[0].verificationEvidence, input.verificationEvidence);
		assert.equal(result.task.checkpoints[0].id, "phase-one");
		assert.ok(result.task.checkpoints[0].commit);
		assert.equal(findTaskSession(result.task, { kind: "implementation", phase: 2 }), undefined);
		assert.equal(run(task.repository.worktree, "log", "-1", "--format=%s"), "Implement phase");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Git pathspec scopes accept globbed new files and scoped deletions", async () => {
	const newRoot = mkdtempSync(join(tmpdir(), "juruc-phase-new-scope-"));
	const deletedRoot = mkdtempSync(join(tmpdir(), "juruc-phase-delete-scope-"));
	try {
		const newTask = await implementationTask(newRoot, [phase("new-file", undefined, ["src/**"])]);
		mkdirSync(join(newTask.repository.worktree, "src"));
		writeFileSync(join(newTask.repository.worktree, "src", "new.ts"), "new\n");
		assert.equal(
			(await finishCurrentPhase(newTask, finishInput(["verify new-file"]))).task.stage,
			"done",
		);

		const deletedTask = await implementationTask(deletedRoot, [phase("delete", undefined, ["tracked.txt"])]);
		rmSync(join(deletedTask.repository.worktree, "tracked.txt"));
		assert.equal(
			(await finishCurrentPhase(deletedTask, finishInput(["verify delete"]))).task.stage,
			"done",
		);
	} finally {
		rmSync(newRoot, { recursive: true, force: true });
		rmSync(deletedRoot, { recursive: true, force: true });
	}
});

test("Git pathspec scopes preserve in-scope renames and reject cross-scope moves", async () => {
	const inScopeRoot = mkdtempSync(join(tmpdir(), "juruc-phase-rename-in-"));
	const crossScopeRoot = mkdtempSync(join(tmpdir(), "juruc-phase-rename-cross-"));
	try {
		const inScope = await implementationTask(
			inScopeRoot,
			[phase("rename-in", undefined, ["*.txt"])],
		);
		renameSync(
			join(inScope.repository.worktree, "tracked.txt"),
			join(inScope.repository.worktree, "renamed.txt"),
		);
		assert.equal(
			(await finishCurrentPhase(inScope, finishInput(["verify rename-in"]))).task.stage,
			"done",
		);

		const crossScope = await implementationTask(
			crossScopeRoot,
			[phase("rename-cross", undefined, ["src/**"])],
		);
		mkdirSync(join(crossScope.repository.worktree, "src"));
		renameSync(
			join(crossScope.repository.worktree, "tracked.txt"),
			join(crossScope.repository.worktree, "src", "tracked.txt"),
		);
		await assert.rejects(
			finishCurrentPhase(crossScope, finishInput(["verify rename-cross"])),
			/outside active phase file scopes: tracked\.txt/,
		);
		await assertUnstaged(crossScope);
		assert.deepEqual((await workspaceStatus(crossScope.repository.worktree)).paths, [
			"src/tracked.txt",
			"tracked.txt",
		]);
	} finally {
		rmSync(inScopeRoot, { recursive: true, force: true });
		rmSync(crossScopeRoot, { recursive: true, force: true });
	}
});

test("out-of-scope new paths are rejected and unstaged", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-outside-scope-"));
	try {
		const task = await implementationTask(root, [phase("scoped", undefined, ["src/**"])]);
		writeFileSync(join(task.repository.worktree, "outside.txt"), "outside\n");
		await assert.rejects(
			finishCurrentPhase(task, finishInput(["verify scoped"])),
			/outside active phase file scopes: outside\.txt/,
		);
		await assertUnstaged(task);
		assert.deepEqual((await workspaceStatus(task.repository.worktree)).paths, ["outside.txt"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("final checkpoint reaches done and unchanged candidates are refused", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-final-"));
	try {
		const task = await implementationTask(root, [phase("only")]);
		await assert.rejects(finishCurrentPhase(task, finishInput(["verify only"])), /unchanged candidate/);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "complete\n");
		const result = await finishCurrentPhase(task, finishInput(["verify only"]));
		assert.equal(result.task.stage, "done");
		assert.equal(result.task.checkpoints.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("implementation-authored commits are rejected", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-phase-direct-"));
	try {
		const task = await implementationTask(root, [phase("one")]);
		writeFileSync(join(task.repository.worktree, "tracked.txt"), "unauthorized\n");
		run(task.repository.worktree, "add", "-A");
		run(task.repository.worktree, "commit", "-m", "unauthorized");
		await assert.rejects(finishCurrentPhase(task, finishInput(["verify one"])), /changed Git HEAD/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
