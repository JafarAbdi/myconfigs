import { spawn, type ChildProcess } from "node:child_process";

/**
 * Thin async adapter over the installed `wiff` public CLI. Owns only process
 * transport, exact `No sessions.` absence detection, and schema-6 JSON
 * validation. It parses no Markdown, reads no Wiff journal, and never blocks
 * on a timer: cancellation is AbortSignal-only, so a hung `wiff` hangs until
 * aborted.
 */

const WIFF_BINARY = "wiff";
const WIFF_SCHEMA_VERSION = 6;
const NO_SESSIONS = "No sessions.";

export interface WiffProjectOptions {
	readonly project: string;
	readonly repositoryRoot: string;
	readonly signal?: AbortSignal;
}

export interface WiffAuthor {
	readonly name: string;
	readonly kind: "human" | "agent";
}

export interface WiffComment {
	readonly id: string;
	readonly resolved: boolean;
	readonly deleted: boolean;
	readonly author: WiffAuthor;
}

export interface WiffVerdict {
	readonly author: WiffAuthor;
	readonly disposition: "approve" | "request_changes";
}

export interface WiffState {
	readonly session: {
		readonly id: string;
		readonly project: string;
	};
	readonly comments: readonly WiffComment[];
	readonly verdicts: readonly WiffVerdict[];
}

export interface CreateWiffSessionOptions extends WiffProjectOptions {
	readonly patch: Buffer;
	readonly description: string;
}

export interface RefreshWiffSessionOptions extends WiffProjectOptions {
	readonly patch: Buffer;
}

export interface AddWiffCommentOptions extends WiffProjectOptions {
	readonly session: string;
	readonly author: string;
	readonly file: string;
	readonly line: number;
	readonly side?: "before" | "after";
	readonly body: string;
}

export interface RemoveWiffSessionOptions extends WiffProjectOptions {
	readonly session: string;
}

export interface WiffTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

export interface ResumeWiffOptions extends WiffProjectOptions {
	readonly tui: WiffTui;
}

