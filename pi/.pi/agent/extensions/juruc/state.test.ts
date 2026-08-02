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
	createPlanEnvelope,
	firstPendingPhase,
	promoteCandidate,
	setCandidate,
	type PlanCandidate,
} from "./plan.ts";
import {
	acceptingReceiptState,
	acceptingState,
	amendingState,
	attachResearchSession,
	buildingAuditState,
	buildingState,
	committingMessageState,
	committingState,
	creatingState,
	deletingState,
	discardingState,
	doneState,
	evidenceSucceededState,
	grillPlanningState,
	loadExecutionState,
	orientationSucceededState,
	parseExecutionState,
	parseExecutionStateJson,
	PHASES,
	promotingState,
	researchPlanningState,
	revisingState,
	saveExecutionState,
	serializeExecutionState,
	startingState,
	stagingState,
	transitionExecutionState,
	validExecutionTransition,
} from "./state.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(64);
const DIGEST = "1".repeat(64);
const deletionSnapshot = {
	kind: "present" as const,
	head: SHA_A,
	paths: ["src/a.ts"],
};
const identity = {
	version: 7 as const,
	slug: "state-machine",
	branch: "state-machine",
	worktree: "/tmp/juruc/worktrees/state-machine",
	sourceRoot: "/tmp/source",
	baseBranch: "main",
	sourceHead: SHA_A,
	planningSession: {
		path: "/tmp/pi-sessions/plan.jsonl",
		id: "planning-session",
	},
	buildSessions: [
		{ path: "/tmp/pi-sessions/build.jsonl", id: "build-session" },
	],
};
const content = {
	objective: "Execute explicit state transitions.",
	desiredEndState: "Every persisted state is recoverable.",
	constraints: [],
	assumptions: [],
	nonGoals: [],
	decisions: [],
	risks: [],
	successCriteria: ["Malformed state is rejected."],
};
const cleanCandidate: PlanCandidate = {
	expectedRevision: 0,
	...content,
	future: [
		{
			title: "Build state",
			objective: "Implement the state module.",
			successCriteria: ["Every state parses exactly."],
			hints: [],
			amendments: [],
		},
	],
	worktreeSnapshot: { head: SHA_A, paths: [], tree: DIGEST },
	activeWorkDisposition: null,
};
const discardCandidate: PlanCandidate = {
	...cleanCandidate,
	worktreeSnapshot: {
		head: SHA_A,
		paths: ["src/a.ts", "src/b.ts"],
		tree: "2".repeat(64),
	},
	activeWorkDisposition: "discard",
};
const plan = promoteCandidate(
	setCandidate(
		createPlanEnvelope(
			"State machine",
			"Exercise explicit state transitions.",
		),
		cleanCandidate,
	),
	cleanCandidate.worktreeSnapshot,
);
const phase = firstPendingPhase(plan)!;

assert.deepEqual(PHASES, [
	"creating",
	"planning",
	"revising",
	"promoting",
	"starting",
	"building",
	"amending",
	"discarding",
	"staging",
	"committing",
	"accepting",
	"done",
	"deleting",
]);

