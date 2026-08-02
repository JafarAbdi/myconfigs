import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	confirmTaskPlan,
	planningPrompt,
	planningSessionInstruction,
	PLANNING_INSTRUCTION,
	SET_PLAN_SCHEMA,
	type SetPlanInput,
} from "./planning.ts";
import {
	RESEARCH_INSTRUCTION,
	RESEARCH_TOOL_NAMES,
	researchKickoff,
	saveResearchBrief,
	successfulResearchSynthesis,
} from "./research.ts";
import {
	appendTaskSession,
	createTaskDocument,
	findTaskSession,
	finishTaskResearch,
	type NewTaskInput,
} from "./task.ts";

const oid = "1".repeat(40);

function taskInput(): NewTaskInput {
	return {
		slug: "coordinated-task",
		title: "Coordinated task",
		request: "Research and plan the task.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: oid,
			branch: "coordinated-task",
			worktree: "/worktrees/coordinated-task",
		},
	};
}

function synthesis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		agent: "synthesizer",
		task: "synthesize",
		output: "  factual synthesis\n",
		stopReason: "stop",
		steps: [],
		turns: 1,
		durationMs: 10,
		...overrides,
	};
}

function planInput(): SetPlanInput {
	return {
		objective: " Build the confirmed result. ",
		constraints: [" Keep worktree isolation. "],
		assumptions: [" One operator owns the task. "],
		nonGoals: [],
		successCriteria: [" The workflow passes end to end. "],
		futurePhases: [
			{
				title: " Implement the phase ",
				objective: " Implement only confirmed work. ",
				successCriteria: [" Focused tests pass. "],
				verification: [" node --test focused.test.ts "],
			},
		],
	};
}

test("research gives the coordinator a proportional goal rather than an orchestration recipe", () => {
	for (const phrase of [
		"Decide the useful evidence, agents, and depth",
		"Keep the effort proportional",
		"researchers only when external or current facts matter",
		"research.md verbatim",
	])
		assert.match(RESEARCH_INSTRUCTION, new RegExp(phrase));
	assert.equal(researchKickoff("exact subject"), "exact subject");
	assert.deepEqual(RESEARCH_TOOL_NAMES, ["delegate"]);
	assert.doesNotMatch(
		RESEARCH_INSTRUCTION,
		/one fresh scout|mutually blind|group those questions|researchProgress|orientation state|evidence state/i,
	);
});

test("only a successful tool-free synthesizer result becomes verbatim research", () => {
	const exact = "  factual synthesis\n";
	assert.equal(successfulResearchSynthesis(synthesis()), exact);
	assert.equal(
		successfulResearchSynthesis(synthesis({ agent: "scout" })),
		undefined,
	);
	assert.equal(
		successfulResearchSynthesis(
			synthesis({ steps: [{ tool: "read", outcome: "ok" }] }),
		),
		undefined,
	);
	assert.equal(
		successfulResearchSynthesis(synthesis({ stopReason: "error" })),
		undefined,
	);
});

test("successful synthesis is persisted without retransmission or normalization", () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-coordination-research-"));
	try {
		const output = successfulResearchSynthesis(synthesis());
		assert.ok(output);
		saveResearchBrief(directory, output);
		assert.equal(readFileSync(join(directory, "research.md"), "utf8"), output);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("research and plan runs cannot reuse the same managed session", () => {
	let task = appendTaskSession(createTaskDocument(taskInput()), {
		kind: "research",
		path: "/sessions/research.jsonl",
	});
	task = finishTaskResearch(task);
	assert.throws(
		() =>
			appendTaskSession(task, {
				kind: "plan",
				path: "/sessions/research.jsonl",
			}),
		/path is already recorded/,
	);
	task = appendTaskSession(task, {
		kind: "plan",
		path: "/sessions/planning.jsonl",
	});
	assert.equal(
		findTaskSession(task, { kind: "plan" })?.path,
		"/sessions/planning.jsonl",
	);
});

test("confirmed planning directly activates the compact remaining plan", () => {
	const planning = finishTaskResearch(createTaskDocument(taskInput()));
	const building = confirmTaskPlan(planning, planInput());
	assert.equal(building.stage, "building");
	assert.equal(building.plan?.objective, "Build the confirmed result.");
	assert.equal(building.plan?.remaining[0].title, "Implement the phase");
	assert.deepEqual(building.plan?.remaining[0].verification, [
		"node --test focused.test.ts",
	]);
	assert.deepEqual(building.plan?.completed, []);
	assert.equal(building.blockReason, null);
});

test("the planning tool schema exposes no candidate or transaction fields", () => {
	assert.deepEqual(SET_PLAN_SCHEMA.required, [
		"objective",
		"constraints",
		"assumptions",
		"nonGoals",
		"successCriteria",
		"futurePhases",
	]);
	for (const removed of [
		"candidate",
		"expectedRevision",
		"worktreeSnapshot",
		"activeWorkDisposition",
		"decisions",
		"risks",
	])
		assert.equal(Object.hasOwn(SET_PLAN_SCHEMA.properties, removed), false);
	assert.equal(SET_PLAN_SCHEMA.properties.futurePhases.minItems, 1);
	assert.deepEqual(SET_PLAN_SCHEMA.properties.futurePhases.items.required, [
		"title",
		"objective",
		"successCriteria",
		"verification",
	]);
	assert.equal(
		SET_PLAN_SCHEMA.properties.futurePhases.items.properties.verification.minItems,
		1,
	);
});

test("planning remains read-only and resolves canonical grill from its own session", () => {
	for (const phrase of [
		"research.md first as non-authoritative evidence",
		"task.json is authoritative",
		"Do not modify the worktree",
		"Only after human confirmation",
		"runnable verification commands",
	])
		assert.match(PLANNING_INSTRUCTION, new RegExp(phrase));
	const directory = mkdtempSync(join(tmpdir(), "juruc-coordination-planning-"));
	try {
		const grill = join(directory, "grill.md");
		writeFileSync(
			grill,
			"---\ndescription: canonical\n---\n\nGrill ${ARGUMENTS:-the task}.",
		);
		assert.equal(
			planningPrompt(
				[{ name: "grill", source: "prompt", sourceInfo: { path: grill } }],
				"confirmed subject",
			),
			"Grill confirmed subject.",
		);
		const instruction = planningSessionInstruction(directory);
		assert.match(instruction, new RegExp(join(directory, "task.json")));
		assert.match(instruction, new RegExp(join(directory, "research.md")));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
