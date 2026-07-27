import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
	EMPTY_OUTLINE_STORE,
	completePhase,
	firstPendingPhase,
	outlineStoreSchema,
	parseOutlineStore,
	pendingPhaseInputSchema,
	phaseEquals,
	renderOutline,
	replacePendingOutline,
	safeRepositoryPath,
	serializeOutlineStore,
	setOutlineSchema,
	type OutlineStore,
	type PendingPhaseInput,
	validateOutlineStore,
} from "./outline.ts";

const phase = (title = "Add parser"): PendingPhaseInput => ({
	title,
	summary: `Implement ${title.toLowerCase()}.`,
	file_changes: [{ path: "src/parser.ts", change: "Add parse()." }],
	verification: ["npm test"],
});
const input = (pending_phases = [phase()]) => ({
	task_slug: "structured-outline",
	title: "Structured outline",
	summary: "Move progress into structured state.",
	desired_end_state: "Build uses JSON progress only.",
	pending_phases,
});

assert.equal(Check(outlineStoreSchema, EMPTY_OUTLINE_STORE), true);
assert.deepEqual(validateOutlineStore(EMPTY_OUTLINE_STORE), []);
assert.equal(Check(pendingPhaseInputSchema, phase()), true);
assert.equal(Check(pendingPhaseInputSchema, { ...phase(), id: "P1" }), false);
assert.equal(
	Check(setOutlineSchema, { ...input(), status: "completed" }),
	false,
);
assert.equal(
	Check(setOutlineSchema, {
		...input(),
		pending_phases: [{ ...phase(), resolution: null }],
	}),
	false,
);
assert.equal(
	(setOutlineSchema.properties.pending_phases as { maxItems?: number })
		.maxItems,
	undefined,
);
assert.equal(
	(setOutlineSchema as unknown as { additionalProperties: boolean })
		.additionalProperties,
	false,
);

const one = replacePendingOutline(EMPTY_OUTLINE_STORE, input());
assert.equal(one.phases[0].id, "P1");
assert.equal(one.next_phase_id, 2);
assert.equal(one.phases[0].status, "pending");
assert.equal(
	replacePendingOutline(one, input()),
	one,
	"exact snapshot retry preserves identity",
);
assert.equal(phaseEquals(one.phases[0], { ...one.phases[0] }), true);
assert.equal(
	phaseEquals(one.phases[0], { ...one.phases[0], title: "Changed" }),
	false,
);

const removed = replacePendingOutline(one, input([]));
assert.equal(removed.next_phase_id, 2);
const fresh = replacePendingOutline(removed, input([phase("Add lexer")]));
assert.equal(fresh.phases[0].id, "P2", "removed IDs are never reused");
assert.equal(fresh.next_phase_id, 3);

const many = replacePendingOutline(
	EMPTY_OUTLINE_STORE,
	input(Array.from({ length: 100 }, (_, index) => phase(`Phase ${index + 1}`))),
);
assert.equal(many.phases.length, 100);
assert.equal(many.phases[99].id, "P100");
assert.equal(EMPTY_OUTLINE_STORE.phases.length, 0, "transitions are pure");

for (const path of ["src/a.ts", "a", "dir/a b.ts"])
	assert.equal(safeRepositoryPath(path), true, path);
for (const path of [
	"",
	".",
	"..",
	"../a",
	"a/../b",
	"/a",
	"a\\b",
	" a",
	"a\nfile",
])
	assert.equal(safeRepositoryPath(path), false, path);
assert.throws(
	() =>
		replacePendingOutline(
			EMPTY_OUTLINE_STORE,
			input([
				{ ...phase(), file_changes: [{ path: "../escape", change: "Bad." }] },
			]),
		),
	/unsafe path/,
);
assert.throws(
	() =>
		replacePendingOutline(
			EMPTY_OUTLINE_STORE,
			input([{ ...phase(), title: "two\nlines" }]),
		),
	/single line/,
);
assert.throws(
	() =>
		replacePendingOutline(
			EMPTY_OUTLINE_STORE,
			input([{ ...phase(), summary: " padded " }]),
		),
	/surrounding whitespace/,
);

