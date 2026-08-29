import { posix } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { SshConnection } from "./connection.ts";
import { REMOTE_RG_EXCLUDES } from "./constants.ts";
import { rgExcludeArgs, shellQuote } from "./shell.ts";

const DEFAULT_LIMIT = 100;
const GREP_OUTPUT_BUFFER_MAX = DEFAULT_MAX_BYTES * 4;
const FILE_TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;

interface RemoteGrepResult {
	stdout: string;
	stderr: string;
	code: number | null;
	aborted: boolean;
	killedDueToLimit: boolean;
}

async function buildRemoteGrepCommand(connection: SshConnection, input: GrepToolInput): Promise<string> {
	const searchPath = connection.toRemotePath(input.path || ".");
	const attrs = await connection.sftp.stat(searchPath);
	if (attrs.permissions === undefined) throw new Error("SFTP STAT response did not include file permissions");

	const contextValue = input.context && input.context > 0 ? input.context : 0;
	const args = [
		"--with-filename",
		"--line-number",
		"--color=never",
		"--hidden",
		"--no-heading",
		...rgExcludeArgs(REMOTE_RG_EXCLUDES),
	];
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("--glob", input.glob);
	if (contextValue > 0) args.push("--context", String(contextValue));

	const rg = `${shellQuote("rg")} ${args.map((arg) => shellQuote(arg)).join(" ")} -- ${shellQuote(input.pattern)}`;
	if ((attrs.permissions & FILE_TYPE_MASK) === DIRECTORY_TYPE) {
		return `cd ${shellQuote(searchPath)} && ${rg} .`;
	}
	return `cd ${shellQuote(posix.dirname(searchPath))} && ${rg} ${shellQuote(posix.basename(searchPath))}`;
}

async function runRemoteGrepCommand(
	connection: SshConnection,
	command: string,
	signal?: AbortSignal,
): Promise<RemoteGrepResult> {
	if (signal?.aborted) throw new Error("Operation aborted");

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	let stdout = "";
	let stderr = "";
	let killedDueToLimit = false;
	try {
		const result = await connection.execStreaming(command, {
			signal: controller.signal,
			onData: (chunk) => {
				stdout += chunk.toString("utf8");
				if (stdout.length > GREP_OUTPUT_BUFFER_MAX && !controller.signal.aborted) {
					killedDueToLimit = true;
					controller.abort();
				}
			},
			onStderr: (chunk) => {
				stderr += chunk.toString("utf8");
			},
		});
		return {
			stdout,
			stderr,
			code: result.exitCode,
			aborted: false,
			killedDueToLimit: false,
		};
	} catch (error) {
		if (signal?.aborted) return { stdout, stderr, code: null, aborted: true, killedDueToLimit };
		if (killedDueToLimit)
			return {
				stdout,
				stderr,
				code: null,
				aborted: false,
				killedDueToLimit: true,
			};
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function isMatchLine(line: string): boolean {
	return /^[^:\n]+:\d+:/u.test(line);
}

interface RemoteGrepOutput {
	output: string;
	details: GrepToolDetails;
}

function formatRemoteGrepOutput(rawOutput: string, effectiveLimit: number): RemoteGrepOutput {
	const details: GrepToolDetails = {};
	const outputLines: string[] = [];
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	for (const line of rawOutput.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
		if (!line) continue;
		if (isMatchLine(line)) {
			matchCount += 1;
			if (matchCount > effectiveLimit) {
				matchLimitReached = true;
				break;
			}
		}
		const { text, wasTruncated } = truncateLine(line);
		if (wasTruncated) linesTruncated = true;
		outputLines.push(text);
	}

	const truncation = truncateHead(outputLines.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	let output = truncation.content;
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(
			`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
		);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push("Some lines truncated. Use read tool to see full lines");
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { output, details };
}

export async function executeRemoteGrep(connection: SshConnection, input: GrepToolInput, signal?: AbortSignal) {
	const command = await buildRemoteGrepCommand(connection, input);
	const result = await runRemoteGrepCommand(connection, command, signal);
	if (result.aborted) throw new Error("Operation aborted");
	if (!result.killedDueToLimit && result.code !== 0 && result.code !== 1) {
		throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code ?? "unknown"}`);
	}
	if (!result.stdout.trim()) {
		return {
			content: [{ type: "text" as const, text: "No matches found" }],
			details: undefined,
		};
	}

	const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
	const { output, details } = formatRemoteGrepOutput(result.stdout, effectiveLimit);
	return {
		content: [{ type: "text" as const, text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}
