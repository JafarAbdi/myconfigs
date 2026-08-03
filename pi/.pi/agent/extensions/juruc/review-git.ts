import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { spawn } from "node:child_process";
import type { ReviewSide } from "./task.ts";

export interface PatchIdentity {
	baseOid: string;
	headOid: string;
}

export interface ReviewPatchFile {
	filePath: string;
	previousPath?: string;
	type: FileDiffMetadata["type"];
	changed: Record<ReviewSide, number[]>;
	fileDiff: FileDiffMetadata;
}

export interface ReviewPatch {
	identity: PatchIdentity;
	text: string;
	empty: boolean;
	files: ReviewPatchFile[];
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Measured JURUC review ceilings. Synthetic Pierre SSR runs on this machine rendered
 * 500 files with 10,000 changed lines as ~31 MiB of HTML in ~1.0 s at ~295 MiB RSS,
 * while 20,000 changed lines doubled that to ~1.4 s and ~489 MiB RSS. Raw patch bytes
 * bound Git's buffer; long-line patches parse cheaply but 8 MiB of text already yields
 * ~9 MiB of HTML. A review beyond any of these is refused clearly and never truncated.
 */
export const MAX_REVIEW_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_REVIEW_FILES = 500;
export const MAX_REVIEW_CHANGED_LINES = 10_000;

function oversized(what: string, actual: number, limit: number): Error {
	return new Error(
		`review is too large to render: ${what} is ${actual}, above the ${limit} JURUC limit; split the task instead`,
	);
}

export function gitDiffArguments(baseOid: string, headOid: string): string[] {
	return [
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-algorithm=histogram",
		"--find-renames",
		"--unified=3",
		`${baseOid}...${headOid}`,
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

export function reviewPatchFromText(
	text: string,
	baseOid: string,
	headOid: string,
): ReviewPatch {
	const identity = {
		baseOid: requireOid(baseOid, "base"),
		headOid: requireOid(headOid, "head"),
	};
	if (text.length === 0) return { identity, text, empty: true, files: [] };
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_REVIEW_PATCH_BYTES)
		throw oversized("the cumulative patch", bytes, MAX_REVIEW_PATCH_BYTES);

	const parsed = parsePatchFiles(
		text,
		`${identity.baseOid}...${identity.headOid}`,
		true,
	).flatMap((entry) => entry.files);
	if (parsed.length === 0)
		throw new Error("Git produced a non-empty patch that Pierre could not parse");
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
	return { identity, text, empty: false, files };
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
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > maxStdoutBytes) {
				child.kill("SIGKILL");
				reject(oversized("the cumulative patch", stdoutBytes, maxStdoutBytes));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve(Buffer.concat(stdout));
				return;
			}
			const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 4_096);
			reject(
				new Error(
					`git ${arguments_[0]} failed${signal ? ` (${signal})` : ` (${code ?? "unknown"})`}${detail ? `: ${detail}` : ""}`,
				),
			);
		});
	});
}

async function resolveCommit(repository: string, revision: string): Promise<string> {
	if (!revision.trim()) throw new Error("Git revision must not be empty");
	const output = await runGit(repository, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${revision}^{commit}`,
	]);
	return requireOid(output.toString("ascii").trim(), revision);
}

export async function readGitReviewPatch(
	repository: string,
	base: string,
	head: string,
): Promise<ReviewPatch> {
	const [baseOid, headOid] = await Promise.all([
		resolveCommit(repository, base),
		resolveCommit(repository, head),
	]);
	const bytes = await runGit(
		repository,
		gitDiffArguments(baseOid, headOid),
		MAX_REVIEW_PATCH_BYTES,
	);
	return reviewPatchFromText(bytes.toString("utf8"), baseOid, headOid);
}
