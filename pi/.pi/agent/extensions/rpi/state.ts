import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix } from "node:path";

export const STATE_VERSION = 4 as const;
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

type PlainPhase = Extract<
	Phase,
	"questions" | "research" | "design" | "outline" | "done"
>;

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

export interface DeletingTaskState extends Identity {
	phase: "deleting";
	gitDirectory: string;
}

type RunOwnership =
	| { status: "pending"; session?: never }
	| { status: "active"; session: string };

export interface BuildTaskState extends Identity {
	phase: "build";
	build: RunOwnership & { phaseLine: string };
}

export interface ClosingTaskState extends Identity {
	phase: "closing";
	phaseLine: string;
	session: string;
	resolution: string;
}

export interface StagingTaskState extends Identity {
	phase: "staging";
	phaseLine: string;
	session: string;
	parent: string;
	paths: string[];
}

export interface CommittingTaskState extends Identity {
	phase: "committing";
	phaseLine: string;
	session: string;
	parent: string;
}

export interface PrTaskState extends Identity {
	phase: "pr";
	pr: RunOwnership;
}

export type TaskState =
	| CreatingTaskState
	| PlainTaskState
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
const PHASE_LINE = /^- \[ \] Phase \d+: [^\r\n]+$/;

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
				? ["phaseLine", "status", "session"]
				: ["phaseLine", "status"];
		if (
			!exactKeys(state, [...identityKeys, "build"]) ||
			!build ||
			!exactKeys(build, buildKeys) ||
			typeof build.phaseLine !== "string" ||
			!PHASE_LINE.test(build.phaseLine) ||
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
				"phaseLine",
				"session",
				"resolution",
			]) ||
			typeof state.phaseLine !== "string" ||
			!PHASE_LINE.test(state.phaseLine) ||
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
				"phaseLine",
				"session",
				"parent",
				"paths",
			]) ||
			typeof state.phaseLine !== "string" ||
			!PHASE_LINE.test(state.phaseLine) ||
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
		if (
			!exactKeys(state, [...identityKeys, "phaseLine", "session", "parent"]) ||
			typeof state.phaseLine !== "string" ||
			!PHASE_LINE.test(state.phaseLine) ||
			typeof state.session !== "string" ||
			!isAbsolute(state.session) ||
			typeof state.parent !== "string" ||
			!SHA.test(state.parent)
		) {
			return undefined;
		}
		return state as unknown as CommittingTaskState;
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

export function buildState(
	state: TaskState,
	phaseLine: string,
): BuildTaskState {
	return {
		...identityOf(state),
		phase: "build",
		build: { phaseLine, status: "pending" },
	};
}

export function activeBuildState(
	state: TaskState,
	phaseLine: string,
	session: string,
): BuildTaskState {
	return {
		...buildState(state, phaseLine),
		build: { phaseLine, status: "active", session },
	};
}

export function closingState(
	state: TaskState,
	phaseLine: string,
	session: string,
	resolution: string,
): ClosingTaskState {
	return {
		...identityOf(state),
		phase: "closing",
		phaseLine,
		session,
		resolution,
	};
}

export function stagingState(
	state: TaskState,
	phaseLine: string,
	session: string,
	parent: string,
	paths: string[],
): StagingTaskState {
	return {
		...identityOf(state),
		phase: "staging",
		phaseLine,
		session,
		parent,
		paths,
	};
}

export function committingState(
	state: TaskState,
	phaseLine: string,
	session: string,
	parent: string,
): CommittingTaskState {
	return {
		...identityOf(state),
		phase: "committing",
		phaseLine,
		session,
		parent,
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