const creating = creatingState(identity);
const revisionSubject = "Research the state machine.\nPreserve exact schemas.";
const planning = researchPlanningState(identity, "revision", revisionSubject);
const researchSession = {
	path: "/tmp/pi-sessions/research.jsonl",
	id: "research-session",
};
const researching = attachResearchSession(planning, researchSession);
const evidenceResearch = orientationSucceededState(researching);
const readyResearch = evidenceSucceededState(evidenceResearch);
const grilling = grillPlanningState(readyResearch);
const revising = revisingState(identity, cleanCandidate, revisionSubject);
const promoting = promotingState(identity, cleanCandidate);
const phaseSession = identity.buildSessions[0];
const starting = startingState(identity, phase, phaseSession);
const building = buildingState(identity, phase, phaseSession);
const amendment = "Also verify crash-safe amendment recovery.";
const amendedPhase = firstPendingPhase(amendPendingPhase(plan, phase.id, amendment))!;
const amending = amendingState(building, amendedPhase, amendment);
const amendedBuilding = buildingState(identity, amendedPhase, phaseSession);
const auditSnapshot = {
	head: SHA_A,
	paths: ["src/a.ts", "src/b.ts"],
	tree: DIGEST,
};
const auditReceipt = {
	kind: "phase" as const,
	snapshot: auditSnapshot,
	summary: "Validated the exact state-machine candidate.",
};
const auditedBuilding = buildingAuditState(building, auditReceipt);
const discarding = discardingState(identity, discardCandidate);
const staging = stagingState(
	identity,
	phase,
	phaseSession,
	"Implemented and audited the state module.",
	SHA_A,
	["src/a.ts", "src/b.ts"],
	DIGEST,
);
const committing = committingState(staging, "baseline-entry");
const messagedCommitting = committingMessageState(committing, {
	responseEntryId: "response-entry",
	text: "Commit state machine",
});
const terminalAudit = {
	kind: "terminal" as const,
	task: identity.slug,
	planRevision: plan.revision,
	sourceHead: SHA_A,
	currentHead: SHA_A,
	baseHead: SHA_A,
	phaseSnapshot: phase,
	phaseSession,
	stagedTree: DIGEST,
	snapshot: auditSnapshot,
	summary: "Validated the integrated candidate.",
};
const accepting = acceptingState(building, terminalAudit, SHA_A, DIGEST, SHA_B, plan.revision + 1, [SHA_B]);
const acceptance = {
	task: identity.slug,
	phase,
	phaseSession,
	sourceHead: SHA_A,
	currentHead: SHA_B,
	finalParent: SHA_A,
	finalCommit: SHA_B,
	finalTree: DIGEST,
	auditedPlanRevision: plan.revision,
	completedPlanRevision: plan.revision + 1,
	orderedPhaseCommits: [SHA_B],
	auditSummary: "Validated the integrated candidate.",
	baseHead: SHA_A,
};
const receiptedAccepting = acceptingReceiptState(accepting, acceptance);
const done = doneState(receiptedAccepting);
assert.throws(() => doneState(identity), /acceptance receipt/);
assert.equal(parseExecutionState({ ...receiptedAccepting, orderedPhaseCommits: [SHA_A] }), undefined, "accepting rejects a changed ordered commit chain");
assert.equal(parseExecutionState({ ...accepting, acceptance: { ...acceptance, orderedPhaseCommits: [SHA_A] } }), undefined, "accepting rejects a mismatched receipt");
const tamperedDone = { ...done, acceptance: { ...done.acceptance, auditSummary: "tampered" } };
assert.notEqual(parseExecutionState(tamperedDone), undefined, "done retains a structurally valid tampered receipt");
assert.equal(validExecutionTransition(receiptedAccepting, tamperedDone), false, "accepting to done requires exact receipt equality");
assert.equal(validExecutionTransition(receiptedAccepting, { ...done, acceptance: { ...done.acceptance, finalTree: SHA_A } }), false, "done rejects a tampered retained tree");
const deleting = deletingState(identity, deletionSnapshot);

const states = {
	creating,
	planning,
	revising,
	promoting,
	starting,
	building,
	amending,
	discarding,
	staging,
	committing,
	done,
	deleting,
};
for (const state of Object.values(states)) {
	assert.deepEqual(parseExecutionState(state), state, `${state.phase} schema`);
	const persisted = { ...state } as Record<string, unknown>;
	delete persisted.branch;
	delete persisted.worktree;
	assert.deepEqual(parseExecutionStateJson(serializeExecutionState(state)), persisted);
}

