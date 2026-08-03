import assert from "node:assert/strict";
import test from "node:test";
import { taskOptions } from "./picker.ts";

test("non-TUI task options remain concise", () => {
	const options = taskOptions([
		{
			slug: "small-task",
			title: "Small task",
			request: "Simplify it.",
			stage: "plan",
			context: "plan",
			modified: new Date(0),
			valid: true,
		},
	]);
	assert.deepEqual(options, [
		{ label: "New task…", choice: { action: "new" } },
		{
			label: "Small task — small-task · plan",
			choice: { action: "select", slug: "small-task" },
		},
	]);
});
