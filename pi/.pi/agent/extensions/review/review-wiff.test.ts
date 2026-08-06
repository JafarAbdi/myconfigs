import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Isolate every `wiff` invocation this file makes from the operator's real Wiff data.
const WIFF_DATA_DIR = mkdtempSync(join(tmpdir(), "review-wiff-data-"));
process.env.WIFF_DATA_DIR = WIFF_DATA_DIR;
after(() => {
	rmSync(WIFF_DATA_DIR, { recursive: true, force: true });
});

const {
	addWiffComment,
	createWiffSession,
	deriveWiffProject,
	hasWiffSession,
	parseWiffState,
	readWiffState,
	removeWiffSession,
	refreshWiffSession,
	renderWiffMarkdown,
	resumeWiff,
} = await import("./review-wiff.ts");

function git(repository: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" });
}

function createRepository(): string {
	const repository = mkdtempSync(join(tmpdir(), "review-wiff-repo-"));
	git(repository, "init", "-q", "-b", "main");
	git(repository, "config", "user.name", "Review Wiff test");
	git(repository, "config", "user.email", "review-wiff@example.invalid");
	writeFileSync(join(repository, "a.txt"), "line1\n");
	git(repository, "add", "-A");
	git(repository, "commit", "-q", "-m", "base");
	return repository;
}

function gitDiff(repository: string): Buffer {
	return execFileSync("git", ["diff", "--no-color"], { cwd: repository });
}

/** Leaves an uncommitted worktree change so `git diff` against the base commit is non-empty. */
function changeWorktree(repository: string): void {
	writeFileSync(join(repository, "a.txt"), "line1\nline2\n");
}

function freshProject(): string {
	return deriveWiffProject(randomUUID());
}

async function newSession(
	repositoryRoot: string,
	project: string,
	patch: Buffer,
): Promise<void> {
	await createWiffSession({
		repositoryRoot,
		project,
		patch,
		description: "Pi review test\n\nSource: staged",
	});
}

test("deriveWiffProject requires a non-empty full Pi session ID and prefixes it", () => {
	assert.equal(deriveWiffProject("abc123"), "pi-review-abc123");
	assert.throws(() => deriveWiffProject(""), /non-empty/u);
});

test("parseWiffState accepts a minimal schema-6 document and exposes session, comments, and verdicts", () => {
	const state = parseWiffState(JSON.stringify({
		schema_version: 6,
		session: { id: "abc123", project: "pi-review-abc123", extra: "ignored" },
		comments: [
			{
				id: "c1",
				resolved: false,
				deleted: false,
				author: { name: "review/contract", kind: "agent" },
				body: "ignored extra field",
			},
		],
		verdicts: [
			{ author: { name: "juruc", kind: "human" }, disposition: "request_changes" },
		],
	}));
	assert.deepEqual(state.session, { id: "abc123", project: "pi-review-abc123" });
	assert.equal(state.comments.length, 1);
	assert.deepEqual(state.comments[0], {
		id: "c1",
		resolved: false,
		deleted: false,
		author: { name: "review/contract", kind: "agent" },
	});
	assert.deepEqual(state.verdicts, [
		{ author: { name: "juruc", kind: "human" }, disposition: "request_changes" },
	]);
});

test("parseWiffState defaults verdicts to an empty array when the field is absent", () => {
	const state = parseWiffState(JSON.stringify({
		schema_version: 6,
		session: { id: "abc123", project: "pi-review-abc123" },
		comments: [],
	}));
	assert.deepEqual(state.verdicts, []);
});

test("parseWiffState fails visibly on malformed JSON, unsupported schema, and missing or malformed fields", () => {
	assert.throws(() => parseWiffState("not json"), /not valid JSON/u);
	assert.throws(
		() => parseWiffState(JSON.stringify({ schema_version: 7, session: {}, comments: [] })),
		/schema_version/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({ schema_version: 6, session: { project: "p" }, comments: [] })),
		/session\.id/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({
			schema_version: 6,
			session: { id: "abc", project: "p" },
			comments: [],
			verdicts: [{ author: { name: "juruc" }, disposition: "approve" }],
		})),
		/verdicts\[0\]\.author\.kind/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({ schema_version: 6, session: { id: "abc", project: "p" } })),
		/comments must be an array/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({
			schema_version: 6,
			session: { id: "abc", project: "p" },
			comments: [{
				id: "c1",
				resolved: false,
				deleted: false,
				author: { name: "mystery", kind: "robot" },
			}],
		})),
		/kind must be human or agent/u,
	);
	assert.throws(
		() => parseWiffState(JSON.stringify({
			schema_version: 6,
			session: { id: "abc", project: "p" },
			comments: [],
			verdicts: [{ author: { name: "juruc", kind: "human" }, disposition: "maybe" }],
		})),
		/disposition is not supported/u,
	);
});

