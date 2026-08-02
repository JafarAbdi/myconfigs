import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEMO_AGENT_ANNOTATIONS,
	demoReviewPatch,
} from "./review-fixture.ts";
import {
	createReviewServer,
	type ReviewServer,
} from "./review-server.ts";

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
	const statePath = join(directory, "review.json");
	const patch = demoReviewPatch();
	let first: ReviewServer | undefined;
	let second: ReviewServer | undefined;
	let third: ReviewServer | undefined;
	try {
		first = await createReviewServer({
			patch,
			statePath,
			agentAnnotations: DEMO_AGENT_ANNOTATIONS,
		});
		const address = new URL(first.url);
		assert.equal(address.hostname, "127.0.0.1");
		assert.notEqual(address.port, "0");
		assert.deepEqual(Object.fromEntries(address.searchParams), {
			mode: "auto",
			"line-numbers": "on",
			wrap: "off",
			"hunk-headers": "on",
			"agent-notes": "on",
		});
		await assert.rejects(
			createReviewServer({ patch, statePath }),
			/another review server already owns/u,
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
		assert.match(pageHtml, /data-mode="auto" data-resolved-mode="split"/u);
		assert.ok(pageHtml.includes(`data-api-base="${address.pathname}api/"`));

		const configuredUrl = new URL(first.url);
		configuredUrl.searchParams.set("mode", "stack");
		configuredUrl.searchParams.set("line-numbers", "off");
		configuredUrl.searchParams.set("wrap", "on");
		configuredUrl.searchParams.set("hunk-headers", "off");
		configuredUrl.searchParams.set("agent-notes", "off");
		const configured = await fetch(configuredUrl);
		assert.equal(configured.status, 200);
		const configuredHtml = await configured.text();
		assert.match(configuredHtml, /data-resolved-mode="stack"/u);
		assert.match(configuredHtml, /data-disable-line-numbers=""/u);
		assert.match(configuredHtml, /data-overflow="wrap"/u);
		assert.doesNotMatch(configuredHtml, />Agent note</u);
		assert.ok(configuredHtml.includes(
			`href="${address.pathname}?mode=split&amp;line-numbers=off&amp;wrap=on&amp;hunk-headers=off&amp;agent-notes=off"`,
		));
		const autoStackUrl = new URL(first.url);
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
		const retarget = await json(
			new URL(`comments/${created.id}`, api).href,
			"PATCH",
			{ body: revisedBody, startLine: 3 },
		);
		assert.equal(retarget.status, 400);
		assert.equal(statSync(statePath).mode & 0o777, 0o600);
		const forbidden = await fetch(new URL("state", api), {
			headers: { origin: "https://example.invalid" },
		});
		assert.equal(forbidden.status, 403);

		await first.close();
		first = undefined;
		await assert.rejects(fetch(address.href));

		second = await createReviewServer({ patch, statePath });
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

		third = await createReviewServer({ patch, statePath });
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
