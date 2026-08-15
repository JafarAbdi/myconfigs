import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTask, finishPhase, readTask } from "./tasks.ts";
import { taskStatus } from "./widget.ts";

test("status follows checklist progress", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-task-widget-test-"));
	const root = join(base, "tasks");
	const plan = join(base, "plan.md");
	const repository = join(base, "repo");
	try {
		mkdirSync(repository);
		writeFileSync(plan, "plan");
		const task = createTask(root, "joint-rail", plan, repository, [
			{ name: "first", title: "First", body: "First phase." },
			{ name: "second", title: "Second", body: "Second phase." },
		]);
		assert.deepEqual(taskStatus(task), {
			text: "joint-rail · phase 1/2 · 01-first",
			tone: "active",
		});

		finishPhase(task, "01-first");
		assert.equal(taskStatus(readTask(root, task.slug)).text, "joint-rail · phase 2/2 · 02-second");
		finishPhase(task, "02-second");
		assert.deepEqual(taskStatus(readTask(root, task.slug)), {
			text: "joint-rail · complete · 2/2 phases",
			tone: "complete",
		});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
