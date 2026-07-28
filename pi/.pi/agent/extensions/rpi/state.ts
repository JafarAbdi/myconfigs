import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { type PendingPhase, validPendingPhase } from "./outline.ts";

export const STATE_VERSION = 5 as const;
export const CANCELLED = Symbol("cancelled");

export const PHASES = [
	"creating",
	"questions",
	"research",
	"design",
	"outline",
	"build",
	"closing",
	"staging",
	"committing",
	"pr",
	"done",
	"deleting",
] as const;
export type Phase = (typeof PHASES)[number];

type PlainPhase = Extract<Phase, "questions" | "research" | "design" | "done">;

interface Identity {
	version: typeof STATE_VERSION;
	baseBranch: string;
}

export interface CreatingTaskState extends Identity {
	phase: "creating";
	sourceRoot: string;
}

export interface PlainTaskState extends Identity {
	phase: PlainPhase;
}

export interface OutlineTaskState extends Identity {
	phase: "outline";
	submitted: boolean;
	session: string;
}

export interface DeletingTaskState extends Identity {
	phase: "deleting";
	gitDirectory: string;
}

type RunOwnership =
	| { status: "pending"; session?: never }
	| { status: "active"; session: string };

interface PhaseSnapshot {
	phaseSnapshot: PendingPhase;
}

export interface BuildTaskState extends Identity {
	phase: "build";
	build: RunOwnership & PhaseSnapshot;
}

export interface ClosingTaskState extends Identity, PhaseSnapshot {
	phase: "closing";
	session: string;
	resolution: string;
}

export interface StagingTaskState extends Identity, PhaseSnapshot {
	phase: "staging";
	session: string;
	parent: string;
	paths: string[];
}

export interface CommittingTaskState extends Identity, PhaseSnapshot {
	phase: "committing";
	session: string;
	parent: string;
	tree?: string;
}

export interface PrTaskState extends Identity {
	phase: "pr";
	pr: RunOwnership;
}

export type TaskState =
	| CreatingTaskState
	| PlainTaskState
	| OutlineTaskState
	| DeletingTaskState
	| BuildTaskState
	| ClosingTaskState
	| StagingTaskState
	| CommittingTaskState
	| PrTaskState;
export type LoadedState =
	| { kind: "missing" }
	| { kind: "malformed" }
	| { kind: "valid"; state: TaskState };

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === allowed.length && keys.every((key) => allowed.includes(key))
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function safeRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!posix.isAbsolute(path) &&
		!path.includes("\0") &&
		path !== "." &&
		path !== ".." &&
		posix.normalize(path) === path &&
		!path.startsWith("../")
	);
}

export function invariantError(expected: string, found: string): Error {
	return new Error(
		`RPI invariant failed\n\nExpected: ${expected}\n\nFound: ${found}\n\nRPI stopped without attempting repair.`,
	);
}

function validPhaseSnapshot(value: Record<string, unknown>): boolean {
	return validPendingPhase(value.phaseSnapshot);
}

function safePaths(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(path, index) =>
				typeof path === "string" &&
				safeRelativePath(path) &&
				(index === 0 || value[index - 1] < path),
		)
	);
}

