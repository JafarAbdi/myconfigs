import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	amendPendingPhase,
	completePhase,
	createPlanEnvelope,
	firstPendingPhase,
	promoteCandidate,
	setCandidate,
} from "./plan.ts";
import {
	canonicalPrompt,
	candidateFromInput,
	expandPromptArguments,
	parseCommandArgs,
	planningContextMetadata,
	PLANNING_INSTRUCTION,
	RESEARCH_INSTRUCTION,
	SET_PLAN_SCHEMA,
	type SetPlanInput,
} from "./planning.ts";

assert.deepEqual(parseCommandArgs(`alpha "two words" 'three words'`), [
	"alpha",
	"two words",
	"three words",
]);
assert.equal(
	expandPromptArguments(
		"$1|$2|$@|$ARGUMENTS|${3:-fallback}|${@:2}|${@:2:1}",
		`alpha "two words"`,
	),
	"alpha|two words|alpha two words|alpha two words|fallback|two words|two words",
);
assert.equal(
	expandPromptArguments("${ARGUMENTS:-$1 stays literal}", ""),
	"$1 stays literal",
	"defaults are not recursively expanded",
);
assert.equal(
	expandPromptArguments("$1", `'literal $@ and $2'`),
	"literal $@ and $2",
	"argument values are not recursively expanded",
);

