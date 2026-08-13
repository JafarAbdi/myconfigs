import assert from "node:assert/strict";
import test from "node:test";
import {
	activeToolsForTaskStage,
	PHASE_TOOL,
	SUBMIT_STAGE_TOOL,
} from "./task-tools.ts";

const ACTIVE = ["read", PHASE_TOOL, "delegate", SUBMIT_STAGE_TOOL];

test("task tools are hidden without a matching planning-stage marker", () => {
	assert.deepEqual(activeToolsForTaskStage(ACTIVE), ["read", "delegate"]);
	assert.deepEqual(activeToolsForTaskStage(ACTIVE, "implement"), ["read", "delegate"]);
});

test("artifact stages expose submit_stage and preserve unrelated tools", () => {
	for (const stage of ["questions", "research", "design"] as const) {
		assert.deepEqual(activeToolsForTaskStage(ACTIVE, stage), ["read", "delegate", SUBMIT_STAGE_TOOL]);
	}
});

test("the phases stage exposes phase for planning and post-worktree redo", () => {
	assert.deepEqual(activeToolsForTaskStage(ACTIVE, "phases"), ["read", "delegate", PHASE_TOOL]);
});
