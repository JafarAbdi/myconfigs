import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	amendPendingPhase,
	candidateClearingMatches,
	candidatePromotionMatches,
	clearCandidate,
	clearStaleCandidate,
	completePhase,
	createPlanEnvelope,
	firstPendingPhase,
	loadPlanEnvelope,
	parsePlanEnvelope,
	planIsDone,
	promoteCandidate,
	promoteDiscardedCandidate,
	safeRelativePath,
	savePlanEnvelope,
	serializePlanEnvelope,
	setCandidate,
	type CandidatePhase,
	type PlanCandidate,
	type WorktreeSnapshot,
	validatePlanEnvelope,
} from "./plan.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);
const clean: WorktreeSnapshot = { head: SHA_A, paths: [], tree: DIGEST_A };
const dirty: WorktreeSnapshot = {
	head: SHA_A,
	paths: ["src/a.ts", "src/b.ts"],
	tree: DIGEST_B,
};
const content = {
	objective: "Implement the approved workflow.",
	desiredEndState: "The workflow advances without inferred state.",
	constraints: [],
	assumptions: [],
	nonGoals: [],
	decisions: [],
	risks: [],
	successCriteria: ["All exact schemas reject malformed data."],
};
const phase = (
	title: string,
	id?: string,
	amendments: string[] = [],
): CandidatePhase => ({
	...(id === undefined ? {} : { id }),
	title,
	objective: `Implement ${title.toLowerCase()}.`,
	successCriteria: [`${title} is verified.`],
	hints: [],
	amendments,
});
const candidate = (
	expectedRevision: number,
	future: CandidatePhase[],
	worktreeSnapshot = clean,
	activeWorkDisposition: PlanCandidate["activeWorkDisposition"] = null,
): PlanCandidate => ({
	expectedRevision,
	...content,
	future,
	worktreeSnapshot,
	activeWorkDisposition,
});

const empty = createPlanEnvelope(
	"Reliable execution",
	"Implement reliable unattended execution.",
);
assert.deepEqual(validatePlanEnvelope(empty), []);
assert.equal(empty.version, 4);
assert.deepEqual(empty.history, []);
assert.equal(empty.request, "Implement reliable unattended execution.");
assert.equal(empty.approved, null);
assert.equal(empty.candidate, null);
assert.equal(empty.nextPhaseId, 1);
const multiline = createPlanEnvelope(
	"Multiline request",
	"Implement the first requirement.\n\nThen implement the second.",
);
assert.deepEqual(validatePlanEnvelope(multiline), []);
assert.deepEqual(
	validatePlanEnvelope({
		...multiline,
		candidate: {
			...candidate(0, [phase("Multiline content")]),
			objective: "Implement the first part.\nImplement the second part.",
			successCriteria: ["The first part passes.\nThe second part passes."],
		},
	}),
	[],
	"request and plan prose may span lines",
);
assert.throws(
	() =>
		createPlanEnvelope(
			"Unsafe request",
			"Reject this control character: \u0007",
		),
	/invalid plan envelope/,
);

for (const malformed of [
	{ ...content, decisions: [{ decision: "d", rationale: "r", alternatives: [], extra: true }] },
	{ ...content, risks: [{ risk: "r", consequence: "c", mitigation: "m" }, { mitigation: "m", consequence: "c", risk: "r" }] },
	{ ...content, risks: [{ risk: "r", consequence: "", mitigation: "m" }] },
]) {
	assert.throws(
		() => setCandidate(empty, { ...candidate(0, [phase("Malformed")]), ...malformed } as PlanCandidate),
		/exact candidate schema/,
	);
}

const semanticCandidate: PlanCandidate = {
	...candidate(0, [phase("Semantic")]),
	decisions: [{ decision: "Reuse", rationale: "Existing authority.", alternatives: ["Duplicate store"] }],
	risks: [{ risk: "Failure", consequence: "No progress.", mitigation: "Retry." }],
};
const semanticApproved = promoteCandidate(setCandidate(empty, semanticCandidate), clean);
const reorderedSemanticApproved = structuredClone(semanticApproved);
reorderedSemanticApproved.approved!.decisions = [{ alternatives: ["Duplicate store"], rationale: "Existing authority.", decision: "Reuse" }];
reorderedSemanticApproved.approved!.risks = [{ mitigation: "Retry.", consequence: "No progress.", risk: "Failure" }];
assert.equal(candidatePromotionMatches(reorderedSemanticApproved, semanticCandidate), true, "semantic equality ignores object key order");

