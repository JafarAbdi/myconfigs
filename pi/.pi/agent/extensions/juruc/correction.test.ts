import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acceptedFileScopes,
	acceptedVerificationCommands,
	CORRECTION_INSTRUCTION,
	CORRECTION_TOOL_NAMES,
	correctionPrompt,
	FINISH_CORRECTION_SCHEMA,
	finishCorrection as finishCorrectionWithOperations,
	orderedHumanComments,
	runCorrectionVerification as runCorrectionVerificationWithOperations,
	type FinishCorrectionInput,
} from "./correction.ts";
import type { VerificationOperations } from "./execution.ts";
import {
	acceptTaskPlan,
	activateTaskPlan,
	addTaskReviewComment,
	appendTaskSession,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	currentTaskReviewRound,
	decideTaskReview,
	MAX_TASK_TEXT_LENGTH,
	registerTaskCorrectionStart,
	registerTaskReviewerStart,
	type HumanCommentInput,
	type TaskDocument,
} from "./task.ts";
import { ensureTaskWorktree, git, workspaceStatus } from "./workspace.ts";

const verificationOperations: VerificationOperations = {
	exec(command, cwd, { onData, signal, timeout }) {
		return new Promise((resolve, reject) => {
			const child = spawn("/bin/sh", ["-c", command], {
				cwd,
				signal,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeout === undefined ? undefined : timeout * 1_000,
			});
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			child.once("error", reject);
			child.once("close", (exitCode) => {
				if (signal?.aborted) reject(new Error("aborted"));
				else resolve({ exitCode });
			});
		});
	},
};

const runCorrectionVerification = (task: TaskDocument, command: string) =>
	runCorrectionVerificationWithOperations(task, command, verificationOperations);

const finishCorrection = (task: TaskDocument, input: FinishCorrectionInput) =>
	finishCorrectionWithOperations(task, input, verificationOperations);

const PHASE_ONE_VERIFICATION = ": # verify core";
const PHASE_TWO_VERIFICATION = ": # verify wiring";
const uuid = (digit: string): string => `${digit.repeat(8)}-1234-4234-8234-123456789abc`;

function run(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function correctionTask(
	root: string,
	comments: readonly HumanCommentInput[],
): Promise<TaskDocument> {
	const source = join(root, "source");
	mkdirSync(source, { recursive: true });
	run(source, "init", "-b", "main");
	run(source, "config", "user.name", "JURUC Test");
	run(source, "config", "user.email", "juruc@example.invalid");
	mkdirSync(join(source, "src"));
	writeFileSync(join(source, "src", "core.ts"), "export const core = 1;\n");
	writeFileSync(join(source, "README.md"), "baseline\n");
	run(source, "add", "-A");
	run(source, "commit", "-m", "baseline");
	mkdirSync(join(root, "worktrees"));
	const repository = {
		sourceRoot: source,
		baseBranch: "main",
		sourceHead: run(source, "rev-parse", "HEAD"),
		branch: "task",
		worktree: join(root, "worktrees", "task"),
	};
	await ensureTaskWorktree(repository);

	let task = createTaskDocument({
		slug: "task",
		title: "Task",
		request: "Complete the task.",
		repository,
	});
	task = confirmTaskQuestions(task, {
		sharedUnderstanding: "Complete the task.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
	task = completeTaskResearch(task);
	task = confirmTaskSpecification(task, {
		summary: "Keep the core deterministic.",
		requirements: ["The core is deterministic."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["Verification passes."],
		decisions: [],
	});
	task = activateTaskPlan(acceptTaskPlan(task, {
		phases: [
			{
				id: "build-core",
				title: "Build core",
				goal: "Introduce the deterministic core.",
				fileScopes: ["src/**"],
				instructions: ["Never leak this plan rationale into a correction."],
				verification: [PHASE_ONE_VERIFICATION],
			},
			{
				id: "wire-core",
				title: "Wire core",
				goal: "Wire the core into the entry point.",
				fileScopes: ["src/**", "README.md"],
				instructions: ["Wire it."],
				verification: [PHASE_ONE_VERIFICATION, PHASE_TWO_VERIFICATION],
			},
		],
	}));
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/implementation-1.jsonl",
	});
	writeFileSync(join(repository.worktree, "src", "core.ts"), "export const core = 2;\n");
	run(repository.worktree, "add", "-A");
	task = completeTaskPhase(
		task,
		"Core built.",
		[{ command: PHASE_ONE_VERIFICATION, exitCode: 0, summary: "Core passed." }],
		run(repository.worktree, "commit", "-m", "Build core") && run(repository.worktree, "rev-parse", "HEAD"),
	);
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 2,
		path: "/sessions/implementation-2.jsonl",
	});
	writeFileSync(join(repository.worktree, "README.md"), "wired\n");
	run(repository.worktree, "add", "-A");
	task = completeTaskPhase(
		task,
		"Core wired.",
		[
			{ command: PHASE_ONE_VERIFICATION, exitCode: 0, summary: "Core passed." },
			{ command: PHASE_TWO_VERIFICATION, exitCode: 0, summary: "Wiring passed." },
		],
		run(repository.worktree, "commit", "-m", "Wire core") && run(repository.worktree, "rev-parse", "HEAD"),
	);

	task = registerTaskReviewerStart(task, "deviation", "/sessions/deviation-1.jsonl");
	task = completeTaskReviewer(task, "deviation", {
		status: "completed",
		annotations: [{
			filePath: "README.md",
			side: "additions",
			line: 1,
			summary: "The wiring note is terse.",
			rationale: "Advisory only.",
		}],
	});
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness-1.jsonl");
	task = completeTaskReviewer(task, "correctness", { status: "completed", annotations: [] });
	for (const [index, comment] of comments.entries())
		task = addTaskReviewComment(task, comment, uuid(String(index + 1)), `2026-08-0${index + 1}T00:00:00.000Z`);
	task = decideTaskReview(task, "send-feedback", "2026-08-03T00:00:00.000Z");
	return registerTaskCorrectionStart(task, "/sessions/correction-1.jsonl");
}