function wiffSpawnError(error: unknown): Error {
	const code = error && typeof error === "object" && "code" in error
		? (error as { code?: unknown }).code
		: undefined;
	if (code === "ENOENT")
		return new Error("wiff is not installed or not on PATH; install the Wiff CLI to use /review");
	return new Error(
		`wiff failed to start: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
}

interface WiffCommandResult {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly code: number | null;
}

interface RunWiffOptions {
	readonly cwd: string;
	readonly input?: Buffer;
	readonly signal?: AbortSignal;
}

interface WiffExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

function waitForWiffChild(child: ChildProcess, signal?: AbortSignal): Promise<WiffExit> {
	return new Promise((resolvePromise, reject) => {
		child.once("error", (error) => {
			reject(signal?.aborted ? (signal.reason ?? error) : wiffSpawnError(error));
		});
		child.once("close", (code, exitSignal) => resolvePromise({ code, signal: exitSignal }));
	});
}

async function runWiff(args: readonly string[], options: RunWiffOptions): Promise<WiffCommandResult> {
	options.signal?.throwIfAborted();
	const child = spawn(WIFF_BINARY, args, {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		signal: options.signal,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let stdinError: Error | undefined;
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.stdin.once("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") return;
		stdinError = new Error(`wiff stdin failed: ${error.message}`, { cause: error });
		child.kill();
	});
	const completed = waitForWiffChild(child, options.signal);
	child.stdin.end(options.input ?? Buffer.alloc(0));
	const { code } = await completed;
	if (stdinError) throw stdinError;
	return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code };
}

function requireSuccess(result: WiffCommandResult, label: string): void {
	if (result.code === 0) return;
	const detail = result.stderr.toString("utf8").trim();
	throw new Error(`${label} failed (exit ${result.code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
}

export function deriveWiffProject(piSessionId: string): string {
	if (typeof piSessionId !== "string" || piSessionId.length === 0)
		throw new Error("Wiff project requires a non-empty full Pi session ID");
	return `pi-review-${piSessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`Wiff JSON state ${label} must be a non-empty string`);
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`Wiff JSON state ${label} must be a boolean`);
	return value;
}

function parseAuthor(value: unknown, label: string): WiffAuthor {
	if (!isRecord(value)) throw new Error(`Wiff JSON state ${label} must be an object`);
	const kind = requireString(value.kind, `${label}.kind`);
	if (kind !== "human" && kind !== "agent")
		throw new Error(`Wiff JSON state ${label}.kind must be human or agent`);
	return {
		name: requireString(value.name, `${label}.name`),
		kind,
	};
}

function parseComment(value: unknown, index: number): WiffComment {
	if (!isRecord(value)) throw new Error(`Wiff JSON state comments[${index}] must be an object`);
	return {
		id: requireString(value.id, `comments[${index}].id`),
		resolved: requireBoolean(value.resolved, `comments[${index}].resolved`),
		deleted: requireBoolean(value.deleted, `comments[${index}].deleted`),
		author: parseAuthor(value.author, `comments[${index}].author`),
	};
}

function parseVerdict(value: unknown, index: number): WiffVerdict {
	if (!isRecord(value)) throw new Error(`Wiff JSON state verdicts[${index}] must be an object`);
	const disposition = requireString(value.disposition, `verdicts[${index}].disposition`);
	if (disposition !== "approve" && disposition !== "request_changes")
		throw new Error(`Wiff JSON state verdicts[${index}].disposition is not supported`);
	return {
		author: parseAuthor(value.author, `verdicts[${index}].author`),
		disposition,
	};
}

/** Parses and minimally validates one `wiff render --format json` document. Unknown fields are tolerated. */
export function parseWiffState(stdout: string): WiffState {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error("Wiff JSON state is not valid JSON");
	}
	if (!isRecord(value)) throw new Error("Wiff JSON state must be an object");
	if (value.schema_version !== WIFF_SCHEMA_VERSION) {
		throw new Error(
			`Wiff JSON schema_version ${JSON.stringify(value.schema_version)} is not supported; expected ${WIFF_SCHEMA_VERSION}`,
		);
	}
	if (!isRecord(value.session)) throw new Error("Wiff JSON state session must be an object");
	if (!Array.isArray(value.comments)) throw new Error("Wiff JSON state comments must be an array");
	if (value.verdicts !== undefined && !Array.isArray(value.verdicts))
		throw new Error("Wiff JSON state verdicts must be an array when present");
	return {
		session: {
			id: requireString(value.session.id, "session.id"),
			project: requireString(value.session.project, "session.project"),
		},
		comments: value.comments.map((comment, index) => parseComment(comment, index)),
		verdicts: (value.verdicts ?? []).map((verdict: unknown, index: number) => parseVerdict(verdict, index)),
	};
}

/** True when the Pi-specific project has an active Wiff session to trust; false only on exact `No sessions.` output. */
export async function hasWiffSession(options: WiffProjectOptions): Promise<boolean> {
	const result = await runWiff(["session", "list", "--project", options.project], {
		cwd: options.repositoryRoot,
		signal: options.signal,
	});
	requireSuccess(result, "wiff session list");
	return result.stdout.toString("utf8").trimEnd() !== NO_SESSIONS;
}

export async function createWiffSession(options: CreateWiffSessionOptions): Promise<void> {
	if (options.patch.length === 0) throw new Error("Wiff session creation requires non-empty patch bytes");
	const result = await runWiff([
		"new",
		"--no-tui",
		"--agent",
		"--author",
		"pi-review",
		"--project",
		options.project,
		"--description",
		options.description,
	], { cwd: options.repositoryRoot, input: options.patch, signal: options.signal });
	requireSuccess(result, "wiff new");
}

export async function refreshWiffSession(options: RefreshWiffSessionOptions): Promise<void> {
	if (options.patch.length === 0) throw new Error("Wiff session refresh requires non-empty patch bytes");
	const result = await runWiff([
		"refresh",
		"--agent",
		"--author",
		"pi-review",
		"--project",
		options.project,
	], { cwd: options.repositoryRoot, input: options.patch, signal: options.signal });
	requireSuccess(result, "wiff refresh");
}

export async function readWiffState(options: WiffProjectOptions): Promise<WiffState> {
	const result = await runWiff(["render", "--format", "json", "--project", options.project], {
		cwd: options.repositoryRoot,
		signal: options.signal,
	});
	requireSuccess(result, "wiff render --format json");
	const state = parseWiffState(result.stdout.toString("utf8"));
	if (state.session.project !== options.project)
		throw new Error(`Wiff returned project ${state.session.project}, expected ${options.project}`);
	return state;
}

/** Returns ordinary Wiff Markdown verbatim, for human and fixing-turn feedback only. */
export async function renderWiffMarkdown(options: WiffProjectOptions): Promise<string> {
	const result = await runWiff(["render", "--project", options.project], {
		cwd: options.repositoryRoot,
		signal: options.signal,
	});
	requireSuccess(result, "wiff render");
	return result.stdout.toString("utf8");
}

/** Publishes one neutral, unverdicted audit finding. Additions omit `side` to take Wiff's default `after`. */
export async function addWiffComment(options: AddWiffCommentOptions): Promise<void> {
	const args = [
		"comment",
		"add",
		"--agent",
		"--author",
		options.author,
		"--session",
		options.session,
		"--project",
		options.project,
		"--file",
		options.file,
		"--line",
		String(options.line),
	];
	if (options.side) args.push("--side", options.side);
	const result = await runWiff(args, {
		cwd: options.repositoryRoot,
		input: Buffer.from(options.body, "utf8"),
		signal: options.signal,
	});
	requireSuccess(result, "wiff comment add");
}

export async function removeWiffSession(options: RemoveWiffSessionOptions): Promise<void> {
	const result = await runWiff(["session", "rm", options.session, "--project", options.project], {
		cwd: options.repositoryRoot,
		signal: options.signal,
	});
	requireSuccess(result, "wiff session rm");
}

/**
 * Hands the terminal to `wiff resume` and always restores it: `tui.stop()` before spawn,
 * `tui.start()` and `tui.requestRender(true)` in `finally`, on every exit path including abort.
 * Inherited stdio means a failing exit carries no captured stderr.
 */
export async function resumeWiff(options: ResumeWiffOptions): Promise<void> {
	options.signal?.throwIfAborted();
	options.tui.stop();
	try {
		const child = spawn(WIFF_BINARY, ["resume", "--project", options.project], {
			cwd: options.repositoryRoot,
			stdio: "inherit",
			windowsHide: true,
			signal: options.signal,
		});
		const { code, signal } = await waitForWiffChild(child, options.signal);
		if (code !== 0)
			throw new Error(`wiff resume exited${signal ? ` (${signal})` : ` (${code ?? "unknown"})`}`);
	} finally {
		options.tui.start();
		options.tui.requestRender(true);
	}
}