const encoded = serializeOutlineStore(one);
assert.equal(encoded, `${JSON.stringify(one, null, 2)}\n`);
assert.deepEqual(parseOutlineStore(encoded), one);
assert.throws(() => parseOutlineStore("not json"), /invalid outline JSON/);
assert.throws(() => parseOutlineStore('{"version":2}'), /exact version-1/);
assert.throws(
	() => parseOutlineStore(`${encoded.trim().slice(0, -1)},"extra":1}`),
	/exact version-1/,
);

const p1 = firstPendingPhase(one)!;
assert.equal(p1.id, "P1");
const committed = completePhase(one, p1, null);
assert.equal(committed.phases[0].status, "completed");
assert.equal(committed.phases[0].resolution, null);
assert.equal(
	completePhase(committed, p1, null),
	committed,
	"commit recovery is idempotent",
);
assert.throws(
	() => completePhase(committed, p1, "No code"),
	/resolution does not match/,
);

const noCodeSource = replacePendingOutline(
	committed,
	input([phase("Documentation review")]),
);
const p2 = firstPendingPhase(noCodeSource)!;
const noCode = completePhase(
	noCodeSource,
	p2,
	"Existing documentation already satisfies the design.",
);
assert.equal(
	noCode.phases[1].resolution,
	"Existing documentation already satisfies the design.",
);
assert.equal(
	completePhase(
		noCode,
		p2,
		"Existing documentation already satisfies the design.",
	),
	noCode,
);
assert.throws(
	() => completePhase(noCodeSource, { ...p2, summary: "Changed." }, null),
	/exact pending snapshot/,
);

const twoPending = replacePendingOutline(
	EMPTY_OUTLINE_STORE,
	input([phase("First"), phase("Second")]),
);
assert.throws(
	() => completePhase(twoPending, twoPending.phases[1] as typeof p1, null),
	/first pending/,
);
const firstDone = completePhase(
	twoPending,
	firstPendingPhase(twoPending)!,
	null,
);
const replanned = replacePendingOutline(firstDone, input([phase("Repair")]));
assert.deepEqual(
	replanned.phases[0],
	firstDone.phases[0],
	"completed records are immutable",
);
assert.equal(replanned.phases[1].id, "P3");
assert.equal(firstPendingPhase(replanned)?.id, "P3");

const invalidOrder: OutlineStore = {
	...firstDone,
	phases: [twoPending.phases[0], firstDone.phases[0]],
};
assert.match(
	validateOutlineStore(invalidOrder).join("\n"),
	/immutable prefix|duplicate/,
);
const unsafeId: OutlineStore = {
	...one,
	next_phase_id: Number.MAX_SAFE_INTEGER,
	phases: [{ ...one.phases[0], id: `P${Number.MAX_SAFE_INTEGER - 1}` }],
};
assert.deepEqual(validateOutlineStore(unsafeId), []);
assert.throws(
	() => replacePendingOutline(unsafeId, input([phase("Overflow")])),
	/MAX_SAFE_INTEGER/,
);

const provenance = {
	repo: "/repo",
	branch: "feature/outline",
	sha: "0123456789abcdef",
};
const rendered = renderOutline(noCode, provenance);
assert.equal(
	renderOutline(noCode, provenance),
	rendered,
	"rendering is deterministic",
);
assert.match(
	rendered,
	/^---\nrepo: \/repo\nbranch: feature\/outline\nsha: 0123456789abcdef\n---/,
);
assert.match(
	rendered,
	/- \[x\] Phase 1: Add parser\n- \[x\] Phase 2: Documentation review/,
);
assert.match(rendered, /## Phase 1: Add parser/);
assert.match(
	rendered,
	/Resolution: Existing documentation already satisfies the design\./,
);
assert.equal((rendered.match(/Resolution:/g) ?? []).length, 1);
assert.match(rendered, /\*\*`src\/parser\.ts`\*\*: Add parse\(\)\./);

console.log("rpi structured outline: ok");
