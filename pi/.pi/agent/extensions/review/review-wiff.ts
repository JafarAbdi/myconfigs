import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";

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

export interface WiffBaseOptions {
	readonly wiffDataDir: string;
	readonly repositoryRoot: string;
	readonly signal?: AbortSignal;
}

export interface WiffPinnedOptions extends WiffBaseOptions {
	readonly session: string;
	readonly project: string;
}

export interface WiffAuthor {
	readonly name: string;
	readonly kind: "human" | "agent";
}

export interface WiffDescription {
	readonly author: WiffAuthor;
	readonly title: string;
	readonly body: string;
}

export type WiffCommentTarget =
	| { readonly target: "review" }
	| { readonly target: "file"; readonly file: string }
	| {
		readonly target: "lines";
		readonly file: string;
		readonly side: "before" | "after";
		readonly startLine: number;
		readonly endLine: number;
	}
	| { readonly target: "comment"; readonly id: string };

export interface WiffComment {
	readonly id: string;
	readonly number: number;
	readonly body: string;
	readonly target: WiffCommentTarget;
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
		readonly source: string;
	};
	readonly description?: WiffDescription;
	readonly comments: readonly WiffComment[];
	readonly verdicts: readonly WiffVerdict[];
}

export interface CreateWiffSessionOptions extends WiffBaseOptions {
	readonly patch: Buffer;
	readonly description: string;
}

export interface RefreshWiffSessionOptions extends WiffPinnedOptions {
	readonly patch: Buffer;
}

export interface AddWiffCommentOptions extends WiffPinnedOptions {
	readonly author: string;
	readonly file: string;
	readonly line: number;
	readonly side?: "before" | "after";
	readonly body: string;
}

export interface AddWiffReplyOptions extends WiffPinnedOptions {
	readonly author: string;
	readonly commentId: string;
	readonly body: string;
}

export interface ResolveWiffCommentOptions extends WiffPinnedOptions {
	readonly author: string;
	readonly commentId: string;
}

export type RemoveWiffSessionOptions = WiffPinnedOptions;

export interface WiffTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

export interface ResumeWiffOptions extends WiffPinnedOptions {
	readonly tui: WiffTui;
}

export interface PullWiffReviewOptions extends WiffBaseOptions {
	readonly pullRequestNumber: number;
	readonly githubToken: string;
	readonly tui: WiffTui;
}

export interface PushWiffReviewOptions extends WiffPinnedOptions {
	readonly author: string;
	readonly agent?: boolean;
	readonly githubToken: string;
}

function wiffSpawnError(cause: NodeJS.ErrnoException): Error {
	if (cause.code === "ENOENT")
		return new Error("wiff is not installed or not on PATH; install the Wiff CLI to use /review");
	return new Error(`wiff failed to start: ${cause.message}`, { cause });
}

interface WiffCommandResult {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly code: number | null;
}

interface RunWiffOptions extends WiffBaseOptions {
	readonly input?: Buffer;
	readonly childEnv?: Readonly<NodeJS.ProcessEnv>;
}

interface RunWiffWithTuiOptions extends WiffBaseOptions {
	readonly tui: WiffTui;
	readonly childEnv?: Readonly<NodeJS.ProcessEnv>;
}

interface WiffExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

function wiffEnvironment(
	wiffDataDir: string,
	childEnv: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
	return { ...process.env, WIFF_DATA_DIR: wiffDataDir, ...childEnv };
}

function waitForWiffChild(child: ChildProcess, signal?: AbortSignal): Promise<WiffExit> {
	return new Promise((resolvePromise, reject) => {
		child.once("error", (error: NodeJS.ErrnoException) => {
			reject(signal?.aborted ? (signal.reason ?? error) : wiffSpawnError(error));
		});
		child.once("close", (code, exitSignal) => resolvePromise({ code, signal: exitSignal }));
	});
}