const root = mkdtempSync(join(tmpdir(), "juruc-planning-test-"));
try {
	const grill = join(root, "grill.md");
	writeFileSync(
		grill,
		"---\r\ndescription: Canonical\r\n---\r\n\r\nGrill `${ARGUMENTS:-the current subject}`.\r\n",
	);
	const command = {
		name: "grill",
		source: "prompt",
		sourceInfo: { path: grill },
	};
	assert.equal(
		canonicalPrompt([command], "grill", `"quoted subject"`),
		"Grill `quoted subject`.",
	);
	assert.equal(
		canonicalPrompt([command], "grill", ""),
		"Grill `the current subject`.",
	);
	assert.throws(
		() => canonicalPrompt([], "grill", "subject"),
		/unavailable or ambiguous/,
	);
	assert.throws(
		() => canonicalPrompt([command, command], "grill", "subject"),
		/unavailable or ambiguous/,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

assert.equal(SET_PLAN_SCHEMA.additionalProperties, false);
assert.deepEqual(SET_PLAN_SCHEMA.required, [
	"objective",
	"desiredEndState",
	"constraints",
	"assumptions",
	"nonGoals",
	"decisions",
	"risks",
	"successCriteria",
	"futurePhases",
]);
assert.deepEqual(SET_PLAN_SCHEMA.properties.futurePhases.items.required, [
	"title",
	"objective",
	"successCriteria",
]);
assert.equal(SET_PLAN_SCHEMA.properties.futurePhases.minItems, 1);
assert.equal(SET_PLAN_SCHEMA.properties.futurePhases.items.additionalProperties, false);
assert.equal(
	Object.hasOwn(SET_PLAN_SCHEMA.properties.futurePhases.items.properties, "amendments"),
	false,
	"model-facing phases do not expose storage amendments",
);
for (const hidden of [
	"expectedRevision",
	"worktreeSnapshot",
	"activeWorkDisposition",
])
	assert.equal(Object.hasOwn(SET_PLAN_SCHEMA.properties, hidden), false);

for (const required of [
	"Read task research.md first as non-authoritative evidence",
	"plan.json remains authoritative",
	"Do not invent missing facts",
])
	assert.match(PLANNING_INSTRUCTION, new RegExp(required));
for (const required of [
	"orientation to independent evidence to factual synthesis",
	"one fresh scout",
	"mutually blind evidence scouts",
	"one fresh synthesizer",
	"visible unresolved gaps",
	"Do not supply evidence inline or invent missing evidence",
])
	assert.match(RESEARCH_INSTRUCTION, new RegExp(required));
for (const forbiddenLimit of ["one to four", "six total", "at most four"])
	assert.doesNotMatch(
		RESEARCH_INSTRUCTION,
		new RegExp(forbiddenLimit),
		"research instructions must not impose an arbitrary evidence count",
	);
assert.match(RESEARCH_INSTRUCTION, /Hide the desired outcome and all request-bearing/u);
assert.match(PLANNING_INSTRUCTION, /Classify confirmed material as task-specific or durable project context/u);
assert.match(PLANNING_INSTRUCTION, /single final confirmation/u);
for (const required of [
	"decisions with rationale and alternatives",
	"assumptions",
	"accepted risks with consequence and mitigation",
	"deferred non-goals",
	"every blocker with its disposition",
	"resolved, assumed, accepted as risk, deferred, or blocking",
	"Keep blockers out of the persisted plan",
]) assert.match(PLANNING_INSTRUCTION, new RegExp(required));
assert.match(PLANNING_INSTRUCTION, /earliest affected phase's exact success criteria/u);
assert.match(PLANNING_INSTRUCTION, /Git-root AGENTS\.md for project-wide rules/u);
assert.match(PLANNING_INSTRUCTION, /Only after human confirmation, call juruc_set_plan/u);
assert.match(PLANNING_INSTRUCTION, /minimal, incrementally complete, independently verifiable/u);
assert.match(PLANNING_INSTRUCTION, /New AGENTS\.md files use JURUC's # Project Contract format/u);
assert.match(PLANNING_INSTRUCTION, /Durable project context: None/u);

assert.equal(
	planningContextMetadata({ cwd: "/work/project", contextFiles: [] }),
	[
		"JURUC planning context supplied by Pi:",
		"Working directory: /work/project",
		"Applicable context files: None. Pi discovered no AGENTS.md or CLAUDE.md files.",
		"These are the only applicable context-file paths.",
	].join("\n"),
);
assert.equal(
	planningContextMetadata({
		cwd: "/work/one",
		contextFiles: [{ path: "/work/one/AGENTS.md", content: "secret rule" }],
	}),
	[
		"JURUC planning context supplied by Pi:",
		"Working directory: /work/one",
		"Applicable context files (contents already loaded by Pi):\n- /work/one/AGENTS.md",
		"These are the only applicable context-file paths.",
	].join("\n"),
	"metadata names Pi's exact path without duplicating loaded contents",
);
assert.equal(
	planningContextMetadata({
		cwd: "/work/many",
		contextFiles: [
			{ path: "/work/AGENTS.md", content: "root" },
			{ path: "/work/many/CLAUDE.md", content: "local" },
		],
	}),
	[
		"JURUC planning context supplied by Pi:",
		"Working directory: /work/many",
		"Applicable context files (contents already loaded by Pi):\n- /work/AGENTS.md\n- /work/many/CLAUDE.md",
		"These are the only applicable context-file paths.",
	].join("\n"),
);

const snapshot = {
	head: "a".repeat(40),
	paths: ["src/planning.ts"],
	tree: "1".repeat(64),
};
const base = {
	objective: "Implement planning.",
	desiredEndState: "Planning is persistent.",
	constraints: ["Keep /grill unchanged."],
	assumptions: [],
	nonGoals: [],
	decisions: [{ decision: "Reuse the plan store.", rationale: "It is authoritative.", alternatives: ["Add another store."] }],
	risks: [{ risk: "The store may be unavailable.", consequence: "Planning cannot persist.", mitigation: "Fail closed." }],
	successCriteria: ["Candidates are durable."],
};
const initialInput: SetPlanInput = {
	...base,
	futurePhases: [{
		title: "First",
		objective: "Create the first phase.",
		successCriteria: ["The first phase works."],
	}],
};
const emptyPlan = createPlanEnvelope("Planning", "Compose planning.");
const initial = candidateFromInput(initialInput, emptyPlan, { ...snapshot, paths: [] }, null);
assert.equal(initial.expectedRevision, 0);
assert.deepEqual(initial.decisions, base.decisions);
assert.deepEqual(initial.risks, base.risks);
assert.equal(initial.future[0].id, undefined);
assert.deepEqual(initial.future[0].hints, []);
assert.deepEqual(initial.future[0].amendments, []);
const approvedPlan = setCandidate(emptyPlan, initial);
const approved = promoteCandidate(approvedPlan, { ...snapshot, paths: [] });
const expanded = promoteCandidate(
	setCandidate(
		approved,
		candidateFromInput(
			{
				...base,
				futurePhases: [
					initialInput.futurePhases[0],
					{ title: "Second", objective: "Add work.", successCriteria: ["Added."] },
					{ title: "Third", objective: "Add more work.", successCriteria: ["Added more."] },
				],
			},
			approved,
			{ ...snapshot, paths: [] },
			null,
		),
	),
	{ ...snapshot, paths: [] },
);
const futureInput: SetPlanInput = {
	...base,
	futurePhases: [
		{ title: "Third", objective: "Add more work.", successCriteria: ["Added more."] },
		{
			title: "First revised",
			objective: "Revise work.",
			successCriteria: ["Revised."],
		},
		{ title: "Fourth", objective: "Add final work.", successCriteria: ["Final added."] },
	],
};
const compiled = candidateFromInput(futureInput, expanded, snapshot, "carry");
assert.deepEqual(compiled.future.map(({ amendments }) => amendments), [[], [], []]);
assert.deepEqual(compiled.future.map(({ id, title }) => [id, title]), [
	["P3", "Third"],
	[undefined, "First revised"],
	[undefined, "Fourth"],
]);
assert.equal(compiled.activeWorkDisposition, "carry");
assert.deepEqual(
	promoteCandidate(setCandidate(expanded, compiled), snapshot).approved?.future.map(
		({ id, title }) => [id, title],
	),
	[["P3", "Third"], ["P4", "First revised"], ["P5", "Fourth"]],
);
const reordered = candidateFromInput(
	{
		...base,
		futurePhases: [
			{ title: "Third", objective: "Add more work.", successCriteria: ["Added more."] },
			{ title: "Second", objective: "Add work.", successCriteria: ["Added."] },
		],
	},
	expanded,
	{ ...snapshot, paths: [] },
	null,
);
assert.deepEqual(reordered.future.map(({ id }) => id), ["P3", "P2"]);

const amendedExpanded = amendPendingPhase(
	expanded,
	"P3",
	"Keep the third phase behind the second phase's dependency.",
);
const reconciledAmendment = candidateFromInput(
	{
		...base,
		futurePhases: [
			{ title: "Third", objective: "Add more work.", successCriteria: ["Added more."] },
		],
	},
	amendedExpanded,
	{ ...snapshot, paths: [] },
	null,
);
assert.equal(reconciledAmendment.future[0].id, "P3");
assert.deepEqual(reconciledAmendment.future[0].amendments, [
	"Keep the third phase behind the second phase's dependency.",
]);
const changedAmended = candidateFromInput(
	{
		...base,
		futurePhases: [
			{ title: "Third changed", objective: "Add more work.", successCriteria: ["Added more."] },
		],
	},
	amendedExpanded,
	{ ...snapshot, paths: [] },
	null,
);
assert.equal(changedAmended.future[0].id, undefined);
assert.deepEqual(changedAmended.future[0].amendments, []);

const withCompleted = completePhase(
	expanded,
	firstPendingPhase(expanded)!,
	"Completed first phase.",
	null,
);
const completedSnapshot = candidateFromInput(
	{ ...base, futurePhases: [initialInput.futurePhases[0]] },
	withCompleted,
	snapshot,
	"carry",
);
assert.equal(completedSnapshot.future[0].id, undefined);
assert.throws(
	() => candidateFromInput(futureInput, expanded, snapshot, null),
	/dirty work requires/,
);
assert.throws(
	() => candidateFromInput(futureInput, expanded, { ...snapshot, paths: [] }, "carry"),
	/clean work requires/,
);
assert.throws(
	() =>
		candidateFromInput(
			{ ...futureInput, futurePhases: [] },
			expanded,
			snapshot,
			"carry",
		),
	/a plan candidate requires at least one future phase/,
);

console.log("juruc planning composition: ok");
