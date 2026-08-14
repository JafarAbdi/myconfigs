import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { after, test } from "node:test";

import {
	addWiffComment,
	addWiffReply,
	createWiffSession,
	deriveWiffDataDir,
	hasWiffSession,
	parseWiffState,
	pullWiffReview,
	pushWiffReview,
	readWiffState,
	refreshWiffSession,
	removeWiffSession,
	renderWiffMarkdown,
	resolveWiffComment,
	resumeWiff,
	synthesisWiffComments,
	type AddWiffReplyOptions,
	type ResolveWiffCommentOptions,
	type WiffBaseOptions,
	type WiffTui,
} from "./review-wiff.ts";

const temporaryPaths: string[] = [];

after(() => {
	for (const path of temporaryPaths.reverse()) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	temporaryPaths.push(path);
	return path;
}

function git(repository: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" });
}

function createRepository(): string {
	const repository = temporaryDirectory("review-wiff-repo-");
	git(repository, "init", "-q", "-b", "main");
	git(repository, "config", "user.name", "Review Wiff test");
	git(repository, "config", "user.email", "review-wiff@example.invalid");
	writeFileSync(join(repository, "a.txt"), "line1\n");
	git(repository, "add", "-A");
	git(repository, "commit", "-q", "-m", "base");
	return repository;
}

function changeWorktree(repository: string, content = "line1\nline2\n"): Buffer {
	writeFileSync(join(repository, "a.txt"), content);
	return execFileSync("git", ["diff", "--no-color"], { cwd: repository });
}

function runRealWiff(
	wiffDataDir: string,
	repositoryRoot: string,
	arguments_: readonly string[],
	input?: Buffer,
): Buffer {
	return execFileSync("wiff", arguments_, {
		cwd: repositoryRoot,
		env: { ...process.env, WIFF_DATA_DIR: wiffDataDir },
		input,
	});
}

interface FakeWiffResponse {
	readonly stdout?: Buffer | string;
	readonly stderr?: string;
	readonly code?: number;
	readonly hang?: boolean;
}

interface FakeWiffCall {
	readonly args: string[];
	readonly cwd: string;
	readonly wiffDataDir: string | null;
	readonly githubToken: string | null;
	readonly stdinBase64: string;
}

interface FakeWiff {
	readonly directory: string;
	calls(): FakeWiffCall[];
	waitForCalls(count: number): Promise<void>;
	respond(response: FakeWiffResponse): void;
}

function createFakeWiff(): FakeWiff {
	const directory = temporaryDirectory("review-wiff-fake-");
	const binary = join(directory, "wiff");
	const callsPath = join(directory, "calls.jsonl");
	const responsePath = join(directory, "response.json");
	writeFileSync(callsPath, "");
	writeFileSync(responsePath, "{}");
	writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const callsPath = ${JSON.stringify(callsPath)};
const responsePath = ${JSON.stringify(responsePath)};
function finish(input) {
	const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
	fs.appendFileSync(callsPath, JSON.stringify({
		args,
		cwd: process.cwd(),
		wiffDataDir: process.env.WIFF_DATA_DIR ?? null,
		githubToken: process.env.GITHUB_TOKEN ?? null,
		stdinBase64: input.toString("base64"),
	}) + "\\n");
	if (response.stdoutBase64) process.stdout.write(Buffer.from(response.stdoutBase64, "base64"));
	if (response.stderr) process.stderr.write(response.stderr);
	if (response.hang) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		return;
	}
	process.exitCode = response.code ?? 0;
}
if (args[0] === "resume" || (args[0] === "forge" && args[1] === "pull")) {
	finish(Buffer.alloc(0));
} else {
	const chunks = [];
	process.stdin.on("data", chunk => chunks.push(chunk));
	process.stdin.on("end", () => finish(Buffer.concat(chunks)));
}
`);
	chmodSync(binary, 0o755);
	const calls = (): FakeWiffCall[] => {
		const contents = readFileSync(callsPath, "utf8");
		// SAFETY: calls.jsonl is written only by this fixture's own appendFileSync call above, one FakeWiffCall JSON object per line.
		return contents.length === 0
			? []
			: contents.trimEnd().split("\n").map((line) => JSON.parse(line) as FakeWiffCall);
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
		respond: ({ stdout = "", stderr, code, hang }) => {
			writeFileSync(responsePath, JSON.stringify({
				stdoutBase64: Buffer.from(stdout).toString("base64"),
				stderr,
				code,
				hang,
			}));
		},
	};
}

async function withFakeWiff(run: (fake: FakeWiff) => Promise<void>): Promise<void> {
	const fake = createFakeWiff();
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

function baseOptions(): WiffBaseOptions {
	return {
		repositoryRoot: temporaryDirectory("review-wiff-cwd-"),
		wiffDataDir: temporaryDirectory("review-wiff-private-"),
	};
}

function recordingTui(calls: string[]): WiffTui {
	return {
		stop: () => calls.push("stop"),
		start: () => calls.push("start"),
		requestRender: (force?: boolean) => calls.push(`requestRender(${force})`),
	};
}

const renderedState = JSON.stringify({
	schema_version: 6,
	session: { id: "session-1", project: "repository-project", source: "stdin" },
	description: {
		author: { name: "pi-review", kind: "agent" },
		title: "Review title",
		body: "Review body",
	},
	comments: [],
	verdicts: [],
});

const validRenderedComment = {
	id: "01J00000000000000000000001",
	number: 1,
	body: "Review body",
	target: { target: "review" },
	resolved: false,
	deleted: false,
	author: { name: "review/tests", kind: "agent" },
};

function stateWithComments(comments: readonly unknown[]): string {
	return JSON.stringify({
		schema_version: 6,
		session: { id: "session-1", project: "project-1", source: "stdin" },
		comments,
	});
}

test("deriveWiffDataDir requires an absolute agent directory and one safe session path component", () => {
	const agentDir = resolve(temporaryDirectory("review-wiff-agent-"));
	assert.equal(deriveWiffDataDir(agentDir, "018f-ABC_123.test"), join(agentDir, "wiff", "018f-ABC_123.test"));
	assert.throws(() => deriveWiffDataDir("relative/agent", "session"), /absolute Pi agent directory/u);
	for (const unsafe of ["", ".", "..", "../escape", "a/b", "a\\b", "a b"])
		assert.throws(() => deriveWiffDataDir(agentDir, unsafe), /safe Pi session ID path component/u);
});

test("parseWiffState retains every schema-6 comment target and tolerates unknown fields", () => {
	const state = parseWiffState(JSON.stringify({
		schema_version: 6,
		session: {
			id: "session-1",
			project: "project-1",
			source: "forge github",
			repo_root: "/ignored",
		},
		description: {
			author: { name: "alice", kind: "human", ignored: true },
			title: "Title",
			body: "",
			extra: "ignored",
		},
		comments: [
			{
				...validRenderedComment,
				body: "Overall finding",
				extra: "ignored",
				target: { target: "review", ignored: true },
			},
			{
				...validRenderedComment,
				id: "01J00000000000000000000002",
				number: 2,
				body: "Whole-file finding",
				target: { target: "file", file: "src/a.ts", ignored: true },
			},
			{
				...validRenderedComment,
				id: "01J00000000000000000000003",
				number: 3,
				body: "Range finding",
				target: {
					target: "lines",
					file: "src/a.ts",
					side: "before",
					start_line: 4,
					end_line: 7,
					ignored: true,
				},
			},
			{
				...validRenderedComment,
				id: "01J00000000000000000000004",
				number: 4,
				body: "Reply",
				target: { target: "comment", id: "01J00000000000000000000001", ignored: true },
			},
		],
		verdicts: [{
			author: { name: "alice", kind: "human" },
			disposition: "request_changes",
		}],
		extra: "ignored",
	}));
	assert.deepEqual(state.session, {
		id: "session-1",
		project: "project-1",
		source: "forge github",
	});
	assert.deepEqual(state.description, {
		author: { name: "alice", kind: "human" },
		title: "Title",
		body: "",
	});
	assert.deepEqual(state.comments, [
		{
			id: "01J00000000000000000000001",
			number: 1,
			body: "Overall finding",
			target: { target: "review" },
			resolved: false,
			deleted: false,
			author: { name: "review/tests", kind: "agent" },
		},
		{
			id: "01J00000000000000000000002",
			number: 2,
			body: "Whole-file finding",
			target: { target: "file", file: "src/a.ts" },
			resolved: false,
			deleted: false,
			author: { name: "review/tests", kind: "agent" },
		},
		{
			id: "01J00000000000000000000003",
			number: 3,
			body: "Range finding",
			target: {
				target: "lines",
				file: "src/a.ts",
				side: "before",
				startLine: 4,
				endLine: 7,
			},
			resolved: false,
			deleted: false,
			author: { name: "review/tests", kind: "agent" },
		},
		{
			id: "01J00000000000000000000004",
			number: 4,
			body: "Reply",
			target: { target: "comment", id: "01J00000000000000000000001" },
			resolved: false,
			deleted: false,
			author: { name: "review/tests", kind: "agent" },
		},
	]);
	assert.equal(state.verdicts[0]?.author.kind, "human");

	const minimal = parseWiffState(stateWithComments([]));
	assert.equal(minimal.description, undefined);
	assert.deepEqual(minimal.verdicts, []);
});

test("synthesisWiffComments returns only unresolved, non-deleted top-level comments", () => {
	const state = parseWiffState(stateWithComments([
		validRenderedComment,
		{
			...validRenderedComment,
			id: "01J00000000000000000000002",
			number: 2,
			target: {
				target: "lines",
				file: "src/b.ts",
				side: "after",
				start_line: 9,
				end_line: 9,
			},
		},
		{ ...validRenderedComment, id: "resolved", number: 3, resolved: true },
		{ ...validRenderedComment, id: "deleted", number: 4, deleted: true },
		{
			...validRenderedComment,
			id: "reply",
			number: 5,
			target: { target: "comment", id: validRenderedComment.id },
		},
	]));
	assert.deepEqual(
		synthesisWiffComments(state).map(({ id }) => id),
		[validRenderedComment.id, "01J00000000000000000000002"],
	);
});

test("parseWiffState rejects malformed required and optional schema-6 fields", () => {
	assert.throws(() => parseWiffState("not json"), /not valid JSON/u);
	assert.throws(
		() => parseWiffState(JSON.stringify({
			schema_version: 7,
			session: { id: "s", project: "p", source: "stdin" },
			comments: [],
		})),
		/schema_version/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({
			schema_version: 6,
			session: { id: "s", project: "p" },
			comments: [],
		})),
		/session\.source/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({
			schema_version: 6,
			session: { id: "s", project: "p", source: "stdin" },
			description: { author: { name: "bot", kind: "robot" }, title: "x", body: "" },
			comments: [],
		})),
		/kind must be human or agent/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({
			schema_version: 6,
			session: { id: "s", project: "p", source: "stdin" },
		})),
		/comments must be an array/u,
	);
});

type MalformedFieldValue = string | number | boolean | null | Record<string, string | number>;

test("parseWiffState rejects malformed schema-6 comment fields and targets", () => {
	const malformed: Array<readonly [Record<string, MalformedFieldValue>, RegExp]> = [
		[{ number: 0 }, /comments\[0\]\.number must be a positive integer/u],
		[{ number: 1.5 }, /comments\[0\]\.number must be a positive integer/u],
		[{ body: null }, /comments\[0\]\.body must be a string/u],
		[{ target: null }, /comments\[0\]\.target must be an object/u],
		[{ target: {} }, /comments\[0\]\.target\.target must be a non-empty string/u],
		[{ target: { target: "directory" } }, /comments\[0\]\.target\.target is not supported/u],
		[{ target: { target: "file", file: "" } }, /comments\[0\]\.target\.file/u],
		[{
			target: { target: "lines", file: "", side: "after", start_line: 1, end_line: 1 },
		}, /comments\[0\]\.target\.file/u],
		[{
			target: { target: "lines", file: "a.ts", side: "both", start_line: 1, end_line: 1 },
		}, /comments\[0\]\.target\.side must be before or after/u],
		[{
			target: { target: "lines", file: "a.ts", side: "after", start_line: 0, end_line: 1 },
		}, /comments\[0\]\.target\.start_line must be a positive integer/u],
		[{
			target: { target: "lines", file: "a.ts", side: "after", start_line: 1, end_line: 1.5 },
		}, /comments\[0\]\.target\.end_line must be a positive integer/u],
		[{
			target: { target: "lines", file: "a.ts", side: "after", start_line: 3, end_line: 2 },
		}, /comments\[0\]\.target\.start_line must not exceed comments\[0\]\.target\.end_line/u],
		[{ target: { target: "comment", id: "" } }, /comments\[0\]\.target\.id/u],
	];
	for (const [overrides, expected] of malformed) {
		assert.throws(
			() => parseWiffState(stateWithComments([{ ...validRenderedComment, ...overrides }])),
			expected,
		);
	}
});

test("real Wiff calls isolate private Pi storage and leave ordinary Wiff storage untouched", async () => {
	const repositoryRoot = createRepository();
	const ordinaryDataDir = temporaryDirectory("review-wiff-ordinary-");
	const wiffDataDir = temporaryDirectory("review-wiff-private-");
	const patch = changeWorktree(repositoryRoot);
	const inheritedWiffDataDir = process.env.WIFF_DATA_DIR;

	runRealWiff(ordinaryDataDir, repositoryRoot, [
		"new", "--no-tui", "--agent", "--author", "ordinary", "--description", "Ordinary review",
	], patch);
	const ordinaryBefore = runRealWiff(ordinaryDataDir, repositoryRoot, ["render", "--format", "json"]);

	assert.equal(await hasWiffSession({ repositoryRoot, wiffDataDir }), false);
	await createWiffSession({
		repositoryRoot,
		wiffDataDir,
		patch,
		description: "Private review\n\nPrivate body",
	});
	const privateState = await readWiffState({ repositoryRoot, wiffDataDir });
	assert.equal(privateState.session.source, "stdin");
	assert.deepEqual(privateState.description, {
		author: { name: "pi-review", kind: "agent" },
		title: "Private review",
		body: "Private body",
	});
	assert.notEqual(privateState.session.id, parseWiffState(ordinaryBefore.toString("utf8")).session.id);

	const privatePath = runRealWiff(wiffDataDir, repositoryRoot, ["session", "path"])
		.toString("utf8")
		.trimEnd();
	assert.equal(privatePath.startsWith(`${wiffDataDir}${sep}`), true);
	assert.deepEqual(
		runRealWiff(ordinaryDataDir, repositoryRoot, ["render", "--format", "json"]),
		ordinaryBefore,
	);
	assert.equal(process.env.WIFF_DATA_DIR, inheritedWiffDataDir);
});

test("hasWiffSession checks the whole private data directory and removes exactly one terminal newline", async () => {
	await withFakeWiff(async (fake) => {
		const options = baseOptions();
		const inheritedWiffDataDir = process.env.WIFF_DATA_DIR;
		for (const [stdout, expected] of [
			["No sessions.", false],
			["No sessions.\n", false],
			["No sessions.\r\n", false],
			["No sessions.\n\n", true],
			["No sessions. \n", true],
			["one session\n", true],
		] as const) {
			fake.respond({ stdout });
			assert.equal(await hasWiffSession(options), expected, JSON.stringify(stdout));
		}
		for (const call of fake.calls()) {
			assert.deepEqual(call.args, ["session", "list", "--all"]);
			assert.equal(call.cwd, options.repositoryRoot);
			assert.equal(call.wiffDataDir, options.wiffDataDir);
		}
		assert.equal(process.env.WIFF_DATA_DIR, inheritedWiffDataDir);
	});
});

test("captured Wiff calls preserve exact stdin and target only pinned operations", async () => {
	await withFakeWiff(async (fake) => {
		const base = baseOptions();
		const pinned = { ...base, session: "session-1", project: "repository-project" };
		const firstPatch = Buffer.from([0, 10, 255, 65]);
		const secondPatch = Buffer.from("second patch\n", "utf8");

		fake.respond({});
		await createWiffSession({ ...base, patch: firstPatch, description: "Title\n\nBody" });
		fake.respond({ stdout: renderedState });
		assert.equal((await readWiffState(base)).session.id, "session-1");
		assert.equal((await readWiffState(pinned)).session.id, "session-1");
		fake.respond({ stdout: "# Markdown\r\n\n" });
		assert.equal(await renderWiffMarkdown(base), "# Markdown\r\n\n");
		assert.equal(await renderWiffMarkdown(pinned), "# Markdown\r\n\n");
		fake.respond({});
		await refreshWiffSession({ ...pinned, patch: secondPatch });
		await addWiffComment({
			...pinned,
			author: "review/correctness",
			file: "src/a file.ts",
			line: 7,
			side: "before",
			body: "Exact body.\n",
		});
		await removeWiffSession(pinned);

		const calls = fake.calls();
		assert.deepEqual(calls.map((call) => call.args), [
			["new", "--no-tui", "--agent", "--author", "pi-review", "--description", "Title\n\nBody"],
			["render", "--format", "json"],
			["render", "--format", "json", "--session", "session-1", "--project", "repository-project"],
			["render"],
			["render", "--session", "session-1", "--project", "repository-project"],
			[
				"refresh", "--agent", "--author", "pi-review",
				"--session", "session-1", "--project", "repository-project",
			],
			[
				"comment", "add", "--agent", "--author", "review/correctness",
				"--session", "session-1", "--project", "repository-project",
				"--file", "src/a file.ts", "--line", "7", "--side", "before",
			],
			["session", "rm", "session-1", "--project", "repository-project"],
		]);
		assert.equal(calls[0]?.stdinBase64, firstPatch.toString("base64"));
		assert.equal(calls[5]?.stdinBase64, secondPatch.toString("base64"));
		assert.equal(calls[6]?.stdinBase64, Buffer.from("Exact body.\n").toString("base64"));
		for (const call of calls) assert.equal(call.wiffDataDir, base.wiffDataDir);
	});
});

test("reply and resolve use exact pinned durable IDs, agent attribution, stdin, and cancellation", async () => {
	await withFakeWiff(async (fake) => {
		const inheritedWiffDataDir = process.env.WIFF_DATA_DIR;
		const reply: AddWiffReplyOptions = {
			...baseOptions(),
			session: "session-1",
			project: "repository-project",
			author: "review/fixer",
			commentId: "01J00000000000000000000001",
			body: "Fixed the root cause.\n",
		};
		const resolveOptions: ResolveWiffCommentOptions = {
			repositoryRoot: reply.repositoryRoot,
			wiffDataDir: reply.wiffDataDir,
			session: reply.session,
			project: reply.project,
			author: reply.author,
			commentId: reply.commentId,
		};

		fake.respond({});
		await addWiffReply(reply);
		await resolveWiffComment(resolveOptions);

		const controller = new AbortController();
		fake.respond({ hang: true });
		const pending = resolveWiffComment({ ...resolveOptions, signal: controller.signal });
		await fake.waitForCalls(3);
		controller.abort(new Error("cancelled resolution"));
		await assert.rejects(pending, /cancelled resolution/u);

		const calls = fake.calls();
		assert.deepEqual(calls[0]?.args, [
			"comment", "add", "--agent", "--author", "review/fixer",
			"--session", "session-1", "--project", "repository-project",
			"--reply-to", "01J00000000000000000000001",
		]);
		for (const call of calls.slice(1)) {
			assert.deepEqual(call.args, [
				"comment", "resolve", "01J00000000000000000000001",
				"--agent", "--author", "review/fixer",
				"--session", "session-1", "--project", "repository-project",
			]);
		}
		assert.equal(calls[0]?.stdinBase64, Buffer.from(reply.body).toString("base64"));
		assert.equal(calls[1]?.stdinBase64, "");
		for (const call of calls) {
			assert.equal(call.cwd, reply.repositoryRoot);
			assert.equal(call.wiffDataDir, reply.wiffDataDir);
		}
		assert.equal(process.env.WIFF_DATA_DIR, inheritedWiffDataDir);
	});
});

test("create and refresh reject empty patches before spawning Wiff", async () => {
	await withFakeWiff(async (fake) => {
		const base = baseOptions();
		const pinned = { ...base, session: "session-1", project: "project-1" };
		await assert.rejects(
			createWiffSession({ ...base, patch: Buffer.alloc(0), description: "x" }),
			/non-empty patch bytes/u,
		);
		await assert.rejects(
			refreshWiffSession({ ...pinned, patch: Buffer.alloc(0) }),
			/non-empty patch bytes/u,
		);
		assert.deepEqual(fake.calls(), []);
	});
});

test("resume and pull use exact arguments, private child environments, and always restore the TUI", async () => {
	await withFakeWiff(async (fake) => {
		const base = baseOptions();
		const inheritedGithubToken = process.env.GITHUB_TOKEN;

		const resumeCalls: string[] = [];
		fake.respond({});
		await resumeWiff({
			...base,
			session: "session-1",
			project: "project-1",
			tui: recordingTui(resumeCalls),
		});
		assert.deepEqual(resumeCalls, ["stop", "start", "requestRender(true)"]);

		const pullCalls: string[] = [];
		fake.respond({ code: 9 });
		await assert.rejects(
			pullWiffReview({
				...base,
				pullRequestNumber: 42,
				githubToken: "private-pull-token",
				tui: recordingTui(pullCalls),
			}),
			/wiff forge pull exited \(9\)/u,
		);
		assert.deepEqual(pullCalls, ["stop", "start", "requestRender(true)"]);

		const [resumeCall, pullCall] = fake.calls();
		assert.deepEqual(resumeCall?.args, [
			"resume", "--session", "session-1", "--project", "project-1",
		]);
		assert.deepEqual(pullCall?.args, ["forge", "pull", "42"]);
		assert.equal(resumeCall?.wiffDataDir, base.wiffDataDir);
		assert.equal(pullCall?.wiffDataDir, base.wiffDataDir);
		assert.equal(pullCall?.githubToken, "private-pull-token");
		assert.equal(process.env.GITHUB_TOKEN, inheritedGithubToken);
	});
});

test("push captures failures, keeps the token child-only, supports agent authors, and is cancellable", async () => {
	await withFakeWiff(async (fake) => {
		const options = {
			...baseOptions(),
			session: "session-1",
			project: "project-1",
			author: "review/tests",
			githubToken: "private-push-token",
		};
		const inheritedGithubToken = process.env.GITHUB_TOKEN;

		fake.respond({});
		await pushWiffReview({ ...options, agent: true });
		fake.respond({ stderr: "forge refused publication\n", code: 7 });
		await assert.rejects(
			pushWiffReview(options),
			/wiff forge push failed \(exit 7\): forge refused publication/u,
		);

		const controller = new AbortController();
		fake.respond({ hang: true });
		const pending = pushWiffReview({ ...options, signal: controller.signal });
		await fake.waitForCalls(3);
		controller.abort(new Error("cancelled publication"));
		await assert.rejects(pending, /cancelled publication/u);

		const calls = fake.calls();
		assert.deepEqual(calls[0]?.args, [
			"forge", "push", "--session", "session-1", "--author", "review/tests", "--agent",
		]);
		assert.deepEqual(calls[1]?.args, [
			"forge", "push", "--session", "session-1", "--author", "review/tests",
		]);
		for (const call of calls) {
			assert.equal(call.args.includes("--project"), false);
			assert.equal(call.wiffDataDir, options.wiffDataDir);
			assert.equal(call.githubToken, "private-push-token");
		}
		assert.equal(process.env.GITHUB_TOKEN, inheritedGithubToken);
	});
});

test("spawn failures and pinned-state mismatches remain actionable", async () => {
	await withFakeWiff(async (fake) => {
		const base = baseOptions();
		fake.respond({ stderr: "missing state\n", code: 2 });
		await assert.rejects(readWiffState(base), /wiff render --format json failed \(exit 2\): missing state/u);

		fake.respond({ stdout: renderedState });
		await assert.rejects(
			readWiffState({ ...base, session: "other-session", project: "repository-project" }),
			/Wiff returned session session-1, expected other-session/u,
		);
	});

	const repositoryRoot = temporaryDirectory("review-wiff-missing-cwd-");
	const wiffDataDir = temporaryDirectory("review-wiff-missing-data-");
	const emptyPath = temporaryDirectory("review-wiff-empty-path-");
	const originalPath = process.env.PATH;
	process.env.PATH = emptyPath;
	try {
		await assert.rejects(
			hasWiffSession({ repositoryRoot, wiffDataDir }),
			/wiff is not installed or not on PATH/u,
		);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});

test("the adapter never assigns process.env.WIFF_DATA_DIR or uses shell-like synchronous transport", () => {
	const source = readFileSync(new URL("./review-wiff.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /process\.env\.WIFF_DATA_DIR\s*=/u);
	for (const forbidden of ["spawnSync", "execSync", "execFileSync", "setTimeout", "setInterval", "createHash"])
		assert.equal(source.includes(forbidden), false, `review-wiff.ts must not use ${forbidden}`);
});
