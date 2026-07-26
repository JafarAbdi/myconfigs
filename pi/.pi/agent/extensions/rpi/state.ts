import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export const STATE_VERSION = 3 as const;
export const CANCELLED = Symbol("cancelled");

export const PHASES = [
	"questions",
	"research",
	"design",
	"outline",
	"branch",
	"build",
	"pr",
	"done",
] as const;
export type Phase = (typeof PHASES)[number];

type PlainPhase = Exclude<Phase, "build" | "pr">;

interface Identity {
	version: typeof STATE_VERSION;
	gitCommonDir: string;
	baseSha: string;
}

export interface PlainTaskState extends Identity {
	phase: PlainPhase;
}

export interface CommitState {
	parent: string;
	diff: string;
	phaseLine: string;
}

type RunOwnership =
	| { status: "pending"; session?: string }
	| { status: "active"; session: string };

export interface BuildTaskState extends Identity {
	phase: "build";
	build: RunOwnership & { phaseLine: string };
	commit?: CommitState;
}

export interface PrTaskState extends Identity {
	phase: "pr";
	pr: RunOwnership & { head: string };
}

export type TaskState = PlainTaskState | BuildTaskState | PrTaskState;
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

export function parseTaskState(value: unknown): TaskState | undefined {
	const state = record(value);
	if (
		!state ||
		state.version !== STATE_VERSION ||
		typeof state.phase !== "string" ||
		!PHASES.includes(state.phase as Phase) ||
		typeof state.gitCommonDir !== "string" ||
		!state.gitCommonDir.startsWith("/") ||
		typeof state.baseSha !== "string" ||
		!SHA.test(state.baseSha)
	) {
		return undefined;
	}

	if (state.phase === "build") {
		const allowed =
			state.commit === undefined
				? ["version", "phase", "gitCommonDir", "baseSha", "build"]
				: ["version", "phase", "gitCommonDir", "baseSha", "build", "commit"];
		const build = record(state.build);
		const buildKeys =
			build?.session === undefined
				? ["phaseLine", "status"]
				: ["phaseLine", "status", "session"];
		if (
			!exactKeys(state, allowed) ||
			!build ||
			!exactKeys(build, buildKeys) ||
			typeof build.phaseLine !== "string" ||
			!PHASE_LINE.test(build.phaseLine) ||
			(build.status !== "pending" && build.status !== "active") ||
			(build.status === "active" && build.session === undefined) ||
			(build.session !== undefined &&
				(typeof build.session !== "string" || !isAbsolute(build.session)))
		) {
			return undefined;
		}
		if (state.commit !== undefined) {
			const commit = record(state.commit);
			if (
				build.status !== "active" ||
				!commit ||
				!exactKeys(commit, ["parent", "diff", "phaseLine"]) ||
				typeof commit.parent !== "string" ||
				!SHA.test(commit.parent) ||
				typeof commit.diff !== "string" ||
				!/^[0-9a-f]{64}$/.test(commit.diff) ||
				commit.phaseLine !== build.phaseLine
			) {
				return undefined;
			}
		}
		return state as unknown as BuildTaskState;
	}

	if (state.phase === "pr") {
		const pr = record(state.pr);
		const prKeys =
			pr?.session === undefined
				? ["head", "status"]
				: ["head", "status", "session"];
		if (
			!exactKeys(state, [
				"version",
				"phase",
				"gitCommonDir",
				"baseSha",
				"pr",
			]) ||
			!pr ||
			!exactKeys(pr, prKeys) ||
			typeof pr.head !== "string" ||
			!SHA.test(pr.head) ||
			(pr.status !== "pending" && pr.status !== "active") ||
			(pr.status === "active" && pr.session === undefined) ||
			(pr.session !== undefined &&
				(typeof pr.session !== "string" || !isAbsolute(pr.session)))
		) {
			return undefined;
		}
		return state as unknown as PrTaskState;
	}

	if (!exactKeys(state, ["version", "phase", "gitCommonDir", "baseSha"]))
		return undefined;
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
	gitCommonDir: string,
	baseSha: string,
	phase: PlainPhase = "questions",
): PlainTaskState {
	return { version: STATE_VERSION, phase, gitCommonDir, baseSha };
}

export function plainState(
	state: TaskState,
	phase: PlainPhase,
): PlainTaskState {
	return identityState(state.gitCommonDir, state.baseSha, phase);
}

export function buildState(
	state: TaskState,
	phaseLine: string,
	session?: string,
): BuildTaskState {
	return {
		version: STATE_VERSION,
		phase: "build",
		gitCommonDir: state.gitCommonDir,
		baseSha: state.baseSha,
		build: session
			? { phaseLine, status: "pending", session }
			: { phaseLine, status: "pending" },
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

export function prState(
	state: TaskState,
	head: string,
	session?: string,
): PrTaskState {
	return {
		version: STATE_VERSION,
		phase: "pr",
		gitCommonDir: state.gitCommonDir,
		baseSha: state.baseSha,
		pr: session
			? { head, status: "pending", session }
			: { head, status: "pending" },
	};
}

export function activePrState(
	state: TaskState,
	head: string,
	session: string,
): PrTaskState {
	return {
		...prState(state, head),
		pr: { head, status: "active", session },
	};
}

export type RunDecision = "full" | "continuation" | "resume" | "gate";

export function activeBranchMessageCount(
	entries: readonly { type: string }[],
): number {
	return entries.filter((entry) => entry.type === "message").length;
}

export function decidePersistedRun(
	status: "pending" | "active",
	messageCount: number,
	location: "current" | "other",
): RunDecision {
	if (messageCount === 0) return "full";
	if (status === "pending") return "continuation";
	return location === "current" ? "gate" : "resume";
}

export function decideSessionPrompt(
	messageCount: number,
	feedback: "none" | "provided",
): "full" | "continuation" | "resume" {
	if (messageCount === 0) return "full";
	return feedback === "provided" ? "continuation" : "resume";
}

export function prNeedsRestart(state: PrTaskState, head: string): boolean {
	return state.pr.head !== head;
}

export interface ObservedRepository {
	gitCommonDir: string;
	base: "present" | "missing";
	branch?: string;
	ancestry?: "valid" | "invalid";
}

export function repositoryProblem(
	state: TaskState,
	observed: ObservedRepository,
	requiredBranch?: string,
): string | undefined {
	if (observed.gitCommonDir !== state.gitCommonDir) return "wrong-repository";
	if (observed.base === "missing") return "missing-base";
	if (requiredBranch && observed.branch !== requiredBranch)
		return "wrong-branch";
	if (requiredBranch && observed.ancestry !== "valid")
		return "base-not-ancestor";
	return undefined;
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
