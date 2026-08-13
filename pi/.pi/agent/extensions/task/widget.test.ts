import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPhase, createTask, readTask, setPhaseStatus, type TaskHeader } from "./tasks.ts";
import { taskRail } from "./widget.ts";

const HEADER: TaskHeader = { repository: "/repo", base: "main", description: "make the rail joint" };

function withTask(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-task-widget-test-"));
	try {
		createTask(root, "joint-rail", HEADER);
		const notes = join(root, "joint-rail", "notes");
		mkdirSync(notes, { recursive: true });
		writeFileSync(join(notes, "questions.md"), "questions\n");
		writeFileSync(join(notes, "research.md"), "research\n");
		writeFileSync(join(notes, "plan.md"), "plan\n");
		createPhase(readTask(root, "joint-rail"), "broker", "broker", "body");
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function states(root: string, entered: Parameters<typeof taskRail>[1]): string[] {
	return taskRail(readTask(root, "joint-rail"), entered)
		.map(({ name, state }) => `${name}:${state}`);
}

test("a reopened completed stage owns the arrow without hiding later artifacts", () => {
	withTask((root) => {
		assert.deepEqual(states(root, "design"), [
			"questions:complete",
			"research:complete",
			"design:current",
			"phases:complete",
			"implement:incomplete",
		]);
	});
});

test("starting implementation does not move the arrow from the open planning session", () => {
	withTask((root) => {
		assert.deepEqual(states(root, "phases"), [
			"questions:complete",
			"research:complete",
			"design:complete",
			"phases:current",
			"implement:incomplete",
		]);
	});
});

test("finishing the final phase leaves the arrow on the open session", () => {
	withTask((root) => {
		setPhaseStatus(readTask(root, "joint-rail"), "01-broker", "done");
		assert.deepEqual(states(root, "phases"), [
			"questions:complete",
			"research:complete",
			"design:complete",
			"phases:current",
			"implement:complete",
		]);
	});
});

test("an implementation workspace keeps its arrow after every phase is done", () => {
	withTask((root) => {
		setPhaseStatus(readTask(root, "joint-rail"), "01-broker", "done");
		assert.deepEqual(states(root, undefined), [
			"questions:complete",
			"research:complete",
			"design:complete",
			"phases:complete",
			"implement:current",
		]);
	});
});
