import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ReviewSide = "additions" | "deletions";
export type ReviewView = "staged" | "unstaged" | "untracked" | "overall";

export interface ReviewSelection {
	readonly view: ReviewView;
	readonly paths: readonly string[];
}

export interface ReviewSnapshot {
	readonly repositoryRoot: string;
	readonly headOid: string;
	readonly view: ReviewView;
	readonly paths: readonly string[];
	readonly raw: Buffer;
}

export interface ReviewPatch {
	snapshot: ReviewSnapshot;
	text: string;
	empty: boolean;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const MAX_REVIEW_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_REVIEW_SELECTION_PATHS = 500;

export const DEFAULT_REVIEW_SELECTION: ReviewSelection = {
	view: "staged",
	paths: [],
};

function oversized(what: string, actual: number, limit: number): Error {
	return new Error(
		`Review is too large to render: ${what} is ${actual}, above the ${limit} Review limit; split the candidate instead`,
	);
}

function literalPathspec(path: string): string {
	return path === "." ? ":(top)" : `:(top,literal)${path}`;
}

export function gitDiffArguments(
	selection: ReviewSelection = DEFAULT_REVIEW_SELECTION,
): string[] {
	if (selection.view === "untracked")
		throw new Error("untracked Review capture does not use git diff against a Git tree");
	return [
		"diff",
		...(selection.view === "staged" ? ["--cached"] : []),
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-algorithm=histogram",
		"--find-renames",
		"--full-index",
		"--unified=3",
		...(selection.view === "staged" || selection.view === "overall" ? ["HEAD"] : []),
		"--",
		...selection.paths.map(literalPathspec),
	];
}

function requireOid(value: string, label: string): string {
	if (!OID.test(value)) throw new Error(`${label} did not resolve to a full Git object ID`);
	return value;
}

function requireRoot(value: string): string {
	if (!isAbsolute(value) || value.includes("\0"))
		throw new Error("Git repository root did not resolve to an absolute path");
	return value;
}

function normalizeSelection(
	selection: ReviewSelection,
	repositoryRoot: string,
): ReviewSelection {
	if (
		selection.view !== "staged" && selection.view !== "unstaged" &&
		selection.view !== "untracked" && selection.view !== "overall"
	) throw new Error("Review view must be staged, unstaged, untracked, or overall");
	if (!Array.isArray(selection.paths) || selection.paths.length > MAX_REVIEW_SELECTION_PATHS)
		throw new Error(`Review accepts at most ${MAX_REVIEW_SELECTION_PATHS} selected paths`);
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const value of selection.paths) {
		if (
			!value || /[\0\r\n\u2028\u2029]/u.test(value) ||
			Buffer.byteLength(value, "utf8") > 4_096
		) throw new Error("Review paths must be non-empty, NUL/newline-free text of at most 4096 bytes");
		if (isAbsolute(value)) throw new Error("Review paths must be repository-relative");
		const path = relative(repositoryRoot, resolve(repositoryRoot, value)) || ".";
		if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
			throw new Error("Review path escapes the repository root");
		if (!seen.has(path)) {
			seen.add(path);
			paths.push(path);
		}
	}
	return { view: selection.view, paths };
}

function decodeUtf8(raw: Buffer, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		throw new Error(`${label} is not valid UTF-8`);
	}
}

export function reviewPatchFromBuffer(
	raw: Buffer,
	repositoryRoot: string,
	headOid: string,
	selection: ReviewSelection = DEFAULT_REVIEW_SELECTION,
): ReviewPatch {
	const root = requireRoot(repositoryRoot);
	const normalized = normalizeSelection(selection, root);
	const snapshot = {
		repositoryRoot: root,
		headOid: requireOid(headOid, "HEAD"),
		view: normalized.view,
		paths: normalized.paths,
		raw: Buffer.from(raw),
	};
	if (raw.length > MAX_REVIEW_PATCH_BYTES)
		throw oversized("the cumulative patch", raw.length, MAX_REVIEW_PATCH_BYTES);
	const text = decodeUtf8(raw, "Review patch");
	return { snapshot, text, empty: raw.length === 0 };
}

export function reviewPatchFromText(
	text: string,
	repositoryRoot: string,
	headOid: string,
	selection: ReviewSelection = DEFAULT_REVIEW_SELECTION,
): ReviewPatch {
	return reviewPatchFromBuffer(Buffer.from(text, "utf8"), repositoryRoot, headOid, selection);
}

export function reviewSnapshotsEqual(
	left: ReviewSnapshot,
	right: ReviewSnapshot,
): boolean {
	return left.repositoryRoot === right.repositoryRoot &&
		left.headOid === right.headOid &&
		left.view === right.view &&
		left.paths.length === right.paths.length &&
		left.paths.every((path, index) => path === right.paths[index]) &&
		left.raw.equals(right.raw);
}