const awaiting = setCandidate(empty, candidate(0, [phase("First"), phase("Second")]));
assert.equal(awaiting.revision, 0, "candidate persistence does not revise approved work");
assert.equal(awaiting.nextPhaseId, 1, "candidate phases receive IDs only on promotion");
assert.equal(empty.candidate, null, "candidate application is immutable");
assert.throws(() => setCandidate(awaiting, candidate(0, [])), /already awaits/);
assert.throws(
	() => setCandidate(empty, candidate(0, [])),
	/exact candidate schema/,
	"an initial candidate cannot omit all future phases",
);
assert.throws(() => setCandidate(empty, candidate(1, [phase("Stale")])), /stale/);
assert.throws(
	() => setCandidate(empty, candidate(0, [phase("Injected", undefined, ["Not retained."])])),
	/exact candidate schema/,
	"new candidate phases cannot inject amendments",
);
assert.throws(
	() => setCandidate(empty, candidate(0, [], dirty, null)),
	/exact candidate schema/,
	"dirty snapshots require an explicit disposition",
);
assert.throws(
	() => setCandidate(empty, candidate(0, [], clean, "carry")),
	/exact candidate schema/,
	"clean snapshots require a null disposition",
);
assert.equal(
	validatePlanEnvelope({
		...empty,
		candidate: candidate(0, [], dirty, "carry"),
	}).length > 0,
	true,
	"carried dirty work requires a future phase at the storage boundary",
);

const approved = promoteCandidate(awaiting, clean);
assert.equal(approved.revision, 1);
assert.equal(approved.history.length, 1);
assert.equal(approved.nextPhaseId, 3);
assert.equal(approved.candidate, null);
assert.deepEqual(approved.approved?.completed, []);
assert.deepEqual(
	approved.approved?.future.map(({ id, status, amendments }) => [
		id,
		status,
		amendments,
	]),
	[
		["P1", "pending", []],
		["P2", "pending", []],
	],
);
const exhausted = { ...approved, revision: Number.MAX_SAFE_INTEGER };
assert.match(
	validatePlanEnvelope(exhausted).join("; "),
	/maximum plan revision is reserved for a completed terminal plan/,
);
assert.throws(
	() => setCandidate({ ...approved, revision: Number.MAX_SAFE_INTEGER - 1 }, candidate(Number.MAX_SAFE_INTEGER - 1, [phase("More")])),
	/candidate and its future completions exceed the plan revision bound/,
);
assert.throws(
	() => setCandidate(
		{ ...approved, revision: Number.MAX_SAFE_INTEGER - 2 },
		candidate(Number.MAX_SAFE_INTEGER - 2, [phase("One"), phase("Two")]),
	),
	/candidate and its future completions exceed the plan revision bound/,
	"capacity includes promotion and every future completion",
);
assert.throws(
	() => amendPendingPhase({ ...approved, revision: Number.MAX_SAFE_INTEGER - 1 }, "P1", "Too late."),
	/revision allocation is exhausted/,
);

const amendedOnce = amendPendingPhase(approved, "P2", "Preserve the public API.");
const amendedTwice = amendPendingPhase(
	amendedOnce,
	"P2",
	"Verify both success and failure paths.",
);
assert.equal(amendedTwice.revision, approved.revision + 2);
assert.equal(amendedTwice.history.length, approved.history.length, "mechanical amendments do not create snapshots");
assert.deepEqual(amendedTwice.approved?.future[1].amendments, [
	"Preserve the public API.",
	"Verify both success and failure paths.",
]);
assert.deepEqual(approved.approved?.future[1].amendments, []);
assert.throws(() => amendPendingPhase(awaiting, "P1", "Blocked."), /candidate awaits/);
for (const invalid of ["", " padded ", "bad\u0007text", "x".repeat(10_001)])
	assert.throws(() => amendPendingPhase(approved, "P2", invalid), /amendment must/);