const ordinaryTransitions = new Set([
	"creating->planning",
	"planning->revising",
	"planning->promoting",
	"planning->discarding",
	"revising->planning",
	"promoting->planning",
	"promoting->starting",
	"starting->starting",
	"starting->building",
	"building->planning",
	"building->building",
	"building->amending",
	"building->staging",
	"discarding->starting",
	"staging->planning",
	"staging->committing",
	"committing->planning",
	"committing->accepting",
	"accepting->accepting",
	"accepting->done",
	"done->planning",
]);
for (const [fromName, from] of Object.entries(states)) {
	for (const [toName, to] of Object.entries(states)) {
		const transition = `${fromName}->${toName}`;
		const expected =
			ordinaryTransitions.has(transition) ||
			(toName === "deleting" && fromName !== "deleting");
		assert.equal(
			validExecutionTransition(from, to),
			expected,
			`${transition} transition`,
		);
		if (expected) assert.strictEqual(transitionExecutionState(from, to), to);
		else assert.throws(
			() => transitionExecutionState(from, to),
			new RegExp(`${fromName} -> ${toName}`),
		);
	}
}
assert.equal(
	validExecutionTransition(amending, amendedBuilding),
	true,
	"amendment recovery resumes the same session with the amended snapshot",
);
assert.equal(
	validExecutionTransition(amending, building),
	false,
	"amendment recovery cannot restore the stale phase snapshot",
);
assert.equal(validExecutionTransition({}, planning), false);
assert.equal(validExecutionTransition(planning, {}), false);
assert.equal(building.audit, null, "building starts without an audit");
assert.equal(committing.promptBaselineEntryId, "baseline-entry");
assert.equal(committing.commitMessage, null);
assert.deepEqual(committing.paths, staging.paths);
assert.deepEqual(messagedCommitting.commitMessage, {
	responseEntryId: "response-entry",
	text: "Commit state machine",
});
assert.throws(() => committingMessageState(committing, { responseEntryId: "", text: "bad" }), /invalid commit-message receipt/);
assert.deepEqual(auditedBuilding.audit, auditReceipt);
assert.notStrictEqual(auditedBuilding.audit, auditReceipt);
assert.notStrictEqual(auditedBuilding.audit?.snapshot, auditSnapshot);
assert.notStrictEqual(auditedBuilding.audit?.snapshot.paths, auditSnapshot.paths);
assert.strictEqual(auditedBuilding.phaseSnapshot, building.phaseSnapshot);
assert.strictEqual(auditedBuilding.phaseSession, building.phaseSession);
assert.deepEqual(buildingAuditState(auditedBuilding, null), building);
assert.equal(validExecutionTransition(building, auditedBuilding), true);
assert.equal(validExecutionTransition(auditedBuilding, building), true);
assert.equal(validExecutionTransition(starting, auditedBuilding), false);
assert.equal(validExecutionTransition(auditedBuilding, staging), true);
assert.equal(
	validExecutionTransition(
		auditedBuilding,
		buildingAuditState(
			buildingState(identity, { ...phase, id: "P2" }, phaseSession),
			auditReceipt,
		),
	),
	false,
	"audit updates cannot change phase",
);
const otherSessionIdentity = {
	...identity,
	buildSessions: [
		...identity.buildSessions,
		{ path: "/tmp/pi-sessions/other.jsonl", id: "other-session" },
	],
};
assert.equal(
	validExecutionTransition(
		auditedBuilding,
		buildingAuditState(
			buildingState(
				otherSessionIdentity,
				phase,
				otherSessionIdentity.buildSessions[1],
			),
			auditReceipt,
		),
	),
	false,
	"audit updates cannot change session or identity",
);
const otherPhase = { ...phase, id: "P2" };
const nextStarting = startingState(identity, otherPhase);
assert.equal(
	validExecutionTransition(building, nextStarting),
	true,
	"a no-code phase advances from building to a different pending phase",
);
assert.strictEqual(transitionExecutionState(building, nextStarting), nextStarting);
assert.equal(
	validExecutionTransition(staging, nextStarting),
	true,
	"legacy ignored-only staging advances to a different pending phase",
);
assert.equal(
	validExecutionTransition(committing, nextStarting),
	true,
	"a committed phase advances to a different pending phase",
);
assert.equal(
	validExecutionTransition(building, startingState(identity, phase)),
	false,
	"the same phase cannot restart as the next phase",
);
assert.equal(
	validExecutionTransition(
		building,
		startingState(identity, otherPhase, phaseSession),
	),
	false,
	"the next phase must not already have a session",
);
assert.equal(
	validExecutionTransition(
		building,
		startingState(otherSessionIdentity, otherPhase),
	),
	false,
	"next-phase progression preserves the session inventory",
);
const otherBuilding = buildingState(identity, otherPhase, phaseSession);
const otherStaging = stagingState(
	identity,
	otherPhase,
	phaseSession,
	staging.resolution,
	staging.parent,
	staging.paths,
	staging.tree,
);
assert.equal(
	validExecutionTransition(building, otherStaging),
	false,
	"building cannot stage another phase",
);
assert.equal(
	validExecutionTransition(staging, otherBuilding),
	false,
	"staging recovery cannot activate another phase",
);
const changedTransaction = stagingState(
	identity,
	phase,
	phaseSession,
	"A different reviewed resolution.",
	SHA_B,
	staging.paths,
	staging.tree,
);
assert.equal(
	validExecutionTransition(staging, committingState(changedTransaction, "changed-baseline")),
	false,
	"committing must preserve the staged phase, resolution, and parent",
);
assert.deepEqual(discarding.candidate, discardCandidate);
assert.equal(discarding.head, discardCandidate.worktreeSnapshot.head);
assert.deepEqual(discarding.paths, discardCandidate.worktreeSnapshot.paths);
assert.deepEqual(deleting.worktreeSnapshot, deletionSnapshot);
assert.deepEqual(deleting.buildSessions, [
	{ path: "/tmp/pi-sessions/build.jsonl", id: "build-session" },
]);
assert.deepEqual(promoting.candidate, cleanCandidate);
assert.deepEqual(revising.candidate, cleanCandidate);
assert.notStrictEqual(revising.candidate, cleanCandidate);
assert.notStrictEqual(revising.candidate.future, cleanCandidate.future);
assert.notStrictEqual(
	revising.candidate.worktreeSnapshot.paths,
	cleanCandidate.worktreeSnapshot.paths,
);
assert.equal(revising.subject, revisionSubject);
assert.deepEqual(
	parseExecutionState(deletingState(identity, { kind: "absent" })),
	deletingState(identity, { kind: "absent" }),
	"deletion persists an explicit absent-worktree snapshot",
);

