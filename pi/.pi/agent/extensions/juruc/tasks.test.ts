import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimePathsForRoot } from "./runtime.ts";
import { appendTaskSession, confirmTaskQuestions } from "./task.ts";
import {
	createTask,
	findTaskBySession,
	listTasks,
	loadTask,
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

test("create, save, load, and list use version 3 task.json", () => {
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
			kind: "implementation",
			phase: 3,
			path: "/sessions/implementation-3.jsonl",
		}));
		assert.equal(
			findTaskBySession(fixture.paths, "/sessions/implementation-3.jsonl")?.document.slug,
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

test("old and sidecar-only task directories are invalid without migration", () => {
	const fixture = paths();
	try {
		const directory = join(fixture.paths.tasks, "legacy-task");
		mkdirSync(directory);
		writeFileSync(join(directory, "task.json"), JSON.stringify({ version: 2 }));
		const [entry] = scanTasks(fixture.paths);
		assert.equal(entry.task, undefined);
		assert.equal(entry.summary.stage, "invalid");
		assert.match(entry.summary.error ?? "", /task\.json is invalid/);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