async function runGit(
	repository: string,
	arguments_: string[],
	maxStdoutBytes = 64 * 1024,
	acceptedCodes: readonly number[] = [0],
	allowStderr = true,
	signal?: AbortSignal,
): Promise<Buffer> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn("git", arguments_, {
			cwd: repository,
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let exceeded = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > maxStdoutBytes) {
				exceeded = true;
				child.kill("SIGKILL");
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrBytes >= 64 * 1024) return;
			stderrBytes += chunk.length;
			stderr.push(chunk.subarray(0, 64 * 1024 - (stderrBytes - chunk.length)));
		});
		child.once("error", (error) => {
			reject(signal?.aborted ? (signal.reason ?? error) : error);
		});
		child.once("close", (code, exitSignal) => {
			if (exceeded) {
				reject(oversized("the cumulative patch", stdoutBytes, maxStdoutBytes));
				return;
			}
			const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 4_096);
			if (code !== null && acceptedCodes.includes(code) && (allowStderr || !detail)) {
				resolve(Buffer.concat(stdout));
				return;
			}
			reject(new Error(
				`git ${arguments_[0]} failed${exitSignal ? ` (${exitSignal})` : ` (${code ?? "unknown"})`}${detail ? `: ${detail}` : ""}`,
			));
		});
	});
}

export async function resolveGitRepositoryRoot(
	repository: string,
	signal?: AbortSignal,
): Promise<string> {
	const output = await runGit(
		repository,
		["rev-parse", "--show-toplevel"],
		64 * 1024,
		[0],
		true,
		signal,
	);
	return requireRoot(output.toString("utf8").trim());
}

async function resolveHead(repositoryRoot: string, signal?: AbortSignal): Promise<string> {
	const output = await runGit(repositoryRoot, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		"HEAD^{commit}",
	], 64 * 1024, [0], true, signal);
	return requireOid(output.toString("ascii").trim(), "HEAD");
}

function untrackedListArguments(paths: readonly string[]): string[] {
	return [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		...paths.map(literalPathspec),
	];
}

function untrackedDiffArguments(path: string): string[] {
	return [
		"diff",
		"--no-index",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-algorithm=histogram",
		"--full-index",
		"--unified=3",
		"--",
		"/dev/null",
		path,
	];
}

async function readUntrackedPatch(
	repositoryRoot: string,
	selection: ReviewSelection,
	signal?: AbortSignal,
): Promise<Buffer> {
	const listed = await runGit(
		repositoryRoot,
		untrackedListArguments(selection.paths),
		MAX_REVIEW_PATCH_BYTES,
		[0],
		true,
		signal,
	);
	const text = decodeUtf8(listed, "Untracked file list");
	const names = text ? text.split("\0").slice(0, -1) : [];
	const chunks: Buffer[] = [];
	let bytes = 0;
	for (const name of names) {
		const path = relative(repositoryRoot, resolve(repositoryRoot, name));
		if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
			throw new Error("Git returned an invalid untracked path");
		const metadata = await lstat(resolve(repositoryRoot, path)).catch(() => undefined);
		if (!metadata || (!metadata.isFile() && !metadata.isSymbolicLink()))
			throw new Error(`Untracked Review path is not a file or symbolic link: ${path}`);
		const chunk = await runGit(
			repositoryRoot,
			untrackedDiffArguments(path),
			MAX_REVIEW_PATCH_BYTES - bytes,
			[0, 1],
			false,
			signal,
		);
		bytes += chunk.length;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, bytes);
}

function decodePathList(raw: Buffer, label: string): string[] {
	const text = decodeUtf8(raw, label);
	if (!text) return [];
	return [...new Set(text.split("\0").slice(0, -1))].sort();
}

export async function listGitReviewPaths(
	repository: string,
	view: ReviewView,
	signal?: AbortSignal,
): Promise<string[]> {
	const repositoryRoot = await resolveGitRepositoryRoot(repository, signal);
	const untracked = async (): Promise<string[]> => decodePathList(
		await runGit(repositoryRoot, untrackedListArguments([]), 1024 * 1024, [0], true, signal),
		"Untracked review file list",
	);
	if (view === "untracked") return untracked();
	const arguments_ = gitDiffArguments({ view, paths: [] });
	arguments_.splice(1, 0, "--name-only", "-z");
	const tracked = decodePathList(
		await runGit(repositoryRoot, arguments_, 1024 * 1024, [0], true, signal),
		"Review changed file list",
	);
	return view === "overall" ? [...new Set([...tracked, ...await untracked()])].sort() : tracked;
}

export async function readGitReviewPatch(
	repository: string,
	selection: ReviewSelection = DEFAULT_REVIEW_SELECTION,
	signal?: AbortSignal,
): Promise<ReviewPatch> {
	const repositoryRoot = await resolveGitRepositoryRoot(repository, signal);
	const normalized = normalizeSelection(selection, repositoryRoot);
	const before = await resolveHead(repositoryRoot, signal);
	let raw: Buffer;
	if (normalized.view === "untracked") {
		raw = await readUntrackedPatch(repositoryRoot, normalized, signal);
	} else {
		raw = await runGit(
			repositoryRoot,
			gitDiffArguments(normalized),
			MAX_REVIEW_PATCH_BYTES,
			[0],
			true,
			signal,
		);
		if (normalized.view === "overall") {
			const untracked = await readUntrackedPatch(repositoryRoot, normalized, signal);
			if (raw.length + untracked.length > MAX_REVIEW_PATCH_BYTES)
				throw oversized("the cumulative patch", raw.length + untracked.length, MAX_REVIEW_PATCH_BYTES);
			raw = Buffer.concat([raw, untracked]);
		}
	}
	const after = await resolveHead(repositoryRoot, signal);
	if (before !== after)
		throw new Error("Review HEAD changed while the candidate was being captured");
	return reviewPatchFromBuffer(raw, repositoryRoot, before, normalized);
}