for (const reason of ["initial", "revision", "blocked", "extension"] as const) {
	const state = researchPlanningState(identity, reason, "Explicit subject");
	assert.deepEqual(parseExecutionState(state), state);
	assert.equal(state.researchProgress, "orientation");
	assert.equal(state.researchSession, null);
}
for (const state of [researching, evidenceResearch, readyResearch, grilling])
	assert.deepEqual(parseExecutionState(state), state);
assert.equal(researching.researchProgress, "orientation");
assert.equal(evidenceResearch.researchProgress, "evidence");
assert.equal(readyResearch.researchProgress, "ready");
assert.deepEqual(evidenceResearch.researchSession, researchSession);
assert.deepEqual(readyResearch.researchSession, researchSession);
assert.equal(validExecutionTransition(researching, evidenceResearch), true);
assert.equal(validExecutionTransition(evidenceResearch, readyResearch), true);
assert.equal(validExecutionTransition(readyResearch, grilling), true);
assert.equal(validExecutionTransition(planning, grilling), false);
assert.throws(() => grillPlanningState(evidenceResearch), /requires ready research/);
assert.throws(() => orientationSucceededState(evidenceResearch), /orientation success/);
assert.throws(() => evidenceSucceededState(readyResearch), /evidence success/);
assert.equal(grilling.step, "grill");
assert.equal(grilling.reason, "revision");
assert.equal(grilling.subject, revisionSubject);
assert.equal(grilling.researchSession, null);
const persistedPlanning = { ...planning } as Record<string, unknown>;
delete persistedPlanning.branch;
delete persistedPlanning.worktree;
assert.equal(
	serializeExecutionState(planning),
	`${JSON.stringify(persistedPlanning, null, 2)}\n`,
	"planning serialization omits derived repository identity",
);

