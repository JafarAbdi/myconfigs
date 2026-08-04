import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { demoAuditFinding, demoReviewPatch } from "./review-fixture.ts";
import { reviewPatchFromText, type ReviewPatch } from "./review-git.ts";
import { createReviewServer, type ReviewServer } from "./review-server.ts";

const comment = {
	filePath: "src/greeting.ts",
	side: "additions",
	startLine: 2,
	endLine: 3,
	body: "Please add a focused fallback test.",
};

async function json(url: string | URL, method: string, body?: unknown): Promise<Response> {
	return fetch(url, {
		method,
		...(body === undefined
			? {}
			: {
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
			}),
	});
}

function unchangedPatchReader(patch: ReviewPatch) {
	return async () => reviewPatchFromText(
		patch.text,
		patch.snapshot.repositoryRoot,
		patch.snapshot.headOid,
	);
}

async function statusWithHost(url: URL, host: string): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			hostname: url.hostname,
			port: url.port,
			path: `${url.pathname}${url.search}`,
			headers: { host },
		}, (response) => {
			response.resume();
			resolve(response.statusCode);
		});
		request.once("error", reject);
		request.end();
	});
}

test("loopback capability routes retain security, views, bounds, and comment CRUD", async () => {
	const patch = demoReviewPatch();
	const server = await createReviewServer({
		patch,
		auditFindings: [demoAuditFinding()],
		readPatch: unchangedPatchReader(patch),
	});
	try {
		const address = new URL(server.url);
		assert.equal(address.hostname, "127.0.0.1");
		assert.notEqual(address.port, "0");
		assert.match(address.pathname, /^\/[A-Za-z0-9_-]{32}\/$/u);
		assert.deepEqual(Object.fromEntries(address.searchParams), {
			mode: "stack",
			"line-numbers": "on",
			wrap: "off",
			"hunk-headers": "on",
			"audit-findings": "on",
		});

		assert.equal((await fetch(`${address.origin}/`)).status, 404);
		assert.equal(await statusWithHost(address, "localhost"), 404);
		assert.equal((await fetch(server.url, {
			headers: { origin: "https://example.invalid" },
		})).status, 403);

		const page = await fetch(server.url);
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
		assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/u);
		assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
		assert.match(page.headers.get("cache-control") ?? "", /no-store/u);
		const pageHtml = await page.text();
		assert.match(pageHtml, /<title>Review<\/title>/u);
		assert.match(pageHtml, /data-mode="stack" data-resolved-mode="stack"/u);
		assert.ok(pageHtml.includes(`data-api-base="${address.pathname}api/"`));
		assert.doesNotMatch(pageHtml, /Agent note|Cumulative diff/u);

		const configuredUrl = new URL(server.url);
		configuredUrl.searchParams.set("mode", "split");
		configuredUrl.searchParams.set("line-numbers", "off");
		configuredUrl.searchParams.set("wrap", "on");
		configuredUrl.searchParams.set("hunk-headers", "off");
		configuredUrl.searchParams.set("audit-findings", "off");
		const configuredHtml = await (await fetch(configuredUrl)).text();
		assert.match(configuredHtml, /data-mode="split" data-resolved-mode="split"/u);
		assert.match(configuredHtml, /data-diff-type="split"/u);
		assert.match(configuredHtml, /data-disable-line-numbers=""/u);
		assert.match(configuredHtml, /data-overflow="wrap"/u);
		assert.doesNotMatch(configuredHtml, />Audit finding</u);

		const autoUrl = new URL(server.url);
		autoUrl.searchParams.set("mode", "auto");
		assert.match(await (await fetch(autoUrl)).text(), /data-resolved-mode="split"/u);
		autoUrl.searchParams.set("auto-layout", "stack");
		assert.match(await (await fetch(autoUrl)).text(), /data-resolved-mode="stack"/u);
		for (const invalidSearch of [
			"?unknown=on",
			"?mode=auto&mode=split",
			"?wrap=yes",
			"?mode=split&auto-layout=stack",
		]) {
			const invalid = new URL(server.url);
			invalid.search = invalidSearch;
			assert.equal((await fetch(invalid)).status, 400);
		}

		const script = await fetch(new URL("review.js", server.url));
		assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.match(await script.text(), /targetFromComposedPath/u);
		const stylesheet = await fetch(new URL("review.css", server.url));
		assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
		assert.match(await stylesheet.text(), /\.decision-bar/u);

		const api = new URL("api/", server.url);
		const stateResponse = await fetch(new URL("state", api));
		const stateText = await stateResponse.text();
		const initial = JSON.parse(stateText);
		assert.deepEqual(initial.state.snapshot, { headOid: patch.snapshot.headOid });
		assert.equal(initial.state.auditFindings.length, 1);
		assert.equal(initial.state.humanComments.length, 0);
		assert.deepEqual(initial.files[0].changed.additions, [2, 3]);
		assert.doesNotMatch(stateText, /repositoryRoot|"raw"|diff --git|\/repository/u);

		const unsupported = await fetch(new URL("comments", api), {
			method: "POST",
			body: "{}",
		});
		assert.equal(unsupported.status, 415);
		const malformed = await fetch(new URL("comments", api), {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		});
		assert.equal(malformed.status, 400);
		const oversized = await json(new URL("comments", api), "POST", {
			...comment,
			body: "x".repeat(70_000),
		});
		assert.equal(oversized.status, 413);

		const createdResponse = await json(new URL("comments", api), "POST", comment);
		assert.equal(createdResponse.status, 201);
		const created = (await createdResponse.json()).state.humanComments[0];
		const revised = await json(new URL(`comments/${created.id}`, api), "PATCH", {
			body: "Please add fallback and whitespace tests.",
		});
		assert.equal(revised.status, 200);
		assert.equal((await revised.json()).state.humanComments[0].body, "Please add fallback and whitespace tests.");
		assert.equal((await json(new URL(`comments/${created.id}`, api), "PATCH", {
			body: "No.",
			startLine: 3,
		})).status, 400);
		assert.equal((await json(new URL("decision", api), "POST", { kind: "approve" })).status, 409);
		const deleted = await json(new URL(`comments/${created.id}`, api), "DELETE");
		assert.equal(deleted.status, 200);
		assert.equal((await deleted.json()).state.humanComments.length, 0);
	} finally {
		await server.close();
		await server.close();
	}
});

