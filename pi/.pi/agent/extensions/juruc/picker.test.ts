import assert from "node:assert/strict";
import { availableActions } from "./actions.ts";
import { deletionConfirmationDetail, rpcTaskOptions } from "./picker.ts";
import type { TaskRecord, TaskSummary } from "./tasks.ts";

const task: TaskSummary = {
	slug: "safe-delete",
	title: "Safe delete",
	request: "Delete only explicit resources.",
	phase: "planning",
	modified: new Date(0),
	valid: true,
};
const options = rpcTaskOptions([task]);
assert.deepEqual(
	options.map(({ choice }) => choice),
	[
		{ action: "new" },
		{ action: "select", slug: task.slug },
		{ action: "remove", slug: task.slug },
	],
);
assert.match(options[2].label, /^Delete Safe delete/);
for (const option of options)
	assert.doesNotMatch(option.label, /\bP[45]\b/, "picker text does not expose roadmap phase names");
assert.deepEqual(rpcTaskOptions([]), [
	{ label: "New task…", choice: { action: "new" } },
]);
assert.deepEqual(
	availableActions({ state: { phase: "revising" } } as TaskRecord).map(({ id }) => id),
	["recover-transaction"],
	"candidate revision recovery is mechanical rather than user-facing",
);
assert.deepEqual(
	availableActions({ state: { phase: "amending" } } as TaskRecord).map(({ id }) => id),
	["recover-transaction"],
	"amendment recovery is mechanical rather than another planning decision",
);
assert.deepEqual(
	availableActions({ state: { phase: "done" } } as TaskRecord).map(({ id }) => id),
	["show-completion", "view-handoff", "extend-plan"],
	"accepted tasks expose the derived handoff and retain extension",
);
assert.deepEqual(
	availableActions({ state: { phase: "accepting" } } as TaskRecord).map(({ id }) => id),
	["recover-transaction"],
	"interrupted acceptance remains recoverable",
);
for (const paths of [[], ["changed.ts"]]) {
	assert.deepEqual(
		availableActions({ state: { phase: "building", audit: { snapshot: { paths } } } } as TaskRecord).map(({ id }) => id),
		["recover-transaction"],
		"a durable audit receipt has one deterministic recovery action",
	);
}

for (const status of [" M dirty.txt", "", undefined]) {
	const detail = deletionConfirmationDetail(status);
	assert.match(detail, /Persisted exact JURUC build sessions are removed/);
	assert.match(detail, /planning and all other sessions remain/);
	assert.doesNotMatch(detail, /all sessions remain/);
}
assert.match(deletionConfirmationDetail(" M dirty.txt"), /M dirty\.txt/);

console.log("juruc RPC task choices: ok");
