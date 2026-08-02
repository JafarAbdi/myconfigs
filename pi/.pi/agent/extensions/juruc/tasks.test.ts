import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimePathsForRoot } from "./runtime.ts";
import {
	createTask,
	listTasks,
	loadTask,
	removeTaskRecord,
	saveTask,
	scanTasks,
	slugify,
	uniqueSlug,
	validTaskSlug,
} from "./tasks.ts";
import { finishTaskResearch } from "./task.ts";

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

test("create, save, load, and list use only task.json", () => {
	const fixture = paths();
	try {
		let task = createTask(fixture.paths, input(fixture.root));
		assert.equal(loadTask(fixture.paths, "small-task").document.stage, "research");
		task = saveTask(task, finishTaskResearch(task.document));
		assert.equal(loadTask(fixture.paths, "small-task").document.stage, "planning");
		assert.deepEqual(listTasks(fixture.paths).map(({ slug, stage, valid }) => ({ slug, stage, valid })), [
			{ slug: "small-task", stage: "planning", valid: true },
		]);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("uniqueSlug advances only persisted task-directory collisions", () => {
	const fixture = paths();
	try {
		createTask(fixture.paths, input(fixture.root, "task"));
		assert.equal(uniqueSlug(fixture.paths.tasks, "task"), "task-2");
		createTask(fixture.paths, input(fixture.root, "task-2"));
		assert.equal(uniqueSlug(fixture.paths.tasks, "task"), "task-3");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("removeTaskRecord deletes only the exact persisted task directory", () => {
	const fixture = paths();
	try {
		const task = createTask(fixture.paths, input(fixture.root));
		writeFileSync(join(task.directory, "research.md"), "facts\n");
		removeTaskRecord(task);
		assert.equal(existsSync(task.directory), false);
		assert.equal(existsSync(fixture.paths.tasks), true);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("old state.json and plan.json directories are reported invalid without migration", () => {
	const fixture = paths();
	try {
		const directory = join(fixture.paths.tasks, "legacy-task");
		mkdirSync(directory);
		writeFileSync(join(directory, "state.json"), "{}\n");
		writeFileSync(join(directory, "plan.json"), "{}\n");
		const [entry] = scanTasks(fixture.paths);
		assert.equal(entry.task, undefined);
		assert.equal(entry.summary.slug, "legacy-task");
		assert.equal(entry.summary.stage, "invalid");
		assert.equal(entry.summary.valid, false);
		assert.match(entry.summary.error ?? "", /task\.json/);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
