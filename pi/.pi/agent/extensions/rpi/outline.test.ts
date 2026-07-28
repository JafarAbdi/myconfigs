import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
	EMPTY_OUTLINE_STORE,
	applyOutlineRevision,
	completePhase,
	firstPendingPhase,
	outlineRevisionSchema,
	outlineStoreSchema,
	parseOutlineRevision,
	parseOutlineStore,
	pendingPhaseInputSchema,
	phaseEquals,
	renderBuildPhase,
	renderOutline,
	safeRepositoryPath,
	serializeOutlineRevision,
	serializeOutlineStore,
	setOutlineSchema,
	type OutlineRevision,
	type OutlineStore,
	type PendingPhase,
	type PendingPhaseInput,
	validateOutlineStore,
} from "./outline.ts";

const phase = (title = "Add parser"): PendingPhaseInput => ({
	title,
	summary: `Implement ${title.toLowerCase()}.`,
	file_changes: [{ path: "src/parser.ts", change: "Add parse()." }],
	verification: ["npm test"],
});
const add = (title = "Add parser") => ({ kind: "add" as const, ...phase(title) });
const overview = {
	kind: "revise" as const,
	title: "Structured outline",
	summary: "Move progress into structured state.",
	desired_end_state: "Build uses approved JSON progress only.",
};
const revision = (pending = [add()]): OutlineRevision => ({
	overview,
	pending,
	removed_pending_ids: [],
});
const toolInput = (pending = [add()]) => ({ task_slug: "structured-outline", ...revision(pending) });

assert.equal(Check(outlineStoreSchema, EMPTY_OUTLINE_STORE), true);
assert.deepEqual(validateOutlineStore(EMPTY_OUTLINE_STORE), []);
assert.equal(Check(pendingPhaseInputSchema, phase()), true);
assert.equal(Check(outlineRevisionSchema, revision()), true);
assert.equal(Check(setOutlineSchema, toolInput()), true);
assert.equal(Check(outlineRevisionSchema, toolInput()), false, "routing slug is not persisted");
assert.throws(
	() => applyOutlineRevision(EMPTY_OUTLINE_STORE, { overview: { kind: "keep" }, pending: [], removed_pending_ids: [] }),
	/must revise the empty overview/,
);

const initial = applyOutlineRevision(EMPTY_OUTLINE_STORE, revision());
const one = initial.outline;
assert.equal(one.phases[0].id, "P1");
assert.deepEqual(initial.changes, {
	overview: true,
	kept: 0,
	revised: 0,
	removed: 0,
	added: 1,
	reordered: false,
});
assert.equal(phaseEquals(one.phases[0], { ...one.phases[0] }), true);

const keepRevision: OutlineRevision = {
	overview: { kind: "keep" },
	pending: [{ kind: "keep", id: "P1" }],
	removed_pending_ids: [],
};
const kept = applyOutlineRevision(one, keepRevision);
assert.deepEqual(kept.outline, one);
assert.deepEqual(kept.changes, {
	overview: false,
	kept: 1,
	revised: 0,
	removed: 0,
	added: 0,
	reordered: false,
});

const revised = applyOutlineRevision(one, {
	...keepRevision,
	pending: [{ kind: "revise", id: "P1", ...phase("Repair parser") }],
});
assert.equal(revised.outline.phases[0].id, "P1");
assert.equal(revised.outline.phases[0].title, "Repair parser");
assert.equal(revised.changes.revised, 1, "revise remains intentional even with equal text");

const removed = applyOutlineRevision(one, {
	overview: { kind: "keep" },
	pending: [],
	removed_pending_ids: ["P1"],
});
assert.equal(removed.outline.phases.length, 0);
const fresh = applyOutlineRevision(removed.outline, { ...revision([add("Add lexer")]), overview: { kind: "keep" } });
assert.equal(fresh.outline.phases[0].id, "P2", "removed IDs are never reused");

