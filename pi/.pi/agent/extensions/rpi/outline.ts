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

export const setOutlineSchema = Type.Object(
	{
		task_slug: Type.String({
			minLength: 1,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		}),
		title: titleSchema,
		summary: textSchema,
		desired_end_state: textSchema,
		pending_phases: Type.Array(pendingPhaseInputSchema),
	},
	{ additionalProperties: false },
);

const phaseContent = {
	id: Type.String({ pattern: "^P[1-9][0-9]*$" }),
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
export type SetOutlineInput = Static<typeof setOutlineSchema>;
export type OutlinePhase = Static<typeof outlinePhaseSchema>;
export type PendingPhase = Extract<OutlinePhase, { status: "pending" }>;
export type OutlineStore = Static<typeof outlineStoreSchema>;
export type OutlineProvenance = { repo: string; branch: string; sha: string };

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
		if (number <= greatest)
			errors.push("phase ids must increase monotonically");
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

function sameContent(
	left: PendingPhaseInput,
	right: PendingPhaseInput,
): boolean {
	return (
		JSON.stringify({
			title: left.title,
			summary: left.summary,
			file_changes: left.file_changes,
			verification: left.verification,
		}) ===
		JSON.stringify({
			title: right.title,
			summary: right.summary,
			file_changes: right.file_changes,
			verification: right.verification,
		})
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

export function replacePendingOutline(
	store: OutlineStore,
	input: SetOutlineInput,
): OutlineStore {
	const existing = validateOutlineStore(store);
	if (existing.length)
		throw new Error(`invalid outline store: ${existing.join("; ")}`);
	if (!Check(setOutlineSchema, input))
		throw new Error("outline does not match the exact tool input schema");
	const topProblems = [
		textProblem(input.title, true),
		textProblem(input.summary),
		textProblem(input.desired_end_state),
	].filter(Boolean);
	const phaseProblems = input.pending_phases.flatMap((phase, index) =>
		contentProblems(phase, `pending phase ${index + 1}`),
	);
	if (topProblems.length || phaseProblems.length)
		throw new Error(
			`invalid outline input: ${[...topProblems, ...phaseProblems].join("; ")}`,
		);
	const completed = store.phases.filter(
		(phase) => phase.status === "completed",
	);
	const pending = store.phases.slice(completed.length) as PendingPhase[];
	if (
		pending.length === input.pending_phases.length &&
		pending.every((phase, index) =>
			sameContent(phase, input.pending_phases[index]),
		)
	) {
		return store.title === input.title &&
			store.summary === input.summary &&
			store.desired_end_state === input.desired_end_state
			? store
			: {
					...store,
					title: input.title,
					summary: input.summary,
					desired_end_state: input.desired_end_state,
				};
	}
	if (
		input.pending_phases.length >
		Number.MAX_SAFE_INTEGER - store.next_phase_id
	)
		throw new Error("phase id allocation would exceed Number.MAX_SAFE_INTEGER");
	const replacements: PendingPhase[] = input.pending_phases.map(
		(phase, index) => ({
			id: `P${store.next_phase_id + index}`,
			status: "pending",
			title: phase.title,
			summary: phase.summary,
			file_changes: phase.file_changes.map((change) => ({ ...change })),
			verification: [...phase.verification],
			resolution: null,
		}),
	);
	return {
		version: 1,
		next_phase_id: store.next_phase_id + replacements.length,
		title: input.title,
		summary: input.summary,
		desired_end_state: input.desired_end_state,
		phases: [...completed, ...replacements],
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

export function renderOutline(
	store: OutlineStore,
	provenance: OutlineProvenance,
): string {
	const errors = validateOutlineStore(store);
	if (errors.length)
		throw new Error(`invalid outline store: ${errors.join("; ")}`);
	const overview = store.phases
		.map(
			(phase, index) =>
				`- [${phase.status === "completed" ? "x" : " "}] Phase ${index + 1}: ${phase.title}`,
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
			return `## Phase ${index + 1}: ${phase.title}\n${resolution}\n${phase.summary}\n\n### File Changes\n\n${changes}\n\n### Verification\n\n${verification}`;
		})
		.join("\n\n---\n\n");
	return `---\nrepo: ${provenance.repo}\nbranch: ${provenance.branch}\nsha: ${provenance.sha}\n---\n\n# ${store.title}\n\n${store.summary}\n\n## Desired End State\n\n${store.desired_end_state}\n\n## Implementation Overview\n\n${overview}${sections ? `\n\n---\n\n${sections}` : ""}\n`;
}
