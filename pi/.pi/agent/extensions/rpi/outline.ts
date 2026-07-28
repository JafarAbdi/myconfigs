import { posix } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const textSchema = Type.String({ minLength: 1 });
const titleSchema = Type.String({ minLength: 1 });
const fileChangeSchema = Type.Object(
	{ path: titleSchema, change: textSchema },
	{ additionalProperties: false },
);

export const pendingPhaseInputSchema = Type.Object(
	{
		title: titleSchema,
		summary: textSchema,
		file_changes: Type.Array(fileChangeSchema),
		verification: Type.Array(textSchema),
	},
	{ additionalProperties: false },
);

const phaseIdSchema = Type.String({ pattern: "^P[1-9][0-9]*$" });

const phaseRevisionContent = {
	title: titleSchema,
	summary: textSchema,
	file_changes: Type.Array(fileChangeSchema),
	verification: Type.Array(textSchema),
};

export const pendingPhaseRevisionSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("keep"), id: phaseIdSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("revise"), id: phaseIdSchema, ...phaseRevisionContent },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("add"), ...phaseRevisionContent },
		{ additionalProperties: false },
	),
]);

const overviewRevisionSchema = Type.Union([
	Type.Object({ kind: Type.Literal("keep") }, { additionalProperties: false }),
	Type.Object(
		{
			kind: Type.Literal("revise"),
			title: titleSchema,
			summary: textSchema,
			desired_end_state: textSchema,
		},
		{ additionalProperties: false },
	),
]);

export const outlineRevisionSchema = Type.Object(
	{
		overview: overviewRevisionSchema,
		pending: Type.Array(pendingPhaseRevisionSchema),
		removed_pending_ids: Type.Array(phaseIdSchema),
	},
	{ additionalProperties: false },
);