assert.throws(() => amendPendingPhase(approved, "P9", "Unknown."), /not an approved pending/);
assert.throws(
	() =>
		setCandidate(
			amendedTwice,
			candidate(amendedTwice.revision, [phase("Second", "P2")]),
		),
	/does not exactly match/,
	"retained IDs must carry exact amendments",
);
const retainedAmendments = promoteCandidate(
	setCandidate(
		amendedTwice,
		candidate(amendedTwice.revision, [
			phase("Second", "P2", amendedTwice.approved!.future[1].amendments),
		]),
	),
	clean,
);
assert.deepEqual(retainedAmendments.approved?.future[0].amendments, [
	"Preserve the public API.",
	"Verify both success and failure paths.",
]);
assert.equal(retainedAmendments.history.length, 2, "replacement promotion creates one snapshot");
const historyBeforeCompletion = retainedAmendments.history;
assert.strictEqual(
	completePhase(retainedAmendments, firstPendingPhase(retainedAmendments)!, "Completed.", null).history.length,
	historyBeforeCompletion.length,
	"completion does not create a snapshot",
);

const amendedFirst = amendPendingPhase(approved, "P1", "Use the existing validator.");
assert.throws(
	() => completePhase(amendedFirst, firstPendingPhase(approved)!, "Stale snapshot.", null),
	/unchanged first pending/,
);
const completedAmended = completePhase(
	amendedFirst,
	firstPendingPhase(amendedFirst)!,
	"Completed the amended phase.",
	null,
);
assert.deepEqual(completedAmended.approved!.completed[0].amendments, [
	"Use the existing validator.",
]);

const p1 = firstPendingPhase(approved)!;
const afterNoCode = completePhase(
	approved,
	p1,
	"The existing implementation already satisfies the phase.",
	null,
);
assert.equal(afterNoCode.approved?.completed[0].status, "completed");
assert.equal(afterNoCode.approved?.completed[0].commit, null, "no-code phases have no commit");
assert.deepEqual(afterNoCode.approved?.future.map(({ id }) => id), ["P2"]);
assert.equal(afterNoCode.revision, 2);
assert.strictEqual(
	completePhase(
		afterNoCode,
		p1,
		"The existing implementation already satisfies the phase.",
		null,
	),
	afterNoCode,
	"completion recovery is idempotent",
);
assert.throws(
	() => completePhase(afterNoCode, p1, "A different result.", null),
	/result does not match recovery/,
);

const completedPrefix = structuredClone(afterNoCode.approved?.completed[0]);
assert.throws(
	() => amendPendingPhase(afterNoCode, "P1", "Too late."),
	/completed and cannot be amended/,
);
assert.throws(
	() => setCandidate(afterNoCode, candidate(2, [phase("Rewrite completed", "P1")])),
	/completed and immutable/,
);
assert.throws(
	() => setCandidate(afterNoCode, candidate(2, [phase("Unknown", "P9")])),
	/not an approved pending phase/,
);
assert.throws(
	() => setCandidate(afterNoCode, candidate(2, [phase("Changed second", "P2")])),
	/does not exactly match/,
);
const emptyReplacement = { ...afterNoCode, candidate: candidate(2, [], clean) };
assert.ok(validatePlanEnvelope(emptyReplacement).length > 0, "persisted replacement candidates require a future phase");
assert.throws(
	() => setCandidate(afterNoCode, candidate(2, [], clean)),
	/exact candidate schema/,
	"a clean replacement cannot promote an empty future queue into done",
);
const retainedRevision = setCandidate(
	afterNoCode,
	candidate(2, [phase("Second", "P2")]),
);
assert.equal(
	promoteCandidate(retainedRevision, clean).approved?.future[0].id,
	"P2",
	"exactly unchanged pending phase content retains its stable ID",
);

