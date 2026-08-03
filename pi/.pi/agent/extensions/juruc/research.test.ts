import assert from "node:assert/strict";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadResearchBrief,
	RESEARCH_INSTRUCTION,
	RESEARCH_TOOL_NAMES,
	researchKickoff,
	saveResearchBrief,
	successfulResearchSynthesis,
} from "./research.ts";
import type { TaskQuestions } from "./task.ts";

const questions: TaskQuestions = {
	sharedUnderstanding: "Research the confirmed target.",
	decisions: ["Keep it local."],
	acceptedAssumptions: [],
	researchTargets: [],
};

function synthesis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		agent: "synthesizer",
		output: "exact factual synthesis\n",
		stopReason: "stop",
		steps: [],
		...overrides,
	};
}

test("Research always runs with only the confirmed discovery diet", () => {
	assert.deepEqual(RESEARCH_TOOL_NAMES, ["delegate"]);
	assert.match(RESEARCH_INSTRUCTION, /always runs/i);
	const prompt = researchKickoff("request", questions, "/source");
	assert.match(prompt, /Original request:\nrequest/);
	assert.match(prompt, /Confirmed Questions result/);
	assert.match(prompt, /None declared; still inspect/);
	assert.match(prompt, /Source repository: \/source/);
});

test("only a successful tool-free synthesizer result becomes exact research", () => {
	assert.equal(successfulResearchSynthesis(synthesis()), "exact factual synthesis\n");
	assert.equal(successfulResearchSynthesis(synthesis({ agent: "scout" })), undefined);
	assert.equal(successfulResearchSynthesis(synthesis({ steps: [{ tool: "read" }] })), undefined);
	assert.equal(successfulResearchSynthesis(synthesis({ output: " " })), undefined);
});

test("research.md is atomically persisted and current file contents are authoritative", () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "juruc-research-")));
	try {
		assert.throws(() => loadResearchBrief(directory), /research\.md is missing/);
		const exact = "facts with unicode π\n";
		assert.equal(saveResearchBrief(directory, exact), undefined);
		assert.equal(readFileSync(join(directory, "research.md"), "utf8"), exact);
		assert.equal(lstatSync(join(directory, "research.md")).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(directory), ["research.md"]);
		writeFileSync(join(directory, "research.md"), "operator revision\n");
		assert.equal(loadResearchBrief(directory), "operator revision\n");
		rmSync(join(directory, "research.md"));
		mkdirSync(join(directory, "research.md"));
		assert.throws(() => loadResearchBrief(directory), /research\.md is not a regular file/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