export const setOutlineSchema = Type.Object(
	{
		task_slug: Type.String({
			minLength: 1,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		...outlineRevisionSchema.properties,
	},
	{ additionalProperties: false },
);

const phaseContent = {
	id: phaseIdSchema,
	title: titleSchema,
	summary: textSchema,
	file_changes: Type.Array(fileChangeSchema),
	verification: Type.Array(textSchema),
};

export const outlinePhaseSchema = Type.Union([
	Type.Object(
		{
			...phaseContent,
			status: Type.Literal("pending"),
			resolution: Type.Null(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...phaseContent,
			status: Type.Literal("completed"),
			resolution: Type.Union([Type.Null(), textSchema]),
		},
		{ additionalProperties: false },
	),
]);

export const outlineStoreSchema = Type.Object(
	{
		version: Type.Literal(1),
		next_phase_id: Type.Integer({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
		title: Type.String(),
		summary: Type.String(),
		desired_end_state: Type.String(),
		phases: Type.Array(outlinePhaseSchema),
	},
	{ additionalProperties: false },
);

export type PendingPhaseInput = Static<typeof pendingPhaseInputSchema>;
export type PendingPhaseRevision = Static<typeof pendingPhaseRevisionSchema>;
export type OutlineRevision = Static<typeof outlineRevisionSchema>;
export type SetOutlineInput = Static<typeof setOutlineSchema>;
export type OutlinePhase = Static<typeof outlinePhaseSchema>;
export type PendingPhase = Extract<OutlinePhase, { status: "pending" }>;
export type OutlineStore = Static<typeof outlineStoreSchema>;
export type OutlineProvenance = { repo: string; branch: string; sha: string };
export type OutlineRenderMode = "approved" | "candidate";

export interface OutlineChanges {
	overview: boolean;
	kept: number;
	revised: number;
	removed: number;
	added: number;
	reordered: boolean;
}

export interface AppliedOutlineRevision {
	outline: OutlineStore;
	changes: OutlineChanges;
}

export const EMPTY_OUTLINE_STORE: OutlineStore = {
	version: 1,
	next_phase_id: 1,
	title: "",
	summary: "",
	desired_end_state: "",
	phases: [],
};

function textProblem(value: string, singleLine = false): string | undefined {
	if (!value.trim()) return "must not be empty";
	if (value !== value.trim()) return "must not have surrounding whitespace";
	if (singleLine && /[\r\n\u2028\u2029]/u.test(value))
		return "must be a single line";
	if (/\p{Cc}/u.test(value)) return "must not contain control characters";
	return undefined;
}

export function safeRepositoryPath(path: string): boolean {
	return (
		!textProblem(path, true) &&
		!path.includes("\\") &&
		!posix.isAbsolute(path) &&
		path !== "." &&
		path !== ".." &&
		!path.startsWith("../") &&
		posix.normalize(path) === path
	);
}

function contentProblems(content: PendingPhaseInput, label: string): string[] {
	const errors: string[] = [];
	for (const [name, value, singleLine] of [
		["title", content.title, true],
		["summary", content.summary, false],
	] as const) {
		const problem = textProblem(value, singleLine);
		if (problem) errors.push(`${label} ${name} ${problem}`);
	}
	content.file_changes.forEach((change, index) => {
		if (!safeRepositoryPath(change.path))
			errors.push(`${label} file change ${index + 1} has an unsafe path`);
		const problem = textProblem(change.change);
		if (problem)
			errors.push(`${label} file change ${index + 1} change ${problem}`);
	});
	content.verification.forEach((command, index) => {
		const problem = textProblem(command);
		if (problem) errors.push(`${label} verification ${index + 1} ${problem}`);
	});
	return errors;
}

export function validPendingPhase(value: unknown): value is PendingPhase {
	if (!Check(outlinePhaseSchema, value) || value.status !== "pending")
		return false;
	const number = Number(value.id.slice(1));
	return (
		Number.isSafeInteger(number) &&
		number >= 1 &&
		contentProblems(value, value.id).length === 0
	);
}

export function validateOutlineStore(value: unknown): string[] {
	if (!Check(outlineStoreSchema, value))
		return ["does not match the exact version-1 outline store schema"];
	const store = value as OutlineStore;
	const errors: string[] = [];
	const empty =
		store.next_phase_id === 1 &&
		store.phases.length === 0 &&
		store.title === "" &&
		store.summary === "" &&
		store.desired_end_state === "";
	if (empty) return errors;
	for (const [name, text, singleLine] of [
		["title", store.title, true],
		["summary", store.summary, false],
		["desired_end_state", store.desired_end_state, false],
	] as const) {
		const problem = textProblem(text, singleLine);
		if (problem) errors.push(`${name} ${problem}`);
	}
	let pending = false;
	let greatest = 0;
	const ids = new Set<number>();
	store.phases.forEach((phase, index) => {
		const number = Number(phase.id.slice(1));
		if (!Number.isSafeInteger(number) || number < 1)
			errors.push(`phase ${index + 1} has an unsafe id`);
		if (ids.has(number)) errors.push(`duplicate phase id ${phase.id}`);
		ids.add(number);
		greatest = Math.max(greatest, number);
		if (phase.status === "pending") pending = true;
		else if (pending)
			errors.push("completed phases must form an immutable prefix");
		errors.push(...contentProblems(phase, phase.id));
		if (phase.resolution !== null) {
			const problem = textProblem(phase.resolution);
			if (problem) errors.push(`${phase.id} resolution ${problem}`);
		}
	});
	if (store.next_phase_id <= greatest)
		errors.push("next_phase_id must be greater than every assigned id");
	return errors;
}

export function parseOutlineStore(json: string): OutlineStore {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new Error(
			`invalid outline JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const errors = validateOutlineStore(value);
	if (errors.length)
		throw new Error(`invalid outline store: ${errors.join("; ")}`);
	return value as OutlineStore;
}

export function serializeOutlineStore(store: OutlineStore): string {
	const errors = validateOutlineStore(store);
	if (errors.length)
		throw new Error(`invalid outline store: ${errors.join("; ")}`);
	return `${JSON.stringify(store, null, 2)}\n`;
}

export function parseOutlineRevision(json: string): OutlineRevision {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new Error(
			`invalid outline candidate JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Check(outlineRevisionSchema, value))
		throw new Error("invalid outline candidate: does not match the exact revision schema");
	return value as OutlineRevision;
}

export function serializeOutlineRevision(revision: OutlineRevision): string {
	if (!Check(outlineRevisionSchema, revision))
		throw new Error("invalid outline candidate: does not match the exact revision schema");
	return `${JSON.stringify(revision, null, 2)}\n`;
}

function sameContent(
	left: PendingPhaseInput,
	right: PendingPhaseInput,
): boolean {
	return (
		left.title === right.title &&
		left.summary === right.summary &&
		left.file_changes.length === right.file_changes.length &&
		left.file_changes.every(
			(change, index) =>
				change.path === right.file_changes[index].path &&
				change.change === right.file_changes[index].change,
		) &&
		left.verification.length === right.verification.length &&
		left.verification.every(
			(command, index) => command === right.verification[index],
		)
	);
}

export function phaseEquals(left: OutlinePhase, right: OutlinePhase): boolean {
	return (
		left.id === right.id &&
		left.status === right.status &&
		left.resolution === right.resolution &&
		sameContent(left, right)
	);
}

export function applyOutlineRevision(
	store: OutlineStore,
	input: OutlineRevision,
): AppliedOutlineRevision {
	const existing = validateOutlineStore(store);
	if (existing.length)
		throw new Error(`invalid outline store: ${existing.join("; ")}`);
	if (!Check(outlineRevisionSchema, input))
		throw new Error("outline does not match the exact revision schema");
	if (input.overview.kind === "keep" && store.title === "")
		throw new Error("initial outline must revise the empty overview");
	const problems = [
		...(input.overview.kind === "revise"
			? [
					textProblem(input.overview.title, true),
					textProblem(input.overview.summary),
					textProblem(input.overview.desired_end_state),
				]
			: []),
		...input.pending.flatMap((revision, index) =>
			revision.kind === "keep"
				? []
				: contentProblems(revision, `pending revision ${index + 1}`),
		),
	].filter(Boolean);
	if (problems.length)
		throw new Error(`invalid outline input: ${problems.join("; ")}`);

	const completed = store.phases.filter(
		(phase) => phase.status === "completed",
	);
	const pending = store.phases.slice(completed.length) as PendingPhase[];
	const pendingById = new Map(pending.map((phase) => [phase.id, phase]));
	const completedIds = new Set(completed.map((phase) => phase.id));
	const accounted = new Set<string>();
	const referenceProblems: string[] = [];
	const account = (id: string): void => {
		if (accounted.has(id)) {
			referenceProblems.push(`${id} is referenced more than once`);
			return;
		}
		accounted.add(id);
		if (completedIds.has(id))
			referenceProblems.push(`${id} is completed and immutable`);
		else if (!pendingById.has(id))
			referenceProblems.push(`${id} is not an approved pending phase`);
	};
	for (const revision of input.pending)
		if (revision.kind !== "add") account(revision.id);
	for (const id of input.removed_pending_ids) account(id);
	for (const phase of pending)
		if (!accounted.has(phase.id))
			referenceProblems.push(
				`${phase.id} must be kept, revised, or explicitly removed`,
			);
	if (referenceProblems.length)
		throw new Error(`invalid outline input: ${referenceProblems.join("; ")}`);

	const additions = input.pending.filter(
		(revision) => revision.kind === "add",
	).length;
	if (additions > Number.MAX_SAFE_INTEGER - store.next_phase_id)
		throw new Error("phase id allocation would exceed Number.MAX_SAFE_INTEGER");
	let nextId = store.next_phase_id;
	const proposedPending = input.pending.map((revision): PendingPhase => {
		if (revision.kind === "keep") return pendingById.get(revision.id)!;
		return {
			id: revision.kind === "revise" ? revision.id : `P${nextId++}`,
			status: "pending",
			title: revision.title,
			summary: revision.summary,
			file_changes: revision.file_changes.map(({ path, change }) => ({
				path,
				change,
			})),
			verification: [...revision.verification],
			resolution: null,
		};
	});
	const retainedApprovedIds = input.pending.flatMap((revision) =>
		revision.kind === "add" ? [] : [revision.id],
	);
	const approvedRetainedIds = pending
		.filter((phase) => accounted.has(phase.id) && !input.removed_pending_ids.includes(phase.id))
		.map((phase) => phase.id);
	const overview =
		input.overview.kind === "revise"
			? input.overview
			: {
					title: store.title,
					summary: store.summary,
					desired_end_state: store.desired_end_state,
				};
	return {
		outline: {
			version: 1,
			next_phase_id: nextId,
			title: overview.title,
			summary: overview.summary,
			desired_end_state: overview.desired_end_state,
			phases: [...completed, ...proposedPending],
		},
		changes: {
			overview: input.overview.kind === "revise",
			kept: input.pending.filter((revision) => revision.kind === "keep").length,
			revised: input.pending.filter((revision) => revision.kind === "revise").length,
			removed: input.removed_pending_ids.length,
			added: additions,
			reordered: retainedApprovedIds.some(
				(id, index) => id !== approvedRetainedIds[index],
			),
		},
	};
}

export function firstPendingPhase(
	store: OutlineStore,
): PendingPhase | undefined {
	const errors = validateOutlineStore(store);
	if (errors.length)
		throw new Error(`invalid outline store: ${errors.join("; ")}`);
	return store.phases.find(
		(phase): phase is PendingPhase => phase.status === "pending",
	);
}

export function completePhase(
	store: OutlineStore,
	snapshot: PendingPhase,
	resolution: string | null,
): OutlineStore {
	const errors = validateOutlineStore(store);
	if (errors.length)
		throw new Error(`invalid outline store: ${errors.join("; ")}`);
	if (resolution !== null) {
		const problem = textProblem(resolution);
		if (problem) throw new Error(`resolution ${problem}`);
	}
	const phase = store.phases.find((candidate) => candidate.id === snapshot.id);
	if (!phase || !sameContent(phase, snapshot))
		throw new Error("phase does not match the exact pending snapshot");
	if (phase.status === "completed") {
		if (phase.resolution === resolution) return store;
		throw new Error("completed phase resolution does not match recovery");
	}
	const first = firstPendingPhase(store);
	if (!first || !phaseEquals(first, snapshot))
		throw new Error("phase is not the unchanged first pending phase");
	return {
		...store,
		phases: store.phases.map((candidate) =>
			candidate.id === phase.id
				? { ...candidate, status: "completed", resolution }
				: candidate,
		),
	};
}

/** Build-facing view: identity and work only, fenced so its own content cannot escape. */
export function renderBuildPhase(phase: PendingPhase): string {
	if (!validPendingPhase(phase))
		throw new Error("phase is not a valid pending outline phase");
	const payload = JSON.stringify(
		{
			id: phase.id,
			title: phase.title,
			summary: phase.summary,
			file_changes: phase.file_changes,
			verification: phase.verification,
		},
		null,
		2,
	);
	const longest = Math.max(
		0,
		...[...payload.matchAll(/`+/gu)].map((match) => match[0].length),
	);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}json\n${payload}\n${fence}`;
}

export function renderOutline(
	store: OutlineStore,
	provenance: OutlineProvenance,
	mode: OutlineRenderMode = "approved",
): string {
	const errors = validateOutlineStore(store);
	if (errors.length)
		throw new Error(`invalid outline store: ${errors.join("; ")}`);
	const overview = store.phases
		.map(
			(phase, index) =>
				`- [${phase.status === "completed" ? "x" : " "}] Phase ${index + 1} (${phase.id}): ${phase.title}`,
		)
		.join("\n");
	const sections = store.phases
		.map((phase, index) => {
			const resolution =
				phase.resolution === null ? "" : `\nResolution: ${phase.resolution}\n`;
			const changes = phase.file_changes.length
				? phase.file_changes
						.map((change) => `- **\`${change.path}\`**: ${change.change}`)
						.join("\n")
				: "- None.";
			const verification = phase.verification.length
				? phase.verification.map((item) => `- ${item}`).join("\n")
				: "- None.";
			return `## Phase ${index + 1} (${phase.id}): ${phase.title}\n${resolution}\n${phase.summary}\n\n### File Changes\n\n${changes}\n\n### Verification\n\n${verification}`;
		})
		.join("\n\n---\n\n");
	const banner =
		mode === "candidate"
			? "> **Awaiting approval — this candidate is not executable work.**\n\n"
			: "";
	return `---\nrepo: ${provenance.repo}\nbranch: ${provenance.branch}\nsha: ${provenance.sha}\n---\n\n${banner}# ${store.title}\n\n${store.summary}\n\n## Desired End State\n\n${store.desired_end_state}\n\n## Implementation Overview\n\n${overview}${sections ? `\n\n---\n\n${sections}` : ""}\n`;
}