async function runWiff(args: readonly string[], options: RunWiffOptions): Promise<WiffCommandResult> {
	options.signal?.throwIfAborted();
	const child = spawn(WIFF_BINARY, args, {
		cwd: options.repositoryRoot,
		env: wiffEnvironment(options.wiffDataDir, options.childEnv),
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

async function runWiffWithTui(
	args: readonly string[],
	label: string,
	options: RunWiffWithTuiOptions,
): Promise<void> {
	options.signal?.throwIfAborted();
	options.tui.stop();
	try {
		const child = spawn(WIFF_BINARY, args, {
			cwd: options.repositoryRoot,
			env: wiffEnvironment(options.wiffDataDir, options.childEnv),
			stdio: "inherit",
			windowsHide: true,
			signal: options.signal,
		});
		const { code, signal } = await waitForWiffChild(child, options.signal);
		if (code !== 0)
			throw new Error(`${label} exited${signal ? ` (${signal})` : ` (${code ?? "unknown"})`}`);
	} finally {
		options.tui.start();
		options.tui.requestRender(true);
	}
}

function requireSuccess(result: WiffCommandResult, label: string): void {
	if (result.code === 0) return;
	const detail = result.stderr.toString("utf8").trim();
	throw new Error(`${label} failed (exit ${result.code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
}

/** Derives one private Wiff data directory from Pi's absolute agent directory and full session ID. */
export function deriveWiffDataDir(agentDir: string, piSessionId: string): string {
	if (!isAbsolute(agentDir))
		throw new Error("Wiff data directory requires an absolute Pi agent directory");
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(piSessionId)
		|| piSessionId === "."
		|| piSessionId === ".."
	)
		throw new Error("Wiff data directory requires a non-empty safe Pi session ID path component");
	return join(agentDir, "wiff", piSessionId);
}

/** The domain shape any JSON.parse of Wiff's `render --format json` output can produce. */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonRecord;
type JsonRecord = { readonly [key: string]: JsonValue | undefined };

function isRecord(value: JsonValue | undefined): value is JsonRecord {
	return Object.prototype.toString.call(value) === "[object Object]";
}

function isJsonString(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function isJsonSafeInteger(value: JsonValue | undefined): value is number {
	return Number.isSafeInteger(value);
}

function requireString(value: JsonValue | undefined, label: string): string {
	if (!isJsonString(value) || value.length === 0)
		throw new Error(`Wiff JSON state ${label} must be a non-empty string`);
	return value;
}

function requireText(value: JsonValue | undefined, label: string): string {
	if (!isJsonString(value)) throw new Error(`Wiff JSON state ${label} must be a string`);
	return value;
}

function requireBoolean(value: JsonValue | undefined, label: string): boolean {
	if (value !== true && value !== false)
		throw new Error(`Wiff JSON state ${label} must be a boolean`);
	return value;
}

function requirePositiveInteger(value: JsonValue | undefined, label: string): number {
	if (!isJsonSafeInteger(value) || value <= 0)
		throw new Error(`Wiff JSON state ${label} must be a positive integer`);
	return value;
}

function parseAuthor(value: JsonValue | undefined, label: string): WiffAuthor {
	if (!isRecord(value)) throw new Error(`Wiff JSON state ${label} must be an object`);
	const kind = requireString(value.kind, `${label}.kind`);
	if (kind !== "human" && kind !== "agent")
		throw new Error(`Wiff JSON state ${label}.kind must be human or agent`);
	return {
		name: requireString(value.name, `${label}.name`),
		kind,
	};
}

function parseDescription(value: JsonValue | undefined): WiffDescription {
	if (!isRecord(value)) throw new Error("Wiff JSON state description must be an object");
	return {
		author: parseAuthor(value.author, "description.author"),
		title: requireText(value.title, "description.title"),
		body: requireText(value.body, "description.body"),
	};
}

function parseCommentTarget(value: JsonValue | undefined, label: string): WiffCommentTarget {
	if (!isRecord(value)) throw new Error(`Wiff JSON state ${label} must be an object`);
	const target = requireString(value.target, `${label}.target`);
	switch (target) {
		case "review":
			return { target };
		case "file":
			return { target, file: requireString(value.file, `${label}.file`) };
		case "lines": {
			const file = requireString(value.file, `${label}.file`);
			const side = requireString(value.side, `${label}.side`);
			if (side !== "before" && side !== "after")
				throw new Error(`Wiff JSON state ${label}.side must be before or after`);
			const startLine = requirePositiveInteger(value.start_line, `${label}.start_line`);
			const endLine = requirePositiveInteger(value.end_line, `${label}.end_line`);
			if (startLine > endLine)
				throw new Error(`Wiff JSON state ${label}.start_line must not exceed ${label}.end_line`);
			return { target, file, side, startLine, endLine };
		}
		case "comment":
			return { target, id: requireString(value.id, `${label}.id`) };
		default:
			throw new Error(`Wiff JSON state ${label}.target is not supported`);
	}
}

function parseComment(value: JsonValue | undefined, index: number): WiffComment {
	if (!isRecord(value)) throw new Error(`Wiff JSON state comments[${index}] must be an object`);
	const label = `comments[${index}]`;
	return {
		id: requireString(value.id, `${label}.id`),
		number: requirePositiveInteger(value.number, `${label}.number`),
		body: requireText(value.body, `${label}.body`),
		target: parseCommentTarget(value.target, `${label}.target`),
		resolved: requireBoolean(value.resolved, `${label}.resolved`),
		deleted: requireBoolean(value.deleted, `${label}.deleted`),
		author: parseAuthor(value.author, `${label}.author`),
	};
}

function parseVerdict(value: JsonValue | undefined, index: number): WiffVerdict {
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
	let value: JsonValue;
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
	const state: WiffState = {
		session: {
			id: requireString(value.session.id, "session.id"),
			project: requireString(value.session.project, "session.project"),
			source: requireString(value.session.source, "session.source"),
		},
		comments: value.comments.map((comment, index) => parseComment(comment, index)),
		verdicts: (value.verdicts ?? []).map((verdict, index) => parseVerdict(verdict, index)),
	};
	if (value.description === undefined) return state;
	return { ...state, description: parseDescription(value.description) };
}

/** Selects only live top-level comments that may suppress equivalent synthesized findings. */
export function synthesisWiffComments(state: WiffState): readonly WiffComment[] {
	return state.comments.filter(
		(comment) => !comment.resolved && !comment.deleted && comment.target.target !== "comment",
	);
}

function removeOneTerminalNewline(value: string): string {
	if (!value.endsWith("\n")) return value;
	const withoutNewline = value.slice(0, -1);
	return withoutNewline.endsWith("\r") ? withoutNewline.slice(0, -1) : withoutNewline;
}

function isPinned(options: WiffBaseOptions | WiffPinnedOptions): options is WiffPinnedOptions {
	return "session" in options;
}

function targetArgs(options: WiffBaseOptions | WiffPinnedOptions): string[] {
	return isPinned(options) ? ["--session", options.session, "--project", options.project] : [];
}

/** False only when Wiff's private session listing is exactly its no-sessions sentinel. */
export async function hasWiffSession(options: WiffBaseOptions): Promise<boolean> {
	const result = await runWiff(["session", "list", "--all"], options);
	requireSuccess(result, "wiff session list");
	return removeOneTerminalNewline(result.stdout.toString("utf8")) !== NO_SESSIONS;
}

export async function createWiffSession(options: CreateWiffSessionOptions): Promise<void> {
	if (options.patch.length === 0) throw new Error("Wiff session creation requires non-empty patch bytes");
	const result = await runWiff([
		"new",
		"--no-tui",
		"--agent",
		"--author",
		"pi-review",
		"--description",
		options.description,
	], { ...options, input: options.patch });
	requireSuccess(result, "wiff new");
}

export async function refreshWiffSession(options: RefreshWiffSessionOptions): Promise<void> {
	if (options.patch.length === 0) throw new Error("Wiff session refresh requires non-empty patch bytes");
	const result = await runWiff([
		"refresh",
		"--agent",
		"--author",
		"pi-review",
		"--session",
		options.session,
		"--project",
		options.project,
	], { ...options, input: options.patch });
	requireSuccess(result, "wiff refresh");
}

export async function readWiffState(
	options: WiffBaseOptions | WiffPinnedOptions,
): Promise<WiffState> {
	const result = await runWiff(["render", "--format", "json", ...targetArgs(options)], options);
	requireSuccess(result, "wiff render --format json");
	const state = parseWiffState(result.stdout.toString("utf8"));
	if (isPinned(options)) {
		if (state.session.id !== options.session)
			throw new Error(`Wiff returned session ${state.session.id}, expected ${options.session}`);
		if (state.session.project !== options.project)
			throw new Error(`Wiff returned project ${state.session.project}, expected ${options.project}`);
	}
	return state;
}

/** Returns ordinary Wiff Markdown verbatim, for human and fixing-turn feedback only. */
export async function renderWiffMarkdown(
	options: WiffBaseOptions | WiffPinnedOptions,
): Promise<string> {
	const result = await runWiff(["render", ...targetArgs(options)], options);
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
		...options,
		input: Buffer.from(options.body, "utf8"),
	});
	requireSuccess(result, "wiff comment add");
}

export async function addWiffReply(options: AddWiffReplyOptions): Promise<void> {
	const result = await runWiff([
		"comment",
		"add",
		"--agent",
		"--author",
		options.author,
		"--session",
		options.session,
		"--project",
		options.project,
		"--reply-to",
		options.commentId,
	], { ...options, input: Buffer.from(options.body, "utf8") });
	requireSuccess(result, "wiff comment add reply");
}

export async function resolveWiffComment(options: ResolveWiffCommentOptions): Promise<void> {
	const result = await runWiff([
		"comment",
		"resolve",
		options.commentId,
		"--agent",
		"--author",
		options.author,
		"--session",
		options.session,
		"--project",
		options.project,
	], options);
	requireSuccess(result, "wiff comment resolve");
}

export async function removeWiffSession(options: RemoveWiffSessionOptions): Promise<void> {
	const result = await runWiff([
		"session",
		"rm",
		options.session,
		"--project",
		options.project,
	], options);
	requireSuccess(result, "wiff session rm");
}

/** Hands the terminal to an exact private Wiff session and always restores Pi's TUI. */
export async function resumeWiff(options: ResumeWiffOptions): Promise<void> {
	await runWiffWithTui([
		"resume",
		"--session",
		options.session,
		"--project",
		options.project,
	], "wiff resume", options);
}

/** Pulls the checked-out branch's pull request into this Pi session's private Wiff storage. */
export async function pullWiffReview(options: PullWiffReviewOptions): Promise<void> {
	if (!Number.isSafeInteger(options.pullRequestNumber) || options.pullRequestNumber <= 0)
		throw new Error("Wiff forge pull requires a positive pull request number");
	await runWiffWithTui(
		["forge", "pull", String(options.pullRequestNumber)],
		"wiff forge pull",
		{ ...options, childEnv: { GITHUB_TOKEN: options.githubToken } },
	);
}

/** Publishes one exact local author through Wiff without handing over the terminal. */
export async function pushWiffReview(options: PushWiffReviewOptions): Promise<void> {
	const args = [
		"forge",
		"push",
		"--session",
		options.session,
		"--author",
		options.author,
	];
	if (options.agent) args.push("--agent");
	const result = await runWiff(args, {
		...options,
		childEnv: { GITHUB_TOKEN: options.githubToken },
	});
	requireSuccess(result, "wiff forge push");
}