for (const malformed of [
	{ version: 1, phase: "planning" },
	{ version: 1, phase: "planning", reason: "unknown" },
	{ ...planning, subject: "" },
	{ ...planning, subject: " padded " },
	{ ...planning, subject: "nul\0subject" },
	{ ...planning, subject: "x".repeat(16_385) },
	{ ...planning, step: "review" },
	{ ...planning, step: undefined },
	{ ...planning, researchSession: undefined },
	{ ...planning, researchProgress: undefined },
	{ ...planning, researchProgress: "unknown" },
	{ ...planning, researchProgress: 1 },
	{ ...planning, researchProgress: "evidence" },
	{ ...planning, researchProgress: "ready" },
	{ ...planning, researchDelegatesStarted: 1 },
	{ ...planning, researchDelegatesCompleted: 1 },
	{ ...grilling, researchProgress: "ready" },
	{ ...grilling, researchSession: identity.buildSessions[0] },
	{ ...planning, researchSession: identity.planningSession },
	{ ...planning, researchSession: identity.buildSessions[0] },
	{ ...revising, candidate: { ...cleanCandidate, expectedRevision: -1 } },
	{ ...revising, subject: "" },
	{ ...revising, subject: " padded " },
	{ ...revising, subject: "x".repeat(16_385) },
	{ ...revising, feedback: revisionSubject },
	{ version: 1, phase: "building", phaseId: "P1" },
	{ ...building, phaseSession: null },
	{ ...building, phaseSession: { path: "/tmp/pi-sessions/other.jsonl", id: "other" } },
	{ ...building, audit: { ...auditReceipt, snapshot: { ...auditSnapshot, head: "short" } } },
	{
		...building,
		audit: { ...auditReceipt, snapshot: { ...auditSnapshot, paths: ["src/b.ts", "src/a.ts"] } },
	},
	{ ...building, audit: { ...auditReceipt, snapshot: { ...auditSnapshot, paths: ["../outside.ts"] } } },
	{ ...building, audit: { ...auditReceipt, snapshot: { ...auditSnapshot, tree: "short" } } },
	{ ...building, audit: { ...auditReceipt, summary: "" } },
	{ ...building, audit: { ...auditReceipt, summary: " padded" } },
	{ ...building, audit: { ...auditReceipt, summary: "two\nlines" } },
	{ ...building, audit: { ...auditReceipt, summary: "x".repeat(501) } },
	{ ...starting, audit: auditReceipt },
	{ ...staging, audit: auditReceipt },
	{
		...building,
		phaseSnapshot: { ...phase, status: "completed" },
	},
	{ ...discarding, head: SHA_B },
	{ ...discarding, paths: ["src/a.ts"] },
	{ ...discarding, candidate: { ...discardCandidate, activeWorkDisposition: "carry" } },
	{ ...staging, paths: [] },
	{ ...staging, paths: ["src/b.ts", "src/a.ts"] },
	{ ...staging, tree: "short" },
	{ ...committing, tree: undefined },
	{ ...committing, paths: undefined },
	{ ...committing, promptBaselineEntryId: "" },
	{ ...committing, promptBaselineEntryId: " padded" },
	{ ...committing, commitMessage: undefined },
	{ ...committing, commitMessage: { responseEntryId: "", text: "message" } },
	{ ...done, reason: "inferred" },
	{ ...creating, version: 5 },
	{ ...creating, branch: "another-task" },
	{ ...creating, sourceRoot: "relative" },
	{ ...creating, planningSessionPath: "/tmp/legacy-plan.jsonl" },
	{ ...creating, buildSessionPaths: ["/tmp/legacy-build.jsonl"] },
	{ ...creating, planningSession: { path: "relative.jsonl", id: "plan" } },
	{ ...creating, planningSession: { path: "/tmp/plan.jsonl", id: "bad id" } },
	{ ...creating, buildSessions: [{ path: "relative.jsonl", id: "build" }] },
	{
		...creating,
		buildSessions: [
			{ path: "/tmp/z.jsonl", id: "z" },
			{ path: "/tmp/a.jsonl", id: "a" },
		],
	},
	{
		...creating,
		buildSessions: [creating.planningSession!],
	},
	{ ...deleting, guessedWorktree: "/guessed/path" },
	{ ...deleting, worktreeSnapshot: { kind: "absent", tree: DIGEST } },
	{ ...deleting, worktreeSnapshot: { ...deletionSnapshot, paths: ["b", "a"] } },
]) {
	assert.equal(
		parseExecutionState(malformed),
		undefined,
		"missing, stale, inconsistent, and unknown fields fail without inference",
	);
}
assert.equal(
	validExecutionTransition(revising, grilling),
	false,
	"revision recovery always returns to research",
);
assert.equal(
	validExecutionTransition(
		revising,
		researchPlanningState(identity, "blocked", revisionSubject),
	),
	false,
	"revision recovery preserves revision intent",
);
assert.equal(
	validExecutionTransition(
		revising,
		researchPlanningState(identity, "revision", "Other feedback"),
	),
	false,
	"revision recovery preserves the persisted subject",
);
assert.equal(
	validExecutionTransition(
		planning,
		researchPlanningState(
			{ ...identity, slug: "other", branch: "other" },
			"initial",
			"Other task",
		),
	),
	false,
	"transitions cannot cross persisted task identities",
);
assert.equal(
	validExecutionTransition(
		planning,
		researchPlanningState(
			{
				...identity,
				planningSession: {
					...identity.planningSession,
					id: "replacement-session",
				},
			},
			"initial",
			"Replacement session",
		),
	),
	false,
	"a replacement header at the same path changes task identity",
);
assert.throws(() => discardingState(identity, cleanCandidate), /dirty discard candidate/);
assert.throws(
	() => promotingState(identity, discardCandidate),
	/clean or carry candidate/,
);
assert.throws(
	() => stagingState(identity, phase, phaseSession, "Bad\nresolution", SHA_A, ["src/a.ts"], DIGEST),
	/invalid staging/,
);
assert.throws(() => committingState({ ...staging, tree: "not-a-tree" }, "baseline"), /invalid committing/);
assert.throws(() => parseExecutionStateJson("not json"), /invalid state JSON/);
assert.throws(() => parseExecutionStateJson("{}"), /exact version-7/);
assert.equal(
	parseExecutionState({
		...planning,
		version: 5,
		researchDelegatesStarted: 6,
		researchDelegatesCompleted: 5,
	}),
	undefined,
	"legacy counter state is rejected rather than compatibility-decoded",
);

