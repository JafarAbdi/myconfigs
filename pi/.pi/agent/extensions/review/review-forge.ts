import { spawn } from "node:child_process";

const GH_BINARY = "gh";
const MAX_GH_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_DETAIL_CHARS = 4_096;

interface GhCommandResult {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly code: number | null;
}

function ghSpawnError(cause: NodeJS.ErrnoException): Error {
	if (cause.code === "ENOENT")
		return new Error("GitHub CLI is not installed or not on PATH");
	return new Error(`GitHub CLI failed to start: ${cause.message}`, { cause });
}

function runGh(
	repositoryRoot: string,
	args: readonly string[],
	signal?: AbortSignal,
): Promise<GhCommandResult> {
	signal?.throwIfAborted();
	return new Promise((resolvePromise, reject) => {
		const child = spawn(GH_BINARY, args, {
			cwd: repositoryRoot,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let exceeded: "stdout" | "stderr" | undefined;

		const collect = (stream: "stdout" | "stderr", chunks: Buffer[]) => {
			let bytes = 0;
			return (chunk: Buffer): void => {
				if (exceeded) return;
				bytes += chunk.length;
				if (bytes > MAX_GH_OUTPUT_BYTES) {
					exceeded = stream;
					child.kill("SIGKILL");
					return;
				}
				chunks.push(chunk);
			};
		};

		child.stdout.on("data", collect("stdout", stdout));
		child.stderr.on("data", collect("stderr", stderr));
		child.once("error", (error: NodeJS.ErrnoException) => {
			reject(signal?.aborted ? (signal.reason ?? error) : ghSpawnError(error));
		});
		child.once("close", (code) => {
			if (exceeded) {
				reject(new Error(`GitHub CLI ${exceeded} exceeded ${MAX_GH_OUTPUT_BYTES} bytes`));
				return;
			}
			resolvePromise({
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				code,
			});
		});
	});
}

function conciseStderr(stderr: Buffer, secret?: string): string {
	let detail = stderr.toString("utf8").trim();
	if (secret) detail = detail.split(secret).join("[redacted]");
	return detail.slice(0, MAX_ERROR_DETAIL_CHARS);
}

function authenticationError(): Error {
	return new Error("GitHub CLI authentication failed; run `gh auth login`");
}

/** Resolves the current GitHub CLI token without exposing it in process state or errors. */
export async function resolveGithubToken(
	repositoryRoot: string,
	signal?: AbortSignal,
): Promise<string> {
	const auth = await runGh(repositoryRoot, ["auth", "token"], signal);
	if (auth.code !== 0) throw authenticationError();
	const token = auth.stdout.toString("utf8").trim();
	if (!token) throw authenticationError();
	return token;
}

/** Resolves the checked-out branch's GitHub pull request and current CLI token. */
export async function resolveCheckedOutPullRequest(
	repositoryRoot: string,
	signal?: AbortSignal,
): Promise<{ number: number; githubToken: string }> {
	const githubToken = await resolveGithubToken(repositoryRoot, signal);
	const pullRequest = await runGh(
		repositoryRoot,
		["pr", "view", "--json", "number", "--jq", ".number"],
		signal,
	);
	if (pullRequest.code !== 0) {
		const detail = conciseStderr(pullRequest.stderr, githubToken);
		throw new Error(
			`No pull request found for the checked-out branch${detail ? `: ${detail}` : ""}`,
		);
	}
	const numberText = pullRequest.stdout.toString("utf8").trim();
	const number = Number(numberText);
	if (!/^[1-9][0-9]*$/u.test(numberText) || !Number.isSafeInteger(number)) {
		throw new Error(
			"GitHub CLI returned an invalid pull request number; expected a positive safe integer",
		);
	}
	return { number, githubToken };
}
