import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimePathsForRoot } from "./runtime.ts";
import { appendTaskSession, confirmTaskQuestions } from "./task.ts";
import { ensureTaskWorktree } from "./workspace.ts";
import {
	createTask,
	findTaskBySession,
	listTasks,
	loadTask,
	removeInvalidTaskRecord,
	removeTaskRecord,
	saveTask,
	scanTasks,
	slugify,
	uniqueSlug,
	validTaskSlug,
} from "./tasks.ts";

function paths() {
	const root = mkdtempSync(join(tmpdir(), "juruc-tasks-"));
	mkdirSync(join(root, "tasks"));
	mkdirSync(join(root, "worktrees"));
	return { root, paths: runtimePathsForRoot(root) };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function input(root: string, slug = "small-task") {
	return {
		slug,
		title: "Small task",
		request: "Keep the task store small.",
		repository: {
			sourceRoot: join(root, "source"),
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: slug,
			worktree: join(root, "worktrees", slug),
		},
	};
}

test("task names are simple valid branch-compatible slugs", () => {
	assert.equal(slugify("  Make JURUC Smaller, Please!  "), "make-juruc-smaller-please");
	assert.equal(validTaskSlug("small-task.2"), true);
	assert.equal(validTaskSlug("../escape"), false);
});

test("create, save, load, and list use version 6 task.json", () => {
	const fixture = paths();
	try {
		let task = createTask(fixture.paths, input(fixture.root));
		assert.equal(loadTask(fixture.paths, "small-task").document.stage, "questions");
		task = saveTask(task, confirmTaskQuestions(task.document, {
			sharedUnderstanding: "Confirmed.",
			decisions: [],
			acceptedAssumptions: [],
			researchTargets: [],
		}));
		assert.equal(loadTask(fixture.paths, "small-task").document.stage, "research");
		assert.deepEqual(
			listTasks(fixture.paths).map(({ slug, stage, valid }) => ({ slug, stage, valid })),
			[{ slug: "small-task", stage: "research", valid: true }],
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("session ownership resolves scoped runs", () => {
	const fixture = paths();
	try {
		let task = createTask(fixture.paths, input(fixture.root));
		task = saveTask(task, appendTaskSession(task.document, {
			kind: "questions",
			path: "/sessions/questions.jsonl",
		}));
		assert.equal(
			findTaskBySession(fixture.paths, "/sessions/questions.jsonl")?.document.slug,
			"small-task",
		);
		assert.equal(findTaskBySession(fixture.paths, "/sessions/missing.jsonl"), undefined);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("uniqueSlug advances persisted collisions and removal is exact", () => {
	const fixture = paths();
	try {
		const task = createTask(fixture.paths, input(fixture.root, "task"));
		assert.equal(uniqueSlug(fixture.paths.tasks, "task"), "task-2");
		writeFileSync(join(task.directory, "research.md"), "facts\n");
		removeTaskRecord(task);
		assert.equal(existsSync(task.directory), false);
		assert.equal(existsSync(fixture.paths.tasks), true);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("tampered repository ownership cannot load, save, remove, or activate", async () => {
	const fixture = paths();
	try {
		const sourceRoot = join(fixture.root, "source");
		mkdirSync(sourceRoot);
		git(sourceRoot, "init", "-b", "main");
		git(sourceRoot, "config", "user.name", "JURUC Test");
		git(sourceRoot, "config", "user.email", "juruc@example.invalid");
		writeFileSync(join(sourceRoot, "tracked.txt"), "baseline\n");
		git(sourceRoot, "add", "-A");
		git(sourceRoot, "commit", "-m", "baseline");
		const head = git(sourceRoot, "rev-parse", "HEAD");
		const ownedInput = (slug: string) => ({
			...input(fixture.root, slug),
			repository: {
				...input(fixture.root, slug).repository,
				sourceRoot,
				sourceHead: head,
			},
		});
		const task = createTask(fixture.paths, ownedInput("task"));
		const other = createTask(fixture.paths, ownedInput("other"));
		await ensureTaskWorktree(task.document.repository);
		await ensureTaskWorktree(other.document.repository);
		const redirectedWorktree = {
			...task.document,
			repository: {
				...task.document.repository,
				worktree: other.document.repository.worktree,
			},
		};
		assert.throws(() => saveTask(task, redirectedWorktree), /outside the managed task path/);
		assert.throws(
			() => removeTaskRecord({ directory: task.directory, document: redirectedWorktree }),
			/outside the managed task path/,
		);
		assert.equal(existsSync(task.directory), true);

		writeFileSync(join(task.directory, "task.json"), JSON.stringify(redirectedWorktree));
		assert.throws(() => loadTask(fixture.paths, "task"), /outside the managed task path/);
		await assert.rejects(
			ensureTaskWorktree(redirectedWorktree.repository),
			/already checked out|registration differs|branch differs/,
		);
		assert.equal(scanTasks(fixture.paths).find(({ summary }) => summary.slug === "task")?.task, undefined);

		const redirectedBranch = {
			...redirectedWorktree,
			repository: {
				...redirectedWorktree.repository,
				branch: other.document.repository.branch,
			},
		};
		writeFileSync(join(task.directory, "task.json"), JSON.stringify(redirectedBranch));
		assert.throws(() => loadTask(fixture.paths, "task"), /task\.json is invalid/);
		assert.equal(existsSync(other.directory), true);
		assert.equal(existsSync(other.document.repository.worktree), true);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("old and sidecar-only task directories are invalid without migration", () => {
	const fixture = paths();
	try {
		const directory = join(fixture.paths.tasks, "legacy-task");
		mkdirSync(directory);
		writeFileSync(join(directory, "task.json"), JSON.stringify({ version: 3 }));
		const [entry] = scanTasks(fixture.paths);
		assert.equal(entry.task, undefined);
		assert.equal(entry.summary.stage, "invalid");
		assert.match(entry.summary.error ?? "", /task\.json is invalid/);
		removeInvalidTaskRecord(fixture.paths, "legacy-task");
		assert.equal(existsSync(directory), false);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
