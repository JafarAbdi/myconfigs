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
const PATH_NOT_FOUND_EXIT_CODE = 44;

interface RemoteGrepResult {
	stdout: string;
	stderr: string;
	code: number | null;
	aborted: boolean;
	killedDueToLimit: boolean;
}

function buildRemoteGrepCommand(connection: SshConnection, input: GrepToolInput): string {
	const searchPath = connection.toRemotePath(input.path || ".");
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

	const rgPrefix = `${shellQuote(connection.requireRgPath())} ${args.map(shellQuote).join(" ")} -- ${shellQuote(input.pattern)}`;
	return [
		`search=${shellQuote(searchPath)}`,
		`if [ -d "$search" ]; then cd "$search" && ${rgPrefix} .`,
		`elif [ -e "$search" ]; then parent=$(dirname "$search") && name=$(basename "$search") && cd "$parent" && ${rgPrefix} "$name"`,
		`else exit ${PATH_NOT_FOUND_EXIT_CODE}; fi`,
	].join("; ");
}

function runRemoteGrepCommand(
	connection: SshConnection,
	command: string,
	signal?: AbortSignal,
): Promise<RemoteGrepResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const child = connection.spawnRemoteCommand(command);
		child.stdin.end();
		let stdout = "";
		let stderr = "";
		let aborted = false;
		let killedDueToLimit = false;
		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > GREP_OUTPUT_BUFFER_MAX && !child.killed) {
				killedDueToLimit = true;
				child.kill();
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr, code, aborted, killedDueToLimit });
		});
	});
}

function isMatchLine(line: string): boolean {
	return /^[^:\n]+:\d+:/.test(line);
}

function formatRemoteGrepOutput(
	rawOutput: string,
	effectiveLimit: number,
): {
	output: string;
	details: GrepToolDetails;
} {
	const details: GrepToolDetails = {};
	const outputLines: string[] = [];
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	for (const line of rawOutput.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
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

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
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
	const command = buildRemoteGrepCommand(connection, input);
	const result = await runRemoteGrepCommand(connection, command, signal);
	if (result.aborted) {
		throw new Error("Operation aborted");
	}
	if (result.code === PATH_NOT_FOUND_EXIT_CODE) {
		throw new Error(`Path not found: ${connection.toRemotePath(input.path || ".")}`);
	}
	if (!result.killedDueToLimit && result.code !== 0 && result.code !== 1) {
		throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code ?? "unknown"}`);
	}
	if (!result.stdout.trim()) {
		return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	}

	const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
	const { output, details } = formatRemoteGrepOutput(result.stdout, effectiveLimit);
	if (result.killedDueToLimit) {
		const suffix = `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]`;
		return {
			content: [{ type: "text" as const, text: `${output}${suffix}` }],
			details: { ...details, truncation: details.truncation },
		};
	}
	return {
		content: [{ type: "text" as const, text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}
