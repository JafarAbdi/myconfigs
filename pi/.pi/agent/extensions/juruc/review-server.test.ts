import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	demoReviewPatch,
	demoReviewTask,
} from "./review-fixture.ts";
import {
	activeReviewServer,
	createReviewServer,
	type ReviewServer,
} from "./review-server.ts";
import { loadTaskDocument, saveTaskDocument, type ReviewDecision } from "./task.ts";

const comment = {
	filePath: "src/greeting.ts",
	side: "additions",
	startLine: 2,
	endLine: 3,
	body: "Please add a focused fallback test.",
};

async function json(
	url: string,
	method: string,
	body?: unknown,
): Promise<Response> {
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

test("loopback capability server persists comment CRUD and only records explicit decisions", { timeout: 120_000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-server-"));
	const taskPath = join(directory, "task.json");
	const patch = demoReviewPatch();
	saveTaskDocument(taskPath, demoReviewTask());
	let first: ReviewServer | undefined;
	let second: ReviewServer | undefined;
	let third: ReviewServer | undefined;
	try {
		first = await createReviewServer({ patch, taskPath });
		assert.equal(first.taskPath, taskPath);
		const address = new URL(first.url);
		assert.equal(address.hostname, "127.0.0.1");
		assert.notEqual(address.port, "0");
		assert.deepEqual(Object.fromEntries(address.searchParams), {
			mode: "stack",
			"line-numbers": "on",
			wrap: "off",
			"hunk-headers": "on",
			"agent-notes": "on",
		});
		await assert.rejects(
			createReviewServer({ patch, taskPath }),
			/another review operation already owns/u,
		);

		const hidden = await fetch(`${address.origin}/`);
		assert.equal(hidden.status, 404);
		const page = await fetch(first.url);
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
		assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/u);
		assert.match(page.headers.get("content-security-policy") ?? "", /font-src 'none'/u);
		const pageHtml = await page.text();
		assert.match(pageHtml, /JURUC local review/u);
		assert.match(
			pageHtml,
			/data-mode="stack" data-resolved-mode="stack" data-layout="unified"/u,
		);
		assert.match(pageHtml, /data-diff-type="single"/u);
		assert.ok(pageHtml.includes(`data-api-base="${address.pathname}api/"`));

		const configuredUrl = new URL(first.url);
		configuredUrl.searchParams.set("mode", "split");
		configuredUrl.searchParams.set("line-numbers", "off");
		configuredUrl.searchParams.set("wrap", "on");
		configuredUrl.searchParams.set("hunk-headers", "off");
		configuredUrl.searchParams.set("agent-notes", "off");
		const configured = await fetch(configuredUrl);
		assert.equal(configured.status, 200);
		const configuredHtml = await configured.text();
		assert.match(configuredHtml, /data-mode="split" data-resolved-mode="split"/u);
		assert.match(configuredHtml, /data-diff-type="split"/u);
		assert.match(configuredHtml, /data-disable-line-numbers=""/u);
		assert.match(configuredHtml, /data-overflow="wrap"/u);
		assert.doesNotMatch(configuredHtml, />Agent note</u);
		assert.ok(configuredHtml.includes(
			`href="${address.pathname}?mode=stack&amp;line-numbers=off&amp;wrap=on&amp;hunk-headers=off&amp;agent-notes=off"`,
		));
		const autoUrl = new URL(first.url);
		autoUrl.searchParams.set("mode", "auto");
		const autoHtml = await (await fetch(autoUrl)).text();
		assert.match(autoHtml, /data-mode="auto" data-resolved-mode="split"/u);
		const autoStackUrl = new URL(autoUrl);
		autoStackUrl.searchParams.set("auto-layout", "stack");
		assert.match(await (await fetch(autoStackUrl)).text(), /data-resolved-mode="stack"/u);

		for (const invalidSearch of [
			"?unknown=on",
			"?mode=auto&mode=split",
			"?wrap=yes",
			"?mode=split&auto-layout=stack",
		]) {
			const invalid = new URL(first.url);
			invalid.search = invalidSearch;
			assert.equal((await fetch(invalid)).status, 400);
		}

		const script = await fetch(new URL("review.js", first.url));
		assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.match(await script.text(), /targetFromComposedPath/u);
		const stylesheet = await fetch(new URL("review.css", first.url));
		assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
		assert.match(await stylesheet.text(), /\.decision-bar/u);

		const api = new URL("api/", first.url);
		const initial = await (await fetch(new URL("state", api))).json();
		assert.equal(initial.state.decision, null);
		assert.equal(initial.state.humanComments.length, 0);
		assert.deepEqual(initial.files[0].changed.additions, [2, 3]);

		const guarded = await json(new URL("decision", api).href, "POST", {
			kind: "send-feedback",
		});
		assert.equal(guarded.status, 409);
		assert.match((await guarded.json()).error, /at least one saved human comment/u);

		const oversized = await json(new URL("comments", api).href, "POST", {
			...comment,
			body: "x".repeat(70_000),
		});
		assert.equal(oversized.status, 413);

		const createdResponse = await json(
			new URL("comments", api).href,
			"POST",
			comment,
		);
		assert.equal(createdResponse.status, 201);
		const created = (await createdResponse.json()).state.humanComments[0];
		const revisedBody = "Please add focused fallback and whitespace tests.";
		const revisedResponse = await json(
			new URL(`comments/${created.id}`, api).href,
			"PATCH",
			{ body: revisedBody },
		);
		assert.equal(revisedResponse.status, 200);
		const revised = (await revisedResponse.json()).state.humanComments[0];
		assert.deepEqual(revised, { ...created, body: revisedBody });
		const approvalWithComments = await json(new URL("decision", api).href, "POST", {
			kind: "approve",
		});
		assert.equal(approvalWithComments.status, 409);
		assert.match((await approvalWithComments.json()).error, /zero saved human comments/u);
		const retarget = await json(
			new URL(`comments/${created.id}`, api).href,
			"PATCH",
			{ body: revisedBody, startLine: 3 },
		);
		assert.equal(retarget.status, 400);
		assert.equal(statSync(taskPath).mode & 0o777, 0o600);
		const forbidden = await fetch(new URL("state", api), {
			headers: { origin: "https://example.invalid" },
		});
		assert.equal(forbidden.status, 403);

		await first.close();
		first = undefined;
		await assert.rejects(fetch(address.href));

		second = await createReviewServer({ patch, taskPath });
		assert.notEqual(second.url, address.href);
		const restartedApi = new URL("api/", second.url);
		const restarted = await (await fetch(new URL("state", restartedApi))).json();
		assert.equal(restarted.state.decision, null);
		assert.equal(restarted.state.humanComments[0].body, revisedBody);

		const deleted = await json(
			new URL(`comments/${created.id}`, restartedApi).href,
			"DELETE",
		);
		assert.equal(deleted.status, 200);
		assert.equal((await deleted.json()).state.humanComments.length, 0);
		await json(new URL("comments", restartedApi).href, "POST", comment);
		const decided = await json(new URL("decision", restartedApi).href, "POST", {
			kind: "send-feedback",
		});
		assert.equal(decided.status, 200);
		assert.equal((await decided.json()).state.decision.kind, "send-feedback");
		await second.close();
		second = undefined;

		third = await createReviewServer({ patch, taskPath });
		const completed = await (
			await fetch(new URL("api/state", third.url))
		).json();
		assert.equal(completed.state.decision.kind, "send-feedback");
	} finally {
		await first?.close();
		await second?.close();
		await third?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the decision callback runs once, after its response, and leaves the round read-only", { timeout: 120_000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-decision-"));
	const taskPath = join(directory, "task.json");
	const patch = demoReviewPatch();
	saveTaskDocument(taskPath, demoReviewTask());
	const decisions: ReviewDecision[] = [];
	let first: ReviewServer | undefined;
	let second: ReviewServer | undefined;
	try {
		// The callback closes its own server, exactly as the process-owned controller does.
		// That can only work if it runs outside the request turn that still owns the response.
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => { settle = resolve; });
		const closingServer = await createReviewServer({
			patch,
			taskPath,
			onDecision: (decision) => {
				decisions.push(decision);
				void first?.close().then(settle, settle);
			},
		});
		first = closingServer;
		const api = new URL("api/", closingServer.url);
		await json(new URL("comments", api).href, "POST", comment);

		const decided = await json(new URL("decision", api).href, "POST", {
			kind: "send-feedback",
		});
		assert.equal(decided.status, 200);
		assert.equal((await decided.json()).state.decision.kind, "send-feedback");
		await settled;
		assert.deepEqual(decisions.map(({ kind }) => kind), ["send-feedback"]);
		assert.equal(loadTaskDocument(taskPath).reviewRounds[0].decision?.kind, "send-feedback");
		await assert.rejects(fetch(new URL("state", api)));
		first = undefined;

		saveTaskDocument(taskPath, demoReviewTask());
		const approvals: ReviewDecision[] = [];
		let approve!: () => void;
		const approved = new Promise<void>((resolve) => { approve = resolve; });
		second = await createReviewServer({
			patch,
			taskPath,
			onDecision: (decision) => {
				approvals.push(decision);
				approve();
			},
		});
		const approvalApi = new URL("api/", second.url);
		assert.equal(
			(await json(new URL("decision", approvalApi).href, "POST", { kind: "approve" })).status,
			200,
		);
		await approved;
		assert.deepEqual(approvals.map(({ kind }) => kind), ["approve"]);
		assert.equal(loadTaskDocument(taskPath).stage, "done");

		// A decided round stays readable and read-only until the controller closes the server.
		assert.equal((await fetch(new URL("state", approvalApi))).status, 200);
		assert.equal(
			(await json(new URL("decision", approvalApi).href, "POST", { kind: "approve" })).status,
			409,
		);
		assert.equal(
			(await json(new URL("comments", approvalApi).href, "POST", comment)).status,
			409,
		);
		assert.equal(approvals.length, 1);
	} finally {
		await first?.close();
		await second?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the process-owned server keeps one capability URL per pinned round", { timeout: 120_000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-active-review-"));
	const taskPath = join(directory, "task.json");
	const otherTaskPath = join(directory, "other-task.json");
	saveTaskDocument(taskPath, demoReviewTask());
	saveTaskDocument(otherTaskPath, demoReviewTask());
	const patch = demoReviewPatch();
	const identity = {
		taskPath,
		baseCommit: patch.identity.baseOid,
		headCommit: patch.identity.headOid,
	};
	try {
		assert.equal(activeReviewServer.liveUrl(identity), undefined);
		const first = await activeReviewServer.serve({ patch, taskPath });
		assert.equal(activeReviewServer.liveUrl(identity), first.url);
		assert.equal((await fetch(first.url)).status, 200);

		// A live URL never crosses a task or a pinned round.
		assert.equal(activeReviewServer.liveUrl({ ...identity, taskPath: otherTaskPath }), undefined);
		assert.equal(
			activeReviewServer.liveUrl({ ...identity, baseCommit: "3".repeat(40) }),
			undefined,
		);
		assert.equal(
			activeReviewServer.liveUrl({ ...identity, headCommit: "3".repeat(40) }),
			undefined,
		);

		// Process closure invalidates the capability; the next review issues a fresh one.
		await activeReviewServer.close();
		assert.equal(activeReviewServer.liveUrl(identity), undefined);
		await assert.rejects(fetch(first.url));
		const second = await activeReviewServer.serve({ patch, taskPath });
		assert.notEqual(new URL(second.url).pathname, new URL(first.url).pathname);
		assert.equal(activeReviewServer.liveUrl(identity), second.url);
		assert.equal((await fetch(second.url)).status, 200);
	} finally {
		await activeReviewServer.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("reusing a live URL routes its decision to the newest session only", { timeout: 120_000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "juruc-review-rebind-"));
	const taskPath = join(directory, "task.json");
	const patch = demoReviewPatch();
	saveTaskDocument(taskPath, demoReviewTask());
	const identity = {
		taskPath,
		baseCommit: patch.identity.baseOid,
		headCommit: patch.identity.headOid,
	};
	const served: ReviewDecision[] = [];
	const resumed: ReviewDecision[] = [];
	const other: ReviewDecision[] = [];
	try {
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => { settle = resolve; });
		const { url } = await activeReviewServer.serve({
			patch,
			taskPath,
			onDecision: (decision) => served.push(decision),
		});

		// A later session reuses the same capability URL and takes over its decision.
		assert.equal(
			activeReviewServer.reuse(identity, (decision) => {
				resumed.push(decision);
				settle();
			}),
			url,
		);
		// A different pinned round has no live URL and never rebinds the live one.
		assert.equal(
			activeReviewServer.reuse(
				{ ...identity, headCommit: "3".repeat(40) },
				(decision) => other.push(decision),
			),
			undefined,
		);

		const api = new URL("api/", url);
		assert.equal(
			(await json(new URL("decision", api).href, "POST", { kind: "approve" })).status,
			200,
		);
		await settled;
		assert.deepEqual(resumed.map(({ kind }) => kind), ["approve"]);
		assert.deepEqual(served, []);
		assert.deepEqual(other, []);
		assert.equal(loadTaskDocument(taskPath).stage, "done");
	} finally {
		await activeReviewServer.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