test("audit-only Send Feedback returns a deterministic receipt after the response", async () => {
	const patch = demoReviewPatch();
	let rereadStarted!: () => void;
	let releaseReread!: () => void;
	const started = new Promise<void>((resolve) => { rereadStarted = resolve; });
	const release = new Promise<void>((resolve) => { releaseReread = resolve; });
	const server = await createReviewServer({
		patch,
		auditFindings: [demoAuditFinding()],
		readPatch: async () => {
			rereadStarted();
			await release;
			return patch;
		},
	});
	try {
		let resolved = false;
		void server.decision.then(() => { resolved = true; });
		const responsePromise = json(new URL("api/decision", server.url), "POST", {
			kind: "send-feedback",
		});
		await started;
		assert.equal(resolved, false);
		releaseReread();
		const response = await responsePromise;
		assert.equal(response.status, 200);
		const receipt = await response.json();
		assert.equal(receipt.state.decision.kind, "send-feedback");
		const decision = await server.decision;
		assert.deepEqual(decision, {
			kind: "send-feedback",
			decidedAt: receipt.state.decision.decidedAt,
			feedbackMarkdown: `# Review feedback

## Audit findings
- src/greeting.ts:new L2 — Whitespace-only names now take a new fallback path.
  - Evidence: The staged line replaces the supplied name after trimming it.
  - Failure: Callers may receive a greeting for a different audience than intended.
  - Repair: Confirm the fallback requirement or remove the fallback.

## Human comments
`,
		});
		assert.equal(resolved, true);
		assert.equal((await fetch(new URL("api/state", server.url))).status, 200);
		assert.match(await (await fetch(server.url)).text(), /Feedback sent\. Decision recorded/u);
		assert.equal((await json(new URL("api/decision", server.url), "POST", {
			kind: "send-feedback",
		})).status, 409);
	} finally {
		await server.close();
	}
});

test("raw client disconnect after an accepted decision still settles the server", async () => {
	const patch = demoReviewPatch();
	let rereadStarted!: () => void;
	let releaseReread!: () => void;
	const started = new Promise<void>((resolve) => { rereadStarted = resolve; });
	const release = new Promise<void>((resolve) => { releaseReread = resolve; });
	const server = await createReviewServer({
		patch,
		auditFindings: [],
		readPatch: async () => {
			rereadStarted();
			await release;
			return patch;
		},
	});
	try {
		const address = new URL(server.url);
		const socket = connect(Number(address.port), address.hostname);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const body = JSON.stringify({ kind: "approve" });
		socket.write([
			`POST ${address.pathname}api/decision HTTP/1.1`,
			`Host: ${address.host}`,
			"Content-Type: application/json",
			`Content-Length: ${Buffer.byteLength(body)}`,
			"Connection: close",
			"",
			body,
		].join("\r\n"));
		await started;
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		socket.destroy();
		await closed;
		releaseReread();
		const decision = await Promise.race([
			server.decision,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("decision remained pending")), 1_000)),
		]);
		assert.equal(decision.kind, "approve");
	} finally {
		releaseReread?.();
		await server.close();
	}
});

