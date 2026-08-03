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
	runCorrectionVerification as runCorrectionVerificationWithOperations,
	type FinishCorrectionInput,
} from "./correction.ts";
import type { VerificationOperations } from "./execution.ts";
import {
	acceptTaskCorrectionPlan,
	acceptTaskPlan,
	activateTaskPlan,
	addTaskReviewComment,
	appendTaskSession,
	completeTaskPhase,
	completeTaskResearch,
	completeTaskReviewer,
	confirmTaskCorrectionFeedback,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	currentTaskReviewRound,
	decideTaskReview,
	MAX_TASK_TEXT_LENGTH,
	registerTaskCorrectionPlanStart,
	registerTaskCorrectionStart,
	registerTaskFeedbackGrillStart,
	registerTaskReviewerStart,
	type TaskDocument,
	type VerificationEvidence,
} from "./task.ts";
import { ensureTaskWorktree, git } from "./workspace.ts";

const OLD_PLAN_COMMAND = ": # EXCLUDED_OLD_PLAN_COMMAND";
const CORRECTION_COMMAND_ONE = ": # INCLUDED_NEW_CORRECTION_COMMAND_ONE";
const CORRECTION_COMMAND_TWO = ": # INCLUDED_NEW_CORRECTION_COMMAND_TWO";