export function parseTaskState(value: unknown): TaskState | undefined {
	const state = record(value);
	const identityKeys = ["version", "phase", "baseBranch"];
	if (
		!state ||
		state.version !== STATE_VERSION ||
		typeof state.phase !== "string" ||
		!PHASES.includes(state.phase as Phase) ||
		typeof state.baseBranch !== "string" ||
		state.baseBranch.length === 0
	) {
		return undefined;
	}

	if (state.phase === "creating" || state.phase === "deleting") {
		const field = state.phase === "creating" ? "sourceRoot" : "gitDirectory";
		if (
			!exactKeys(state, [...identityKeys, field]) ||
			typeof state[field] !== "string" ||
			!isAbsolute(state[field])
		)
			return undefined;
		return state as unknown as CreatingTaskState | DeletingTaskState;
	}

	if (state.phase === "build") {
		const build = record(state.build);
		const buildKeys =
			build?.status === "active"
				? ["phaseSnapshot", "status", "session"]
				: ["phaseSnapshot", "status"];
		if (
			!exactKeys(state, [...identityKeys, "build"]) ||
			!build ||
			!exactKeys(build, buildKeys) ||
			!validPhaseSnapshot(build) ||
			(build.status !== "pending" && build.status !== "active") ||
			(build.status === "active" &&
				(typeof build.session !== "string" || !isAbsolute(build.session)))
		) {
			return undefined;
		}
		return state as unknown as BuildTaskState;
	}

	if (state.phase === "closing") {
		if (
			!exactKeys(state, [
				...identityKeys,
				"phaseSnapshot",
				"session",
				"resolution",
			]) ||
			!validPhaseSnapshot(state) ||
			typeof state.session !== "string" ||
			!isAbsolute(state.session) ||
			typeof state.resolution !== "string" ||
			state.resolution.length === 0 ||
			state.resolution !== state.resolution.trim().replace(/\s+/g, " ")
		) {
			return undefined;
		}
		return state as unknown as ClosingTaskState;
	}

	if (state.phase === "staging") {
		if (
			!exactKeys(state, [
				...identityKeys,
				"phaseSnapshot",
				"session",
				"parent",
				"paths",
			]) ||
			!validPhaseSnapshot(state) ||
			typeof state.session !== "string" ||
			!isAbsolute(state.session) ||
			typeof state.parent !== "string" ||
			!SHA.test(state.parent) ||
			!safePaths(state.paths)
		) {
			return undefined;
		}
		return state as unknown as StagingTaskState;
	}

	if (state.phase === "committing") {
		const keys = [
			...identityKeys,
			"phaseSnapshot",
			"session",
			"parent",
		];
		if (
			(!exactKeys(state, keys) && !exactKeys(state, [...keys, "tree"])) ||
			!validPhaseSnapshot(state) ||
			typeof state.session !== "string" ||
			!isAbsolute(state.session) ||
			typeof state.parent !== "string" ||
			!SHA.test(state.parent) ||
			(Object.hasOwn(state, "tree") &&
				(typeof state.tree !== "string" || !SHA.test(state.tree)))
		) {
			return undefined;
		}
		return state as unknown as CommittingTaskState;
	}

	if (state.phase === "outline") {
		if (
			!exactKeys(state, [...identityKeys, "submitted", "session"]) ||
			typeof state.submitted !== "boolean" ||
			typeof state.session !== "string" ||
			!isAbsolute(state.session)
		)
			return undefined;
		return state as unknown as OutlineTaskState;
	}

	if (state.phase === "pr") {
		const pr = record(state.pr);
		const prKeys = pr?.status === "active" ? ["status", "session"] : ["status"];
		if (
			!exactKeys(state, [...identityKeys, "pr"]) ||
			!pr ||
			!exactKeys(pr, prKeys) ||
			(pr.status !== "pending" && pr.status !== "active") ||
			(pr.status === "active" &&
				(typeof pr.session !== "string" || !isAbsolute(pr.session)))
		) {
			return undefined;
		}
		return state as unknown as PrTaskState;
	}

	if (!exactKeys(state, identityKeys)) return undefined;
	return state as unknown as PlainTaskState;
}

export function loadTaskState(path: string): LoadedState {
	if (!existsSync(path)) return { kind: "missing" };
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "malformed" };
		const state = parseTaskState(JSON.parse(readFileSync(path, "utf-8")));
		return state ? { kind: "valid", state } : { kind: "malformed" };
	} catch {
		return { kind: "malformed" };
	}
}

export function identityState(
	baseBranch: string,
	sourceRoot: string,
): CreatingTaskState {
	return { version: STATE_VERSION, phase: "creating", baseBranch, sourceRoot };
}