test("test isolation actually holds: a created session's log lives under the temp WIFF_DATA_DIR", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, project, gitDiff(repositoryRoot));
		const sessionPath = execFileSync("wiff", ["session", "path", "--project", project], {
			cwd: repositoryRoot,
			encoding: "utf8",
		}).trim();
		assert.equal(sessionPath.startsWith(WIFF_DATA_DIR), true);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("hasWiffSession is false only on exact `No sessions.` output, true otherwise", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		assert.equal(await hasWiffSession({ repositoryRoot, project }), false);
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, project, gitDiff(repositoryRoot));
		assert.equal(await hasWiffSession({ repositoryRoot, project }), true);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("every command is scoped to its Pi-derived project; a fresh project stays isolated", async () => {
	const repositoryRoot = createRepository();
	const projectA = freshProject();
	const projectB = freshProject();
	try {
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, projectA, gitDiff(repositoryRoot));
		assert.equal(await hasWiffSession({ repositoryRoot, project: projectA }), true);
		assert.equal(await hasWiffSession({ repositoryRoot, project: projectB }), false);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("create and refresh pipe exact non-empty patch bytes to Wiff, and refresh rebases prior comments", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		changeWorktree(repositoryRoot);
		const firstPatch = gitDiff(repositoryRoot);
		await newSession(repositoryRoot, project, firstPatch);
		const created = await readWiffState({ repositoryRoot, project });
		assert.equal(created.session.project, project);

		await addWiffComment({
			repositoryRoot,
			project,
			session: created.session.id,
			author: "review/contract",
			file: "a.txt",
			line: 2,
			body: "Looks fine.",
		});
		const beforeRefresh = await readWiffState({ repositoryRoot, project });
		const publishedCommentId = beforeRefresh.comments[0]?.id;

		writeFileSync(join(repositoryRoot, "a.txt"), "line1\nline2\nline3\n");
		const secondPatch = gitDiff(repositoryRoot);
		assert.notDeepEqual(secondPatch, firstPatch);
		await refreshWiffSession({ repositoryRoot, project, patch: secondPatch });

		const refreshed = await readWiffState({ repositoryRoot, project });
		assert.equal(refreshed.session.id, created.session.id);
		assert.equal(refreshed.comments.length, 1);
		assert.equal(refreshed.comments[0]?.id, publishedCommentId);

		const markdown = await renderWiffMarkdown({ repositoryRoot, project });
		assert.match(markdown, /line2/u);
		assert.match(markdown, /Looks fine\./u);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("createWiffSession and refreshWiffSession reject empty patch bytes without spawning Wiff", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		await assert.rejects(
			createWiffSession({ repositoryRoot, project, patch: Buffer.alloc(0), description: "x" }),
			/non-empty patch bytes/u,
		);
		assert.equal(await hasWiffSession({ repositoryRoot, project }), false);
		await assert.rejects(
			refreshWiffSession({ repositoryRoot, project, patch: Buffer.alloc(0) }),
			/non-empty patch bytes/u,
		);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("addWiffComment publishes a neutral finding without a verdict, using --side before only for deletions", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		writeFileSync(join(repositoryRoot, "a.txt"), "replacement\nline2\n");
		const session = await (async () => {
			await newSession(repositoryRoot, project, gitDiff(repositoryRoot));
			return (await readWiffState({ repositoryRoot, project })).session.id;
		})();

		await addWiffComment({
			repositoryRoot,
			project,
			session,
			author: "review/tests",
			file: "a.txt",
			line: 2,
			body: "Addition finding.",
		});
		await addWiffComment({
			repositoryRoot,
			project,
			session,
			author: "review/tests",
			file: "a.txt",
			line: 1,
			side: "before",
			body: "Deletion-side finding.",
		});

		const state = await readWiffState({ repositoryRoot, project });
		assert.equal(state.comments.length, 2);
		assert.equal(state.verdicts.length, 0);
		for (const comment of state.comments) assert.equal(comment.author.kind, "agent");
		const markdown = await renderWiffMarkdown({ repositoryRoot, project });
		assert.equal(markdown.includes("- #2 line 1 (before) by review/tests (agent)"), true);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("human verdicts are exposed accurately: zero, one, and two conflicting", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, project, gitDiff(repositoryRoot));
		const zero = await readWiffState({ repositoryRoot, project });
		assert.deepEqual(zero.verdicts, []);

		// Seed verdicts directly through the real CLI: the adapter's own comment
		// publication never sets one, so verdicts are set out of band here.
		execFileSync("wiff", [
			"comment", "add", "--review", "--author", "juruc", "--verdict", "approve",
			"--project", project, "--session", zero.session.id, "--body", "lgtm",
		], { cwd: repositoryRoot });
		const one = await readWiffState({ repositoryRoot, project });
		assert.deepEqual(one.verdicts, [
			{ author: { name: "juruc", kind: "human" }, disposition: "approve" },
		]);

		execFileSync("wiff", [
			"comment", "add", "--review", "--author", "otheruser", "--verdict", "request_changes",
			"--project", project, "--session", zero.session.id, "--body", "please fix",
		], { cwd: repositoryRoot });
		const two = await readWiffState({ repositoryRoot, project });
		assert.equal(two.verdicts.length, 2);
		assert.deepEqual(new Set(two.verdicts.map((verdict) => verdict.disposition)), new Set([
			"approve",
			"request_changes",
		]));
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("renderWiffMarkdown returns ordinary Wiff Markdown verbatim", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, project, gitDiff(repositoryRoot));
		const expected = execFileSync("wiff", ["render", "--project", project], {
			cwd: repositoryRoot,
			env: process.env,
		});
		const actual = await renderWiffMarkdown({ repositoryRoot, project });
		assert.equal(actual, expected.toString("utf8"));
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("removeWiffSession removes the session; a subsequent probe reports it absent", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, project, gitDiff(repositoryRoot));
		const { session } = await readWiffState({ repositoryRoot, project });
		await removeWiffSession({ repositoryRoot, project, session: session.id });
		assert.equal(await hasWiffSession({ repositoryRoot, project }), false);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("a non-zero Wiff exit surfaces stderr in the rejection", async () => {
	const repositoryRoot = createRepository();
	try {
		await assert.rejects(
			readWiffState({ repositoryRoot, project: "pi-review-does-not-exist" }),
			/wiff render --format json failed/u,
		);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("readWiffState rejects JSON for a different project", async () => {
	const repositoryRoot = createRepository();
	const fakePath = mkdtempSync(join(tmpdir(), "review-wiff-fake-path-"));
	const binary = join(fakePath, "wiff");
	const output = JSON.stringify({
		schema_version: 6,
		session: { id: "session1", project: "pi-review-wrong" },
		comments: [],
	});
	writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`);
	chmodSync(binary, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = fakePath;
	try {
		await assert.rejects(
			readWiffState({ repositoryRoot, project: "pi-review-expected" }),
			/Wiff returned project pi-review-wrong, expected pi-review-expected/u,
		);
	} finally {
		process.env.PATH = originalPath;
		rmSync(fakePath, { recursive: true, force: true });
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("a missing wiff binary produces one actionable error", async () => {
	const repositoryRoot = createRepository();
	const emptyPathDirectory = mkdtempSync(join(tmpdir(), "review-wiff-empty-path-"));
	const originalPath = process.env.PATH;
	process.env.PATH = emptyPathDirectory;
	try {
		await assert.rejects(
			hasWiffSession({ repositoryRoot, project: freshProject() }),
			/wiff is not installed or not on PATH/u,
		);
	} finally {
		process.env.PATH = originalPath;
		rmSync(emptyPathDirectory, { recursive: true, force: true });
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("AbortSignal cancels an in-flight Wiff command instead of relying on a timer", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		const controller = new AbortController();
		const pending = hasWiffSession({ repositoryRoot, project, signal: controller.signal });
		controller.abort(new Error("cancelled by test"));
		await assert.rejects(pending);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

function recordingTui(calls: string[]): { stop(): void; start(): void; requestRender(force?: boolean): void } {
	return {
		stop: () => calls.push("stop"),
		start: () => calls.push("start"),
		requestRender: (force?: boolean) => calls.push(`requestRender(${force})`),
	};
}

test("resumeWiff always stops then restores the TUI in stop/start/requestRender(true) order, and rejects a non-zero exit", async () => {
	// This test process has no TTY, so `wiff resume` cannot succeed here even with an
	// active session (inherited stdio needs a real terminal); both branches below exit
	// non-zero. What is under test is the TUI call ordering around every exit path and
	// that inherited-stdio failures still surface a clear, if stderr-less, error.
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, project, gitDiff(repositoryRoot));

		const withSessionCalls: string[] = [];
		await assert.rejects(
			resumeWiff({ repositoryRoot, project, tui: recordingTui(withSessionCalls) }),
			/wiff resume exited/u,
		);
		assert.deepEqual(withSessionCalls, ["stop", "start", "requestRender(true)"]);

		const withoutSessionCalls: string[] = [];
		await assert.rejects(
			resumeWiff({
				repositoryRoot,
				project: freshProject(),
				tui: recordingTui(withoutSessionCalls),
			}),
			/wiff resume exited/u,
		);
		assert.deepEqual(withoutSessionCalls, ["stop", "start", "requestRender(true)"]);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("resumeWiff still restores the TUI when the child is aborted mid-flight", async () => {
	const repositoryRoot = createRepository();
	const project = freshProject();
	try {
		changeWorktree(repositoryRoot);
		await newSession(repositoryRoot, project, gitDiff(repositoryRoot));
		const calls: string[] = [];
		const controller = new AbortController();
		const pending = resumeWiff({
			repositoryRoot,
			project,
			tui: recordingTui(calls),
			signal: controller.signal,
		});
		controller.abort(new Error("shutdown"));
		await assert.rejects(pending, /shutdown/u);
		assert.deepEqual(calls, ["stop", "start", "requestRender(true)"]);
	} finally {
		rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("the adapter uses no synchronous child-process calls, timers, or hashing", () => {
	const source = readFileSync(new URL("./review-wiff.ts", import.meta.url), "utf8");
	for (
		const forbidden of [
			"spawnSync",
			"execSync",
			"execFileSync",
			"setTimeout",
			"setInterval",
			"createHash",
			"new RegExp",
		]
	) assert.equal(source.includes(forbidden), false, `review-wiff.ts must not use ${forbidden}`);
});