const shellVerificationOperations: VerificationOperations = {
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

function run(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function correctionTask(root: string): Promise<TaskDocument> {
	const source = join(root, "source");
	mkdirSync(join(source, "src"), { recursive: true });
	run(source, "init", "-b", "main");
	run(source, "config", "user.name", "JURUC Test");
	run(source, "config", "user.email", "juruc@example.invalid");
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
		request: "EXCLUDED_ORIGINAL_REQUEST",
		repository,
	});
	task = confirmTaskQuestions(task, {
		sharedUnderstanding: "EXCLUDED_QUESTIONS",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: ["EXCLUDED_RESEARCH"],
	});
	task = completeTaskResearch(task);
	task = confirmTaskSpecification(task, {
		summary: "INCLUDED_VALIDATED_SPECIFICATION",
		requirements: ["Keep the corrected core deterministic."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["The accepted correction checks pass."],
		decisions: [],
	});
	task = activateTaskPlan(acceptTaskPlan(task, { phases: [{
		id: "implement",
		title: "Implement",
		goal: "EXCLUDED_ORIGINAL_PLAN",
		fileScopes: ["src/core.ts"],
		instructions: ["EXCLUDED_PLAN_INSTRUCTION"],
		verification: [OLD_PLAN_COMMAND],
	}] }));
	task = appendTaskSession(task, {
		kind: "implementation",
		phase: 1,
		path: "/sessions/EXCLUDED_IMPLEMENTATION_TRANSCRIPT.jsonl",
	});
	writeFileSync(join(repository.worktree, "src", "core.ts"), "export const core = 2;\n");
	run(repository.worktree, "add", "-A");
	run(repository.worktree, "commit", "-m", "Implement core");
	task = completeTaskPhase(task, "EXCLUDED_CHECKPOINT_RESOLUTION", [{
		command: OLD_PLAN_COMMAND,
		exitCode: 0,
		summary: "EXCLUDED_PRIOR_EVIDENCE",
	}], run(repository.worktree, "rev-parse", "HEAD"));

	task = registerTaskReviewerStart(task, "deviation", "/sessions/EXCLUDED_REVIEW_TRANSCRIPT.jsonl");
	task = completeTaskReviewer(task, "deviation", {
		status: "completed",
		annotations: [{
			filePath: "src/core.ts",
			side: "additions",
			line: 1,
			summary: "EXCLUDED_REVIEWER_ANNOTATION",
		}],
	});
	task = registerTaskReviewerStart(task, "correctness", "/sessions/correctness.jsonl");
	task = completeTaskReviewer(task, "correctness", { status: "completed", annotations: [] });
	task = addTaskReviewComment(task, {
		filePath: "src/core.ts",
		side: "additions",
		startLine: 1,
		endLine: 1,
		body: "EXCLUDED_RAW_SAVED_COMMENT",
	}, "12345678-1234-4234-8234-123456789abc", "2026-08-01T00:00:00.000Z");
	task = decideTaskReview(task, "send-feedback", "2026-08-02T00:00:00.000Z");
	task = registerTaskFeedbackGrillStart(task, "/sessions/EXCLUDED_FEEDBACK_TRANSCRIPT.jsonl");
	task = confirmTaskCorrectionFeedback(task, {
		sharedUnderstanding: "INCLUDED_CONFIRMED_FEEDBACK",
		corrections: ["Rename the core and document it."],
		decisions: ["Preserve the exported value."],
		acceptedAssumptions: [],
	});
	task = registerTaskCorrectionPlanStart(task, "/sessions/EXCLUDED_CORRECTION_PLAN_TRANSCRIPT.jsonl");
	task = acceptTaskCorrectionPlan(task, {
		goal: "INCLUDED_ACCEPTED_CORRECTION_PLAN",
		fileScopes: ["src/core.ts", "README.md"],
		dependencies: ["Existing core module."],
		instructions: ["Rename the core.", "Document the corrected behavior."],
		verification: [CORRECTION_COMMAND_ONE, CORRECTION_COMMAND_TWO],
	});
	return registerTaskCorrectionStart(task, "/sessions/EXCLUDED_CORRECTION_TRANSCRIPT.jsonl");
}

function evidence(commands: readonly string[]): VerificationEvidence[] {
	return commands.map((command) => ({ command, exitCode: 0, summary: `${command} passed.` }));
}

function finishInput(commands = [CORRECTION_COMMAND_ONE, CORRECTION_COMMAND_TWO]): FinishCorrectionInput {
	return {
		resolution: "Applied the accepted correction plan.",
		commitMessage: "Apply review feedback",
		verificationEvidence: evidence(commands),
	};
}

function finishCorrection(
	task: TaskDocument,
	input: FinishCorrectionInput,
	operations: VerificationOperations = shellVerificationOperations,
) {
	return finishCorrectionWithOperations(task, input, operations);
}

async function assertUnstaged(task: TaskDocument): Promise<void> {
	assert.equal(
		(await git(task.repository.worktree, ["diff", "--cached", "--quiet", "HEAD", "--"])).code,
		0,
	);
}

test("correction exposes only bounded implementation tools and exact full-plan instructions", () => {
	assert.deepEqual(CORRECTION_TOOL_NAMES, [
		"read", "edit", "write", "grep", "find", "ls",
		"juruc_run_verification", "juruc_finish_correction",
	]);
	for (const forbidden of ["bash", "shell", "commit", "git"])
		assert.equal(CORRECTION_TOOL_NAMES.includes(forbidden as never), false);
	for (const phrase of [
		"only the supplied accepted correction plan and confirmed feedback",
		"no shell tool",
		"Do not commit",
		"every verification command",
		"exactly as written and in accepted order",
		"every accepted command exactly once in accepted order",
		"authoritatively reruns the full accepted command list",
		"stages the complete candidate",
		"creates the local correction commit",
	]) assert.match(CORRECTION_INSTRUCTION, new RegExp(phrase, "i"));
	assert.deepEqual(FINISH_CORRECTION_SCHEMA.required, [
		"resolution", "commitMessage", "verificationEvidence",
	]);
	assert.equal(FINISH_CORRECTION_SCHEMA.properties.resolution.maxLength, MAX_TASK_TEXT_LENGTH);
	assert.equal(FINISH_CORRECTION_SCHEMA.properties.verificationEvidence.minItems, 1);
});

test("correction prompt contains only Specification, confirmed feedback, accepted plan, and candidate state", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-correction-prompt-"));
	try {
		const task = await correctionTask(root);
		assert.deepEqual(acceptedVerificationCommands(task), [
			CORRECTION_COMMAND_ONE,
			CORRECTION_COMMAND_TWO,
		]);
		assert.deepEqual(acceptedFileScopes(task), ["src/core.ts", "README.md"]);
		const prompt = correctionPrompt(task, currentTaskReviewRound(task)!);
		for (const included of [
			"INCLUDED_VALIDATED_SPECIFICATION",
			"INCLUDED_CONFIRMED_FEEDBACK",
			"INCLUDED_ACCEPTED_CORRECTION_PLAN",
			"INCLUDED_NEW_CORRECTION_COMMAND_ONE",
			"current worktree candidate",
			"has not been committed",
		]) assert.match(prompt, new RegExp(included));
		for (const excluded of [
			"EXCLUDED_ORIGINAL_REQUEST",
			"EXCLUDED_QUESTIONS",
			"EXCLUDED_RESEARCH",
			"EXCLUDED_ORIGINAL_PLAN",
			"EXCLUDED_PLAN_INSTRUCTION",
			"EXCLUDED_OLD_PLAN_COMMAND",
			"EXCLUDED_CHECKPOINT_RESOLUTION",
			"EXCLUDED_PRIOR_EVIDENCE",
			"EXCLUDED_REVIEWER_ANNOTATION",
			"EXCLUDED_RAW_SAVED_COMMENT",
			"EXCLUDED_IMPLEMENTATION_TRANSCRIPT",
			"EXCLUDED_REVIEW_TRANSCRIPT",
			"EXCLUDED_FEEDBACK_TRANSCRIPT",
			"EXCLUDED_CORRECTION_PLAN_TRANSCRIPT",
			"EXCLUDED_CORRECTION_TRANSCRIPT",
		]) assert.doesNotMatch(prompt, new RegExp(excluded));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("correction verification accepts new nested-plan commands and rejects old Plan commands", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-correction-verify-"));
	try {
		const task = await correctionTask(root);
		assert.equal((await runCorrectionVerificationWithOperations(
			task,
			CORRECTION_COMMAND_TWO,
			shellVerificationOperations,
		)).exitCode, 0);
		for (const command of [
			OLD_PLAN_COMMAND,
			`${CORRECTION_COMMAND_ONE} `,
			"touch escaped.txt",
		]) assert.throws(
			() => runCorrectionVerificationWithOperations(task, command, shellVerificationOperations),
			/not in the accepted correction plan/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finish rejects missing, reordered, duplicate, extra, failed, and oversized evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-correction-evidence-"));
	try {
		const task = await correctionTask(root);
		writeFileSync(join(task.repository.worktree, "src", "core.ts"), "export const deterministicCore = 2;\n");
		const invalid = [
			finishInput([CORRECTION_COMMAND_ONE]),
			finishInput([CORRECTION_COMMAND_TWO, CORRECTION_COMMAND_ONE]),
			finishInput([CORRECTION_COMMAND_ONE, CORRECTION_COMMAND_ONE]),
			finishInput([CORRECTION_COMMAND_ONE, CORRECTION_COMMAND_TWO, OLD_PLAN_COMMAND]),
		];
		const failed = finishInput();
		failed.verificationEvidence[1].exitCode = 2;
		invalid.push(failed);
		const oversized = finishInput();
		oversized.verificationEvidence[0].summary = "x".repeat(1_001);
		invalid.push(oversized);
		for (const input of invalid) {
			await assert.rejects(finishCorrection(task, input), /verification evidence|exited with code 2/i);
			await assertUnstaged(task);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finish reruns the full nested plan in order, commits expanded scope, and starts the next review", async () => {
	const root = mkdtempSync(join(tmpdir(), "juruc-correction-finish-"));
	try {
		const task = await correctionTask(root);
		const previousHead = run(task.repository.worktree, "rev-parse", "HEAD");
		writeFileSync(join(task.repository.worktree, "README.md"), "deterministic core\n");
		const commands: string[] = [];
		const operations: VerificationOperations = {
			exec(command) {
				commands.push(command);
				return Promise.resolve({ exitCode: 0 });
			},
		};
		const result = await finishCorrection(task, finishInput(), operations);
		assert.deepEqual(commands, [CORRECTION_COMMAND_ONE, CORRECTION_COMMAND_TWO]);
		assert.notEqual(result.commit, previousHead);
		assert.equal(run(task.repository.worktree, "log", "-1", "--format=%s"), "Apply review feedback");
		assert.equal(result.task.reviewRounds.length, 2);
		assert.deepEqual(result.task.reviewRounds[0].correction?.result, {
			resolution: "Applied the accepted correction plan.",
			verificationEvidence: evidence([CORRECTION_COMMAND_ONE, CORRECTION_COMMAND_TWO]),
			commit: result.commit,
		});
		assert.deepEqual(result.task.reviewRounds[0].correction?.correctionPlan?.acceptedPlan?.fileScopes,
			["src/core.ts", "README.md"]);
		assert.deepEqual(result.task.reviewRounds[1], {
			number: 2,
			baseCommit: task.repository.sourceHead,
			headCommit: result.commit,
			reviewers: { deviation: null, correctness: null },
			humanComments: [],
			decision: null,
			correction: null,
		});
		assert.equal(result.task.checkpoints.length, 1);
		await assert.rejects(finishCorrection(result.task, finishInput()), /no running correction/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finish refuses empty and out-of-correction-plan-scope candidates", async () => {
	const emptyRoot = mkdtempSync(join(tmpdir(), "juruc-correction-empty-"));
	const scopeRoot = mkdtempSync(join(tmpdir(), "juruc-correction-scope-"));
	try {
		const empty = await correctionTask(emptyRoot);
		await assert.rejects(finishCorrection(empty, finishInput()), /unchanged candidate/);

		const scoped = await correctionTask(scopeRoot);
		writeFileSync(join(scoped.repository.worktree, "outside.txt"), "outside\n");
		await assert.rejects(
			finishCorrection(scoped, finishInput()),
			/outside accepted correction-plan file scopes: outside\.txt/,
		);
		await assertUnstaged(scoped);
	} finally {
		rmSync(emptyRoot, { recursive: true, force: true });
		rmSync(scopeRoot, { recursive: true, force: true });
	}
});

test("finish rejects HEAD movement before and during authoritative verification", async () => {
	const beforeRoot = mkdtempSync(join(tmpdir(), "juruc-correction-head-before-"));
	const duringRoot = mkdtempSync(join(tmpdir(), "juruc-correction-head-during-"));
	try {
		const before = await correctionTask(beforeRoot);
		writeFileSync(join(before.repository.worktree, "src", "core.ts"), "export const core = 3;\n");
		run(before.repository.worktree, "add", "-A");
		run(before.repository.worktree, "commit", "-m", "unauthorized");
		await assert.rejects(
			finishCorrection(before, finishInput()),
			/correction session changed Git HEAD/,
		);

		const during = await correctionTask(duringRoot);
		writeFileSync(join(during.repository.worktree, "src", "core.ts"), "export const core = 4;\n");
		let moved = false;
		const operations: VerificationOperations = {
			exec() {
				if (!moved) {
					moved = true;
					run(during.repository.worktree, "add", "-A");
					run(during.repository.worktree, "commit", "-m", "verification moved head");
				}
				return Promise.resolve({ exitCode: 0 });
			},
		};
		await assert.rejects(
			finishCorrection(during, finishInput(), operations),
			/verification command changed Git HEAD/,
		);
	} finally {
		rmSync(beforeRoot, { recursive: true, force: true });
		rmSync(duringRoot, { recursive: true, force: true });
	}
});
