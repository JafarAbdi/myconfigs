import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { spawn } from "node:child_process";

export type ReviewSide = "deletions" | "additions";

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

	const files = parsePatchFiles(
		text,
		`${identity.baseOid}...${identity.headOid}`,
		true,
	).flatMap((parsed) => parsed.files);
	if (files.length === 0)
		throw new Error("Git produced a non-empty patch that Pierre could not parse");
	return {
		identity,
		text,
		empty: false,
		files: files.map((fileDiff) => ({
			filePath: fileDiff.name,
			...(fileDiff.prevName === undefined ? {} : { previousPath: fileDiff.prevName }),
			type: fileDiff.type,
			changed: collectChangedLines(fileDiff),
			fileDiff,
		})),
	};
}

async function runGit(repository: string, arguments_: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", arguments_, {
			cwd: repository,
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
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
	const bytes = await runGit(repository, gitDiffArguments(baseOid, headOid));
	return reviewPatchFromText(bytes.toString("utf8"), baseOid, headOid);
}