test("exact HEAD and staged-byte drift each return 409 without recording a decision", async (t) => {
	const original = demoReviewPatch();
	const cases = [
		{
			name: "HEAD drift",
			current: reviewPatchFromText(original.text, original.snapshot.repositoryRoot, "3".repeat(40)),
			error: /Review is stale: HEAD changed/u,
		},
		{
			name: "staged-byte drift",
			current: reviewPatchFromText(
				original.text.replace("friendly greeting", "warm greeting"),
				original.snapshot.repositoryRoot,
				original.snapshot.headOid,
			),
			error: /Review is stale: staged patch bytes changed/u,
		},
	];
	for (const drift of cases) await t.test(drift.name, async () => {
		const server = await createReviewServer({
			patch: original,
			auditFindings: [],
			readPatch: async () => drift.current,
		});
		try {
			const response = await json(new URL("api/decision", server.url), "POST", {
				kind: "approve",
			});
			assert.equal(response.status, 409);
			assert.match((await response.json()).error, drift.error);
			const decision = await server.decision;
			assert.equal(decision.kind, "stale");
			assert.match(decision.error, drift.error);
			const state = await (await fetch(new URL("api/state", server.url))).json();
			assert.equal(state.state.decision, null);
		} finally {
			await server.close();
		}
	});
});

test("reread failure is a visible stale result and does not complete the store", async () => {
	const patch = demoReviewPatch();
	const server = await createReviewServer({
		patch,
		auditFindings: [],
		readPatch: async () => { throw new Error("sensitive repository failure"); },
	});
	try {
		const response = await json(new URL("api/decision", server.url), "POST", {
			kind: "approve",
		});
		assert.equal(response.status, 409);
		const payload = await response.json();
		assert.match(payload.error, /could not be reread/u);
		assert.doesNotMatch(payload.error, /sensitive/u);
		assert.deepEqual(await server.decision, { kind: "stale", error: payload.error });
		const state = await (await fetch(new URL("api/state", server.url))).json();
		assert.equal(state.state.decision, null);
	} finally {
		await server.close();
	}
});

function git(repository: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();
}

test("default freshness checks and approval do not mutate Git or create durable review state", async () => {
	const repository = mkdtempSync(join(tmpdir(), "review-server-git-"));
	let server: ReviewServer | undefined;
	try {
		git(repository, "init", "-b", "main");
		git(repository, "config", "user.name", "Review test");
		git(repository, "config", "user.email", "review@example.invalid");
		writeFileSync(join(repository, "file.txt"), "before\n");
		git(repository, "add", "file.txt");
		git(repository, "commit", "-m", "base");
		writeFileSync(join(repository, "file.txt"), "after\n");
		git(repository, "add", "file.txt");
		const { readGitReviewPatch } = await import("./review-git.ts");
		const patch = await readGitReviewPatch(repository);
		const before = {
			head: git(repository, "rev-parse", "HEAD"),
			status: git(repository, "status", "--porcelain=v2"),
			entries: readdirSync(repository).sort(),
		};

		server = await createReviewServer({ patch, auditFindings: [] });
		const response = await json(new URL("api/decision", server.url), "POST", {
			kind: "approve",
		});
		assert.equal(response.status, 200);
		assert.equal((await server.decision).kind, "approve");
		assert.deepEqual({
			head: git(repository, "rev-parse", "HEAD"),
			status: git(repository, "status", "--porcelain=v2"),
			entries: readdirSync(repository).sort(),
		}, before);
		assert.equal((await fetch(new URL("api/state", server.url))).status, 200);
	} finally {
		await server?.close();
		rmSync(repository, { recursive: true, force: true });
	}
});

test("close is idempotent, closes idle connections, and may leave decision pending", async () => {
	const patch = demoReviewPatch();
	const first = await createReviewServer({
		patch,
		auditFindings: [],
		readPatch: unchangedPatchReader(patch),
	});
	const second = await createReviewServer({
		patch,
		auditFindings: [],
		readPatch: unchangedPatchReader(patch),
	});
	assert.notEqual(first.url, second.url);
	assert.equal((await fetch(first.url)).status, 200);
	assert.equal((await fetch(second.url)).status, 200);
	await first.close();
	await first.close();
	await assert.rejects(fetch(first.url));
	assert.equal(await Promise.race([
		first.decision.then(() => "resolved"),
		new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
	]), "pending");
	await second.close();
});

test("server source has time bounds and no task, lock, callback, or global server machinery", () => {
	const source = readFileSync(new URL("./review-server.ts", import.meta.url), "utf8");
	assert.match(source, /server\.requestTimeout = 10_000/u);
	assert.match(source, /server\.headersTimeout = 10_000/u);
	assert.doesNotMatch(source, /taskPath|review-lock|activeReviewServer|setOnDecision|ReviewDecisionCallback/u);
});
