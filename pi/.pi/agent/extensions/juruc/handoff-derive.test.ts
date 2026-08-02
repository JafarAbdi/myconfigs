import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveReadinessHandoff } from "./handoff.ts";
import { git } from "./repository.ts";
import type { TaskRecord } from "./tasks.ts";

const root = mkdtempSync(join(tmpdir(), "juruc-derived-handoff-"));
const repo = join(root, "repo");
mkdirSync(repo);
for (const args of [["init", "-b", "main"], ["config", "user.name", "handoff-test"], ["config", "user.email", "handoff@example.invalid"]]) {
	const result = await git(repo, args);
	assert.equal(result.code, 0, result.stderr);
}
writeFileSync(join(repo, "base.txt"), "base\n");
await git(repo, ["add", "base.txt"]);
await git(repo, ["commit", "-m", "base"]);
const sourceHead = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
await git(repo, ["checkout", "-b", "feature"]);
writeFileSync(join(repo, "changed.txt"), "changed\n");
await git(repo, ["add", "changed.txt"]);
await git(repo, ["commit", "-m", "feature"]);
const finalCommit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
const finalTree = (await git(repo, ["rev-parse", "HEAD^{tree}"])).stdout.trim();

const state = {
	phase: "done",
	slug: "handoff",
	sourceRoot: repo,
	baseBranch: "main",
	worktree: repo,
	sourceHead,
	acceptance: {
		task: "handoff",
		phase: { id: "P1", status: "pending", title: "Implement", objective: "Change it", successCriteria: ["done"], hints: [], amendments: [], resolution: null, commit: null },
		phaseSession: { path: "/tmp/session", id: "session" },
		sourceHead,
		currentHead: finalCommit,
		finalParent: sourceHead,
		finalCommit,
		finalTree,
		auditedPlanRevision: 1,
		completedPlanRevision: 2,
		orderedPhaseCommits: [finalCommit],
		acceptedCriteria: [1],
		auditSummary: "Aggregate audit passed with one accepted criterion.",
		baseHead: sourceHead,
	},
};
const task = {
	plan: {
		title: "Derived handoff",
		approved: {
			objective: "Make the change",
			desiredEndState: "The changed file exists",
			constraints: [],
			assumptions: ["The base branch is available"],
			nonGoals: ["No release"],
			decisions: [{ decision: "Reuse Git", rationale: "It is authoritative", alternatives: ["Manifest"] }],
			risks: [{ risk: "Base can move", consequence: "Review may need refresh", mitigation: "Report movement" }],
			successCriteria: ["The changed file exists", "A second criterion is intentionally uncovered"],
			completed: [{ id: "P1", title: "Implement", objective: "Change it", successCriteria: ["done"], hints: [], amendments: ["Keep the change small"], resolution: "Implemented", commit: finalCommit }],
			future: [],
		},
	},
	state,
} as unknown as TaskRecord;

const before = JSON.stringify(task.state);
const current = await deriveReadinessHandoff(task);
assert.deepEqual({ acceptance: current.acceptance, risk: current.risk, base: current.base }, {
	acceptance: "accepted", risk: "accepted-risks", base: "current",
});
assert.match(current.concise, /accepted-risks/);
assert.match(current.text, /\[x\] 1\. The changed file exists/);
assert.match(current.text, /\[x\] 2\. A second criterion/);
assert.match(current.text, /Base can move — consequence: Review may need refresh; mitigation: Report movement/);
assert.match(current.text, /A\tchanged\.txt/);

await git(repo, ["checkout", "main"]);
writeFileSync(join(repo, "base-moved.txt"), "moved\n");
await git(repo, ["add", "base-moved.txt"]);
await git(repo, ["commit", "-m", "move base"]);
await git(repo, ["checkout", "feature"]);
const moved = await deriveReadinessHandoff(task);
assert.equal(moved.base, "moved");
assert.match(moved.text, /Base readiness: moved/);
assert.equal(JSON.stringify(task.state), before, "base movement does not mutate acceptance state");

rmSync(root, { recursive: true, force: true });
console.log("juruc derived readiness handoff: ok");