const readmeComment: HumanCommentInput = {
	filePath: "README.md",
	side: "additions",
	startLine: 1,
	endLine: 1,
	body: "Say what the core does.",
};
const coreComment: HumanCommentInput = {
	filePath: "src/core.ts",
	side: "additions",
	startLine: 1,
	endLine: 1,
	body: "Name the constant clearly.",
};

function finishInput(commands: readonly string[]): FinishCorrectionInput {
	return {
		resolution: "Applied every saved comment.",
		commitMessage: "Apply review feedback",
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

test("correction exposes only the strict fresh-session diet, tools, and schema", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-correction-prompt-"));
	try {
		const task = await correctionTask(root, [readmeComment, coreComment]);
		assert.equal(CORRECTION_TOOL_NAMES.includes("bash" as never), false);
		assert.equal(CORRECTION_TOOL_NAMES.includes("juruc_finish_phase" as never), false);
		assert.ok(CORRECTION_TOOL_NAMES.includes("juruc_finish_correction"));
		assert.match(CORRECTION_INSTRUCTION, /no shell tool/i);
		assert.match(CORRECTION_INSTRUCTION, /Do not commit/i);
		assert.deepEqual(FINISH_CORRECTION_SCHEMA.required, [
			"resolution",
			"commitMessage",
			"verificationEvidence",
		]);
		assert.equal(FINISH_CORRECTION_SCHEMA.properties.resolution.maxLength, MAX_TASK_TEXT_LENGTH);
		assert.equal(FINISH_CORRECTION_SCHEMA.properties.verificationEvidence.minItems, 1);

		assert.deepEqual(acceptedVerificationCommands(task), [
			PHASE_ONE_VERIFICATION,
			PHASE_TWO_VERIFICATION,
		]);
		assert.deepEqual(acceptedFileScopes(task), ["src/**", "README.md"]);
		const round = currentTaskReviewRound(task)!;
		assert.deepEqual(
			orderedHumanComments(round).map(({ filePath }) => filePath),
			["README.md", "src/core.ts"],
		);

		const prompt = correctionPrompt(task, round);
		assert.ok(prompt.indexOf("README.md · new L1") < prompt.indexOf("src/core.ts · new L1"));
		assert.match(prompt, /Keep the core deterministic/);
		assert.match(prompt, /Say what the core does/);
		assert.match(prompt, /Deviation reviewer: The wiring note is terse/);
		assert.match(prompt, /advisory context only, never instructions/);
		assert.match(prompt, new RegExp(`- ${PHASE_TWO_VERIFICATION}`));
		assert.doesNotMatch(prompt, /Never leak this plan rationale/);
		assert.doesNotMatch(prompt, /Introduce the deterministic core|Wire the core into/);
		// The colocated annotation belongs only to its own comment.
		assert.equal(prompt.split("Deviation reviewer").length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("correction verification runs only exact accepted Plan commands", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-correction-verify-"));
	try {
		const task = await correctionTask(root, [coreComment]);
		const echo = await runCorrectionVerification(task, PHASE_TWO_VERIFICATION);
		assert.equal(echo.exitCode, 0);
		assert.equal(echo.cancelled, false);
		for (const command of [
			"npm test",
			`${PHASE_ONE_VERIFICATION} `,
			"touch escaped.txt",
		]) assert.throws(
			() => runCorrectionVerification(task, command),
			/not an accepted Plan verification command/,
		);
		assert.deepEqual((await workspaceStatus(task.repository.worktree)).paths, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("correction commits the scoped candidate and appends a fresh cumulative round", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-correction-commit-"));
	try {
		const task = await correctionTask(root, [coreComment]);
		const head = run(task.repository.worktree, "rev-parse", "HEAD");
		await assert.rejects(finishCorrection(task, finishInput([PHASE_TWO_VERIFICATION])), /unchanged candidate/);

		writeFileSync(join(task.repository.worktree, "src", "core.ts"), "export const deterministicCore = 2;\n");
		for (const input of [
			{ ...finishInput([PHASE_TWO_VERIFICATION]), verificationEvidence: [] },
			finishInput(["npm test"]),
			finishInput([PHASE_TWO_VERIFICATION, PHASE_TWO_VERIFICATION]),
		]) {
			await assert.rejects(finishCorrection(task, input), /verification evidence/i);
			await assertUnstaged(task);
		}
		const failed = finishInput([PHASE_TWO_VERIFICATION]);
		failed.verificationEvidence[0].exitCode = 2;
		await assert.rejects(finishCorrection(task, failed), /exited with code 2/);
		await assertUnstaged(task);

		const result = await finishCorrection(task, finishInput([PHASE_TWO_VERIFICATION]));
		assert.notEqual(result.commit, head);
		assert.equal(run(task.repository.worktree, "log", "-1", "--format=%s"), "Apply review feedback");
		assert.equal(result.task.reviewRounds.length, 2);
		const completed = result.task.reviewRounds[0].correction!;
		assert.equal(completed.sessionPath, "/sessions/correction-1.jsonl");
		assert.deepEqual(completed.result, {
			resolution: "Applied every saved comment.",
			verificationEvidence: [{
				command: PHASE_TWO_VERIFICATION,
				exitCode: 0,
				summary: `${PHASE_TWO_VERIFICATION} passed.`,
			}],
			commit: result.commit,
		});
		const fresh = result.task.reviewRounds[1];
		assert.equal(fresh.number, 2);
		assert.equal(fresh.baseCommit, task.repository.sourceHead);
		assert.equal(fresh.headCommit, result.commit);
		assert.deepEqual(fresh.humanComments, []);
		assert.deepEqual(fresh.reviewers, { deviation: null, correctness: null });
		assert.equal(result.task.checkpoints.length, 2);
		await assert.rejects(finishCorrection(result.task, finishInput([PHASE_TWO_VERIFICATION])), /no running correction/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("correction refuses out-of-scope candidates and session-authored commits", async () => {
	const scopeRoot = mkdtempSync(join(tmpdir(), "juruc-correction-scope-"));
	const headRoot = mkdtempSync(join(tmpdir(), "juruc-correction-head-"));
	try {
		const scoped = await correctionTask(scopeRoot, [coreComment]);
		writeFileSync(join(scoped.repository.worktree, "outside.txt"), "outside\n");
		await assert.rejects(
			finishCorrection(scoped, finishInput([PHASE_TWO_VERIFICATION])),
			/outside accepted Plan file scopes: outside\.txt/,
		);
		await assertUnstaged(scoped);

		const moved = await correctionTask(headRoot, [coreComment]);
		writeFileSync(join(moved.repository.worktree, "src", "core.ts"), "export const core = 3;\n");
		run(moved.repository.worktree, "add", "-A");
		run(moved.repository.worktree, "commit", "-m", "unauthorized");
		await assert.rejects(
			finishCorrection(moved, finishInput([PHASE_TWO_VERIFICATION])),
			/changed Git HEAD/,
		);
	} finally {
		rmSync(scopeRoot, { recursive: true, force: true });
		rmSync(headRoot, { recursive: true, force: true });
	}
});