for (const [candidate, pattern] of [
	[{ ...keepRevision, pending: [] }, /must be kept, revised, or explicitly removed/],
	[{ ...keepRevision, removed_pending_ids: ["P1"] }, /referenced more than once/],
	[{ ...keepRevision, pending: [{ kind: "keep", id: "P9" }] }, /not an approved pending phase/],
] as const) assert.throws(() => applyOutlineRevision(one, candidate as OutlineRevision), pattern);

const committed = completePhase(one, firstPendingPhase(one)!, null);
assert.equal(committed.phases[0].status, "completed");
assert.throws(() => applyOutlineRevision(committed, keepRevision), /completed and immutable/);
const withPending = applyOutlineRevision(committed, { ...revision([add("Second")]), overview: { kind: "keep" } }).outline;
assert.deepEqual(withPending.phases[0], committed.phases[0], "completed records stay exact");

const p2 = firstPendingPhase(withPending)!;
const twoPending = applyOutlineRevision(one, {
	overview: { kind: "keep" },
	pending: [{ kind: "keep", id: "P1" }, add("Second")],
	removed_pending_ids: [],
}).outline;
const reordered = applyOutlineRevision(twoPending, {
	overview: { kind: "keep" },
	pending: [{ kind: "keep", id: "P2" }, { kind: "keep", id: "P1" }],
	removed_pending_ids: [],
});
assert.equal(reordered.changes.reordered, true);
assert.deepEqual(reordered.outline.phases.map(({ id }) => id), ["P2", "P1"]);
assert.throws(() => completePhase(withPending, { ...p2, summary: "Changed." }, null), /exact pending snapshot/);

for (const path of ["src/a.ts", "a", "dir/a b.ts"]) assert.equal(safeRepositoryPath(path), true, path);
for (const path of ["", ".", "..", "../a", "a/../b", "/a", "a\\b", " a", "a\nfile"]) assert.equal(safeRepositoryPath(path), false, path);
assert.throws(
	() => applyOutlineRevision(EMPTY_OUTLINE_STORE, revision([{ kind: "add", ...phase(), file_changes: [{ path: "../escape", change: "Bad." }] }])),
	/unsafe path/,
);

const encoded = serializeOutlineStore(one);
assert.deepEqual(parseOutlineStore(encoded), one);
assert.throws(() => parseOutlineStore("not json"), /invalid outline JSON/);
const encodedRevision = serializeOutlineRevision(keepRevision);
assert.deepEqual(parseOutlineRevision(encodedRevision), keepRevision);
assert.throws(() => parseOutlineRevision(JSON.stringify(toolInput())), /exact revision schema/);

const provenance = { repo: "/repo", branch: "feature/outline", sha: "a".repeat(40) };
const approvedView = renderOutline(withPending, provenance);
const candidateView = renderOutline(reordered.outline, provenance, "candidate");
assert.doesNotMatch(approvedView, /Awaiting approval/);
assert.match(candidateView, /Awaiting approval/);
assert.match(approvedView, /Phase 1 \(P1\): Add parser/);
assert.match(approvedView, /Phase 2 \(P2\): Second/);

const brief = renderBuildPhase(one.phases[0] as PendingPhase);
assert.deepEqual(JSON.parse(brief.slice(brief.indexOf("\n") + 1, brief.lastIndexOf("\n"))), {
	id: "P1",
	title: "Add parser",
	summary: "Implement add parser.",
	file_changes: [{ path: "src/parser.ts", change: "Add parse()." }],
	verification: ["npm test"],
});

const unsafeId: OutlineStore = {
	...one,
	next_phase_id: Number.MAX_SAFE_INTEGER,
	phases: [{ ...one.phases[0], id: `P${Number.MAX_SAFE_INTEGER - 1}` }],
};
assert.throws(
	() => applyOutlineRevision(unsafeId, {
		overview: { kind: "keep" },
		pending: [{ kind: "keep", id: `P${Number.MAX_SAFE_INTEGER - 1}` }, add("Overflow")],
		removed_pending_ids: [],
	}),
	/MAX_SAFE_INTEGER/,
);

console.log("rpi outline revision domain: ok");