function identityOf(state: TaskState): Identity {
	return { version: STATE_VERSION, baseBranch: state.baseBranch };
}

export function plainState(
	state: TaskState,
	phase: PlainPhase,
): PlainTaskState {
	return { ...identityOf(state), phase };
}

export function outlineState(
	state: TaskState,
	session: string,
	submitted = false,
): OutlineTaskState {
	return { ...identityOf(state), phase: "outline", submitted, session };
}

function phaseSnapshot(phase: PendingPhase): PhaseSnapshot {
	return { phaseSnapshot: phase };
}

export function buildState(
	state: TaskState,
	phase: PendingPhase,
): BuildTaskState {
	return {
		...identityOf(state),
		phase: "build",
		build: { ...phaseSnapshot(phase), status: "pending" },
	};
}

export function activeBuildState(
	state: TaskState,
	phase: PendingPhase,
	session: string,
): BuildTaskState {
	return {
		...buildState(state, phase),
		build: { ...phaseSnapshot(phase), status: "active", session },
	};
}

export function closingState(
	state: TaskState,
	phase: PendingPhase,
	session: string,
	resolution: string,
): ClosingTaskState {
	return {
		...identityOf(state),
		phase: "closing",
		...phaseSnapshot(phase),
		session,
		resolution,
	};
}

export function stagingState(
	state: TaskState,
	phase: PendingPhase,
	session: string,
	parent: string,
	paths: string[],
): StagingTaskState {
	return {
		...identityOf(state),
		phase: "staging",
		...phaseSnapshot(phase),
		session,
		parent,
		paths,
	};
}

export function committingState(
	state: TaskState,
	phase: PendingPhase,
	session: string,
	parent: string,
	tree: string,
): CommittingTaskState {
	return {
		...identityOf(state),
		phase: "committing",
		...phaseSnapshot(phase),
		session,
		parent,
		tree,
	};
}

export function prState(state: TaskState): PrTaskState {
	return { ...identityOf(state), phase: "pr", pr: { status: "pending" } };
}

export function activePrState(state: TaskState, session: string): PrTaskState {
	return {
		...prState(state),
		pr: { status: "active", session },
	};
}

export function deletingState(
	state: TaskState,
	gitDirectory: string,
): DeletingTaskState {
	return { ...identityOf(state), phase: "deleting", gitDirectory };
}

export type RunDecision = "full" | "resume" | "gate";

export function activeBranchMessageCount(
	entries: readonly { type: string }[],
): number {
	return entries.filter((entry) => entry.type === "message").length;
}

export function decidePersistedRun(
	messageCount: number,
	location: "current" | "other",
): RunDecision {
	if (messageCount === 0) return "full";
	return location === "current" ? "gate" : "resume";
}

export function decideSessionPrompt(
	messageCount: number,
	feedback: "none" | "provided",
): "full" | "continuation" | "resume" {
	if (messageCount === 0) return "full";
	return feedback === "provided" ? "continuation" : "resume";
}

export function createTask(
	tasks: string,
	slug: string,
	ticket: string,
	state: TaskState,
): void {
	mkdirSync(tasks, { recursive: true, mode: 0o700 });
	const target = join(tasks, slug);
	try {
		mkdirSync(target, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(
				`${target} already exists; remove or repair it before creating this task`,
			);
		}
		throw error;
	}
	try {
		writeFileSync(join(target, "ticket.md"), ticket, {
			mode: 0o600,
			flag: "wx",
		});
		// state.json is the creation commit marker. A task without it is invalid and never inferred.
		writeFileSync(
			join(target, "state.json"),
			`${JSON.stringify(state, null, 2)}\n`,
			{
				mode: 0o600,
				flag: "wx",
			},
		);
	} catch (error) {
		rmSync(target, { recursive: true, force: true });
		throw error;
	}
}