const root = mkdtempSync(join(tmpdir(), "juruc-state-test-"));
try {
	const path = join(root, "state.json");
	saveExecutionState(path, revising);
	const persistedRevising = { ...revising } as Record<string, unknown>;
	delete persistedRevising.branch;
	delete persistedRevising.worktree;
	assert.deepEqual(loadExecutionState(path), persistedRevising, "candidate revision survives restart");
	assert.equal(readFileSync(path, "utf8"), serializeExecutionState(revising));
	saveExecutionState(path, auditedBuilding);
	const persistedAudited = { ...auditedBuilding } as Record<string, unknown>;
	delete persistedAudited.branch;
	delete persistedAudited.worktree;
	assert.deepEqual(loadExecutionState(path), persistedAudited, "audit survives restart");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(readFileSync(path, "utf8"), serializeExecutionState(auditedBuilding));
	saveExecutionState(path, committing);
	const persistedCommitting = { ...committing } as Record<string, unknown>;
	delete persistedCommitting.branch;
	delete persistedCommitting.worktree;
	assert.deepEqual(loadExecutionState(path), persistedCommitting);
	const { phaseSession: _session, audit: _audit, ...incompleteBuilding } = building;
	writeFileSync(path, `${JSON.stringify(incompleteBuilding, null, 2)}\n`);
	assert.throws(() => loadExecutionState(path), /exact version-7/);
	writeFileSync(path, "{}\n");
	assert.throws(() => loadExecutionState(path), /exact version-7/);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("juruc execution state: ok");