const revisedCandidate = candidate(
	2,
	[phase("New first"), phase("Second", "P2")],
	dirty,
	"carry",
);
const revisedAwaiting = setCandidate(afterNoCode, revisedCandidate);
assert.throws(
	() => promoteCandidate(revisedAwaiting, { ...dirty, tree: DIGEST_A }),
	/snapshot is stale/,
);
const clearedStale = clearStaleCandidate(revisedAwaiting, {
	...dirty,
	tree: DIGEST_A,
});
assert.equal(clearedStale.candidate, null);
assert.equal(
	candidateClearingMatches(clearedStale, revisedCandidate),
	true,
	"promotion recovery recognizes a candidate already cleared as stale",
);
assert.equal(candidateClearingMatches(revisedAwaiting, revisedCandidate), false);
assert.throws(
	() => clearStaleCandidate(revisedAwaiting, dirty),
	/still current/,
);

const promotedRevision = promoteCandidate(revisedAwaiting, dirty);
assert.equal(
	candidateClearingMatches(promotedRevision, revisedCandidate),
	false,
	"a promoted candidate is not mistaken for stale clearing",
);
assert.deepEqual(
	promotedRevision.approved?.future.map(({ id, title }) => [id, title]),
	[
		["P3", "New first"],
		["P2", "Second"],
	],
	"promotion replaces the future queue and may reorder retained IDs",
);
assert.deepEqual(
	promotedRevision.approved?.completed,
	[completedPrefix],
	"promotion preserves completed phases byte-for-byte",
);
assert.equal(promotedRevision.nextPhaseId, 4);
assert.equal(promotedRevision.revision, 3);

const disposable = setCandidate(
	afterNoCode,
	candidate(2, [phase("Discard replacement")], dirty, "discard"),
);
const disposableSnapshot = disposable.candidate!;
assert.throws(
	() => promoteCandidate(disposable, dirty),
	/recoverable discard transaction/,
	"discard candidates cannot bypass destructive confirmation and recovery",
);
const afterDiscard = promoteDiscardedCandidate(
	disposable,
	disposableSnapshot,
	{ head: SHA_A, paths: [], tree: DIGEST_A },
);
assert.deepEqual(afterDiscard.approved?.completed.map(({ id }) => id), ["P1"]);
assert.deepEqual(
	afterDiscard.approved?.future.map(({ id }) => id),
	["P3"],
	"discard recovery promotes the complete replacement queue and removes omitted pending work",
);
assert.equal(candidatePromotionMatches(afterDiscard, disposableSnapshot), true);
assert.equal(
	candidatePromotionMatches(
		{
			...afterDiscard,
			approved: {
				...afterDiscard.approved!,
				objective: "A different promoted objective.",
			},
		},
		disposableSnapshot,
	),
	false,
	"discard recovery does not infer an unrelated promoted plan",
);
assert.throws(
	() =>
		promoteDiscardedCandidate(disposable, disposableSnapshot, {
			head: SHA_B,
			paths: [],
			tree: DIGEST_A,
		}),
	/clean expected HEAD/,
);
const cleared = clearCandidate(disposable, disposableSnapshot);
assert.equal(cleared.candidate, null, "successful revision feedback may clear its exact candidate");
const reorderedCandidate: PlanCandidate = {
	activeWorkDisposition: "discard",
	worktreeSnapshot: dirty,
	future: [
		{
			hints: [],
			amendments: [],
			successCriteria: ["Discard replacement is verified."],
			objective: "Implement discard replacement.",
			title: "Discard replacement",
		},
	],
	successCriteria: [...content.successCriteria],
	nonGoals: [],
	assumptions: [],
	decisions: [],
	risks: [],
	constraints: [],
	desiredEndState: content.desiredEndState,
	objective: content.objective,
	expectedRevision: 2,
};
const reorderedAwaiting = setCandidate(afterNoCode, reorderedCandidate);
assert.equal(
	clearCandidate(reorderedAwaiting, reorderedCandidate).candidate,
	null,
	"candidate identity ignores irrelevant object key order",
);
assert.throws(
	() => clearCandidate(disposable, revisedCandidate),
	/candidate changed/,
	"failed or stale feedback cannot clear another candidate",
);

