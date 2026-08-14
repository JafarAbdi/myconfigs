import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

import { resolveCheckedOutPullRequest } from "./review-forge.ts";

const temporaryPaths: string[] = [];

after(() => {
	for (const path of temporaryPaths.reverse()) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	temporaryPaths.push(path);
	return path;
}

interface FakeGhResponse {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly code?: number;
	readonly hang?: boolean;
}

interface FakeGhCall {
	readonly args: string[];
	readonly cwd: string;
	readonly inheritedMarker: string | null;
	readonly githubToken: string | null;
}

interface FakeGh {
	readonly directory: string;
	calls(): FakeGhCall[];
	waitForCalls(count: number): Promise<void>;
}

function createFakeGh(responses: readonly FakeGhResponse[]): FakeGh {
	const directory = temporaryDirectory("review-forge-gh-");
	const binary = join(directory, "gh");
	const callsPath = join(directory, "calls.jsonl");
	const responsesPath = join(directory, "responses.json");
	writeFileSync(callsPath, "");
	writeFileSync(responsesPath, JSON.stringify(responses));
	writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
const callsPath = ${JSON.stringify(callsPath)};
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responsesPath)}, "utf8"));
const contents = fs.readFileSync(callsPath, "utf8");
const index = contents ? contents.trimEnd().split("\\n").length : 0;
const response = responses[index] ?? {};
fs.appendFileSync(callsPath, JSON.stringify({
	args: process.argv.slice(2),
	cwd: process.cwd(),
	inheritedMarker: process.env.REVIEW_FORGE_TEST_MARKER ?? null,
	githubToken: process.env.GITHUB_TOKEN ?? null,
}) + "\\n");
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
if (response.hang) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
process.exitCode = response.code ?? 0;
`);
	chmodSync(binary, 0o755);
	const calls = (): FakeGhCall[] => {
		const contents = readFileSync(callsPath, "utf8");
		// SAFETY: calls.jsonl is written only by this fixture's own appendFileSync call above, one FakeGhCall JSON object per line.
		return contents
			? contents.trimEnd().split("\n").map((line) => JSON.parse(line) as FakeGhCall)
			: [];
	};
	return {
		directory,
		calls,
		waitForCalls: async (count) => {
			if (calls().length >= count) return;
			await new Promise<void>((resolvePromise, reject) => {
				const watcher = watch(callsPath, () => {
					if (calls().length < count) return;
					watcher.close();
					resolvePromise();
				});
				watcher.once("error", reject);
				if (calls().length >= count) {
					watcher.close();
					resolvePromise();
				}
			});
		},
	};
}

async function withFakeGh(
	responses: readonly FakeGhResponse[],
	run: (fake: FakeGh) => Promise<void>,
): Promise<void> {
	const fake = createFakeGh(responses);
	const originalPath = process.env.PATH;
	process.env.PATH = originalPath
		? `${fake.directory}${delimiter}${originalPath}`
		: fake.directory;
	try {
		await run(fake);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
}

test("resolves the token before the checked-out branch PR with exact arguments and cwd", async () => {
	const repositoryRoot = temporaryDirectory("review-forge-repo-");
	const originalMarker = process.env.REVIEW_FORGE_TEST_MARKER;
	const originalGithubToken = process.env.GITHUB_TOKEN;
	process.env.REVIEW_FORGE_TEST_MARKER = "inherited";
	process.env.GITHUB_TOKEN = "inherited-parent-token";
	try {
		await withFakeGh([
			{ stdout: "private-token\n" },
			{ stdout: "42\n" },
		], async (fake) => {
			assert.deepEqual(await resolveCheckedOutPullRequest(repositoryRoot), {
				number: 42,
				githubToken: "private-token",
			});
			assert.deepEqual(fake.calls(), [
				{
					args: ["auth", "token"],
					cwd: repositoryRoot,
					inheritedMarker: "inherited",
					githubToken: "inherited-parent-token",
				},
				{
					args: ["pr", "view", "--json", "number", "--jq", ".number"],
					cwd: repositoryRoot,
					inheritedMarker: "inherited",
					githubToken: "inherited-parent-token",
				},
			]);
		});
	} finally {
		if (originalMarker === undefined) delete process.env.REVIEW_FORGE_TEST_MARKER;
		else process.env.REVIEW_FORGE_TEST_MARKER = originalMarker;
		if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
		else process.env.GITHUB_TOKEN = originalGithubToken;
	}
});

test("authentication failures and empty tokens suggest gh auth login without querying a PR", async () => {
	const repositoryRoot = temporaryDirectory("review-forge-auth-");
	await withFakeGh([
		{ stderr: "not logged in\n", code: 1 },
	], async (fake) => {
		await assert.rejects(
			resolveCheckedOutPullRequest(repositoryRoot),
			/GitHub CLI authentication failed; run `gh auth login`$/u,
		);
		assert.deepEqual(fake.calls().map((call) => call.args), [["auth", "token"]]);
	});
	await withFakeGh([
		{ stdout: " \n" },
	], async (fake) => {
		await assert.rejects(resolveCheckedOutPullRequest(repositoryRoot), /gh auth login/u);
		assert.equal(fake.calls().length, 1);
	});
});

test("a missing checked-out branch PR reports concise stderr without exposing the token", async () => {
	const repositoryRoot = temporaryDirectory("review-forge-no-pr-");
	await withFakeGh([
		{ stdout: "private-token\n" },
		{ stderr: "no matching pull request for private-token\n", code: 1 },
	], async () => {
		await assert.rejects(
			resolveCheckedOutPullRequest(repositoryRoot),
			(error) => {
				assert.equal(error instanceof Error, true);
				if (!(error instanceof Error)) return false;
				assert.match(error.message, /No pull request found for the checked-out branch/u);
				assert.match(error.message, /no matching pull request for \[redacted\]/u);
				assert.doesNotMatch(error.message, /private-token/u);
				return true;
			},
		);
	});
});

test("rejects malformed and non-positive pull request numbers", async () => {
	const repositoryRoot = temporaryDirectory("review-forge-number-");
	for (const output of ["", "0\n", "-1\n", "1.5\n", "1e3\n", "9007199254740992\n", "not-a-number\n"]) {
		await withFakeGh([
			{ stdout: "private-token\n" },
			{ stdout: output },
		], async () => {
			await assert.rejects(
				resolveCheckedOutPullRequest(repositoryRoot),
				/invalid pull request number; expected a positive safe integer/u,
			);
		});
	}
});

test("reports an actionable error when gh is missing", async () => {
	const repositoryRoot = temporaryDirectory("review-forge-missing-repo-");
	const emptyPath = temporaryDirectory("review-forge-empty-path-");
	const originalPath = process.env.PATH;
	process.env.PATH = emptyPath;
	try {
		await assert.rejects(
			resolveCheckedOutPullRequest(repositoryRoot),
			/GitHub CLI is not installed or not on PATH/u,
		);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});

test("cancels an in-flight PR lookup through AbortSignal", async () => {
	const repositoryRoot = temporaryDirectory("review-forge-cancel-");
	await withFakeGh([
		{ stdout: "private-token\n" },
		{ hang: true },
	], async (fake) => {
		const controller = new AbortController();
		const pending = resolveCheckedOutPullRequest(repositoryRoot, controller.signal);
		await fake.waitForCalls(2);
		const reason = new Error("cancelled pull request lookup");
		controller.abort(reason);
		await assert.rejects(pending, (error) => error === reason);
	});
});

test("the adapter uses only async argument-array spawning without shell or timers", () => {
	const source = readFileSync(new URL("./review-forge.ts", import.meta.url), "utf8");
	assert.match(source, /spawn\(GH_BINARY, args,/u);
	assert.doesNotMatch(source, /\b(?:exec|execFile|execSync|execFileSync|spawnSync)\s*\(/u);
	assert.doesNotMatch(source, /\bshell\s*:/u);
	assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|setImmediate)\s*\(/u);
	assert.doesNotMatch(source, /\b(?:GH_TOKEN|GITHUB_TOKEN)\b/u);
});
