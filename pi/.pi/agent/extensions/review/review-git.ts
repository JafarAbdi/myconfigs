import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export type ReviewSide = "additions" | "deletions";

export interface ReviewSnapshot {
	readonly repositoryRoot: string;
	readonly headOid: string;
	readonly raw: Buffer;
}

export interface ReviewPatchFile {
	filePath: string;
	previousPath?: string;
	type: FileDiffMetadata["type"];
	changed: Record<ReviewSide, number[]>;
	fileDiff: FileDiffMetadata;
}

export interface ReviewPatch {
	snapshot: ReviewSnapshot;
	text: string;
	empty: boolean;
	files: ReviewPatchFile[];
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Measured Review ceilings. Pierre SSR rendered 500 files with 10,000 changed
 * lines at roughly 31 MiB of HTML; larger candidates are refused, not truncated.
 */
export const MAX_REVIEW_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_REVIEW_FILES = 500;
export const MAX_REVIEW_CHANGED_LINES = 10_000;

function oversized(what: string, actual: number, limit: number): Error {
	return new Error(
		`Review is too large to render: ${what} is ${actual}, above the ${limit} Review limit; split the candidate instead`,
	);
}

export function gitDiffArguments(): string[] {
	return [
		"diff",
		"--cached",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-algorithm=histogram",
		"--find-renames",
		"--unified=3",
		"HEAD",
		"--",
	];
}

function collectChangedLines(file: FileDiffMetadata): Record<ReviewSide, number[]> {
	const additions = new Set<number>();
	const deletions = new Set<number>();
	for (const hunk of file.hunks) {
		let additionLine = hunk.additionStart;
		let deletionLine = hunk.deletionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === "context") {
				additionLine += content.lines;
				deletionLine += content.lines;
				continue;
			}
			for (let offset = 0; offset < content.additions; offset += 1)
				additions.add(additionLine + offset);
			for (let offset = 0; offset < content.deletions; offset += 1)
				deletions.add(deletionLine + offset);
			additionLine += content.additions;
			deletionLine += content.deletions;
		}
	}
	return {
		additions: [...additions].sort((left, right) => left - right),
		deletions: [...deletions].sort((left, right) => left - right),
	};
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

function decodePatch(raw: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		throw new Error("Review patch is not valid UTF-8");
	}
}

export function reviewPatchFromBuffer(
	raw: Buffer,
	repositoryRoot: string,
	headOid: string,
): ReviewPatch {
	const snapshot = {
		repositoryRoot: requireRoot(repositoryRoot),
		headOid: requireOid(headOid, "HEAD"),
		raw: Buffer.from(raw),
	};
	if (raw.length > MAX_REVIEW_PATCH_BYTES)
		throw oversized("the cumulative patch", raw.length, MAX_REVIEW_PATCH_BYTES);
	const text = decodePatch(raw);
	if (raw.length === 0) return { snapshot, text, empty: true, files: [] };

	const parsed = parsePatchFiles(text, `${snapshot.headOid}:index`, true)
		.flatMap((entry) => entry.files);
	if (parsed.length === 0)
		throw new Error("Git produced a non-empty Review patch that Pierre could not parse");
	if (parsed.length > MAX_REVIEW_FILES)
		throw oversized("the changed file count", parsed.length, MAX_REVIEW_FILES);
	const files = parsed.map((fileDiff) => ({
		filePath: fileDiff.name,
		...(fileDiff.prevName === undefined ? {} : { previousPath: fileDiff.prevName }),
		type: fileDiff.type,
		changed: collectChangedLines(fileDiff),
		fileDiff,
	}));
	const changedLines = files.reduce(
		(total, file) => total + file.changed.additions.length + file.changed.deletions.length,
		0,
	);
	if (changedLines > MAX_REVIEW_CHANGED_LINES)
		throw oversized("the changed line count", changedLines, MAX_REVIEW_CHANGED_LINES);
	return { snapshot, text, empty: false, files };
}

export function reviewPatchFromText(
	text: string,
	repositoryRoot: string,
	headOid: string,
): ReviewPatch {
	return reviewPatchFromBuffer(Buffer.from(text, "utf8"), repositoryRoot, headOid);
}

export function reviewSnapshotsEqual(
	left: ReviewSnapshot,
	right: ReviewSnapshot,
): boolean {
	return left.repositoryRoot === right.repositoryRoot &&
		left.headOid === right.headOid &&
		left.raw.equals(right.raw);
}

async function runGit(
	repository: string,
	arguments_: string[],
	maxStdoutBytes = 64 * 1024,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", arguments_, {
			cwd: repository,
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
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
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (exceeded) {
				reject(oversized("the cumulative patch", stdoutBytes, maxStdoutBytes));
				return;
			}
			if (code === 0) {
				resolve(Buffer.concat(stdout));
				return;
			}
			const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 4_096);
			reject(new Error(
				`git ${arguments_[0]} failed${signal ? ` (${signal})` : ` (${code ?? "unknown"})`}${detail ? `: ${detail}` : ""}`,
			));
		});
	});
}

async function resolveHead(repositoryRoot: string): Promise<string> {
	const output = await runGit(repositoryRoot, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		"HEAD^{commit}",
	]);
	return requireOid(output.toString("ascii").trim(), "HEAD");
}

export async function readGitReviewPatch(repository: string): Promise<ReviewPatch> {
	const rootOutput = await runGit(repository, ["rev-parse", "--show-toplevel"]);
	const repositoryRoot = requireRoot(rootOutput.toString("utf8").trim());
	const before = await resolveHead(repositoryRoot);
	const raw = await runGit(repositoryRoot, gitDiffArguments(), MAX_REVIEW_PATCH_BYTES);
	const after = await resolveHead(repositoryRoot);
	if (before !== after)
		throw new Error("Review HEAD changed while the staged candidate was being captured");
	return reviewPatchFromBuffer(raw, repositoryRoot, before);
}