let finished = promotedRevision;
while (firstPendingPhase(finished)) {
	const current = firstPendingPhase(finished)!;
	finished = completePhase(
		finished,
		current,
		`Completed ${current.id}.`,
		current.id === "P3" ? SHA_B : null,
	);
}
assert.equal(planIsDone(finished), true);
const donePrefix = structuredClone(finished.approved?.completed);
const extension = promoteCandidate(
	setCandidate(finished, candidate(finished.revision, [phase("Extension")])),
	clean,
);
assert.deepEqual(
	extension.approved?.completed,
	donePrefix,
	"done-task extension preserves every completed phase",
);
assert.equal(extension.approved?.future[0]?.id, "P4");
assert.equal(extension.approved?.future[0]?.status, "pending");
assert.equal(extension.history.length, 3, "extension promotion creates one snapshot");
const immutableHistory = extension.history;
const lastSnapshot = extension.history.at(-1)!;
for (const malformed of [
	{ ...extension, history: [{ ...lastSnapshot, content: { ...lastSnapshot.content, unexpected: true } }] },
	{ ...extension, history: [{ ...lastSnapshot, future: [{ title: "bad", objective: "bad", successCriteria: [], hints: [] }] }] },
	{ ...extension, history: [lastSnapshot, { ...lastSnapshot, revision: lastSnapshot.revision }] },
	{ ...extension, history: [lastSnapshot, { ...lastSnapshot, revision: lastSnapshot.revision - 1 }] },
	{ ...extension, history: [{ ...lastSnapshot, revision: extension.revision + 1 }] },
	{ ...extension, history: [] },
]) assert.throws(() => parsePlanEnvelope(JSON.stringify(malformed)), /invalid plan envelope/);
const nextCandidate = candidate(extension.revision, [phase("next")]);
const tamperedHistory = structuredClone(promoteCandidate(setCandidate(extension, nextCandidate), clean));
tamperedHistory.history.at(-1)!.content.objective = "tampered";
assert.equal(candidatePromotionMatches(tamperedHistory, nextCandidate), false);

const changedHistory = promoteCandidate(setCandidate(extension, candidate(extension.revision, [phase("Another extension")])), clean).history;
changedHistory[0].content.objective = "mutated";
assert.notEqual(immutableHistory[0].content.objective, "mutated");
assert.equal(planIsDone(extension), false);

for (const path of ["a", "src/a.ts", "dir/file name", "src\\literal"])
	assert.equal(safeRelativePath(path), true, path);
for (const path of ["", ".", "..", "/a", "../a", "a/../b", "a//b", "a\0b"])
	assert.equal(safeRelativePath(path), false, path);

const validJson = serializePlanEnvelope(extension);
assert.deepEqual(parsePlanEnvelope(validJson), extension);
assert.throws(() => parsePlanEnvelope("not json"), /invalid plan JSON/);
for (const malformed of [
	{ ...extension, version: 2 },
	{ ...extension, request: "" },
	{ ...extension, extra: true },
	{ ...extension, nextPhaseId: 4 },
	{
		...extension,
		approved: {
			...extension.approved!,
			future: [{ ...extension.approved!.future[0], amendments: undefined }],
		},
	},
	{
		...extension,
		approved: {
			...extension.approved!,
			completed: [{ ...extension.approved!.completed[0], amendments: undefined }],
		},
	},
	{
		...empty,
		candidate: { ...candidate(0, []), future: [] },
	},
	{
		...awaiting,
		candidate: { ...awaiting.candidate!, expectedRevision: 9 },
	},
	{
		...awaiting,
		candidate: {
			...awaiting.candidate!,
			worktreeSnapshot: { ...clean, paths: ["b", "a"] },
		},
	},
]) {
	assert.throws(
		() => parsePlanEnvelope(JSON.stringify(malformed)),
		/invalid plan envelope/,
		"malformed stores fail rather than being inferred or repaired",
	);
}

const root = mkdtempSync(join(tmpdir(), "juruc-plan-test-"));
try {
	const path = join(root, "plan.json");
	savePlanEnvelope(path, extension);
	assert.deepEqual(loadPlanEnvelope(path), extension);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(readFileSync(path, "utf8"), validJson);
	writeFileSync(path, "{}\n");
	assert.throws(() => loadPlanEnvelope(path), /exact version-4/);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("juruc plan domain: ok");
