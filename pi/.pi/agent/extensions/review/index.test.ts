import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createReviewController,
	readReviewRequirement,
	registerReview,
	type ReviewDependencies,
} from "./index.ts";
import type { ReviewPatch } from "./review-git.ts";
import type {
	ReviewServer,
	ReviewServerDecision,
} from "./review-server.ts";

const ROOT = "/repository";
const PARENT_SESSION_DIR = "/sessions/project";
const PARENT_SESSION_ID = "parent-session-id";
const PARENT_SESSION_FILE = `${PARENT_SESSION_DIR}/parent.jsonl`;
const CUSTOM_CANCEL_SEQUENCE = "\x1b[99~";

function patch(raw = "staged patch", empty = false, root = ROOT): ReviewPatch {
	return {
		snapshot: {
			repositoryRoot: root,
			headOid: "2".repeat(40),
			raw: Buffer.from(raw),
		},
		text: raw,
		empty,
		files: [],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolve_, reject_) => {
		resolve = resolve_;
		reject = reject_;
	});
	return { promise, resolve, reject };
}

function context(overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const editor: string[] = [];
	const components: Array<{ render(width: number): string[]; handleInput?(data: string): void }> = [];
	const keybindingMatches: Array<{ data: string; binding: string }> = [];
	let doneCalls = 0;
	let idleCalls = 0;
	const ctx = {
		mode: "tui",
		cwd: "/working",
		sessionManager: {
			getSessionDir: () => PARENT_SESSION_DIR,
			getSessionId: () => PARENT_SESSION_ID,
			getSessionFile: () => PARENT_SESSION_FILE,
		},
		async waitForIdle() { idleCalls += 1; },
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			setEditorText(value: string) { editor.push(value); },
			custom<T>(factory: (...args: any[]) => any): Promise<T> {
				return new Promise<T>((resolve, reject) => {
					const done = (value: T) => {
						doneCalls += 1;
						resolve(value);
					};
					const keybindings = {
						matches(data: string, binding: string) {
							keybindingMatches.push({ data, binding });
							return binding === "tui.select.cancel" && data === CUSTOM_CANCEL_SEQUENCE;
						},
					};
					Promise.resolve(factory({}, {}, keybindings, done)).then(
						(component) => components.push(component),
						reject,
					);
				});
			},
		},
		...overrides,
	};
	return {
		ctx: ctx as never,
		notifications,
		editor,
		components,
		keybindingMatches,
		get doneCalls() { return doneCalls; },
		get idleCalls() { return idleCalls; },
	};
}

function serverHarness(url = "http://127.0.0.1:1234/capability/?mode=stack") {
	const terminal = deferred<ReviewServerDecision>();
	let closeCalls = 0;
	const server: ReviewServer = {
		url,
		decision: terminal.promise,
		async close() { closeCalls += 1; },
	};
	return { server, terminal, get closeCalls() { return closeCalls; } };
}

function dependencies(overrides: Partial<ReviewDependencies> = {}): ReviewDependencies {
	const original = patch();
	return {
		async readPatch() { return original; },
		async readRequirement() { return undefined; },
		async runAudit() { return { findings: [] }; },
		reviewSnapshotsEqual(left, right) {
			return left.repositoryRoot === right.repositoryRoot &&
				left.headOid === right.headOid && left.raw.equals(right.raw);
		},
		async createServer() { return serverHarness().server; },
		...overrides,
	};
}

async function waitForComponent(components: unknown[]): Promise<void> {
	for (let attempt = 0; attempt < 50 && components.length === 0; attempt += 1)
		await new Promise((resolve) => setImmediate(resolve));
	assert.equal(components.length, 1);
}

test("registers only /review and reports command failures through the TUI", async () => {
	const commands: Array<{ name: string; options: { handler: (arg: string, ctx: never) => Promise<void> } }> = [];
	const events: Array<{ name: string; handler: (...args: any[]) => Promise<void> }> = [];
	registerReview({
		registerCommand(name: string, options: any) { commands.push({ name, options }); },
		on(name: string, handler: () => Promise<void>) { events.push({ name, handler }); },
	} as never, dependencies({
		async readPatch() { throw new Error("capture failed"); },
	}));
	assert.deepEqual(commands.map(({ name }) => name), ["review"]);
	assert.deepEqual(events.map(({ name }) => name), ["session_shutdown"]);
	const harness = context();
	await commands[0].options.handler("", harness.ctx);
	assert.deepEqual(harness.notifications, [{ message: "capture failed", type: "error" }]);
	let aborts = 0;
	await events[0].handler({}, { abort() { aborts += 1; } });
	assert.equal(aborts, 1);
});

test("rejects non-TUI and empty staged input before audit", async (t) => {
	for (const item of [
		{ name: "non-TUI", context: { mode: "rpc" }, error: /requires TUI/u, reads: 0 },
		{ name: "empty", context: {}, error: /non-empty staged patch/u, reads: 1 },
	]) await t.test(item.name, async () => {
		let reads = 0;
		let audits = 0;
		const controller = createReviewController(dependencies({
			async readPatch() {
				reads += 1;
				return item.name === "empty" ? patch("", true) : patch();
			},
			async runAudit() { audits += 1; return { findings: [] }; },
		}));
		await assert.rejects(controller.run("", context(item.context).ctx), item.error);
		assert.equal(reads, item.reads);
		assert.equal(audits, 0);
	});
});

test("treats the trimmed argument as one bounded repository-relative Markdown file", async () => {
	const root = mkdtempSync(join(tmpdir(), "review-requirement-"));
	const outside = mkdtempSync(join(tmpdir(), "review-requirement-outside-"));
	try {
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "plan with spaces.md"), "# Plan\n✓\n");
		writeFileSync(join(root, "plain.txt"), "plain\n");
		mkdirSync(join(root, "directory.md"));
		writeFileSync(join(root, "invalid.md"), Buffer.from([0xff]));
		writeFileSync(join(root, "large.md"), Buffer.alloc(1024 * 1024 + 1));
		symlinkSync(join(root, "docs", "plan with spaces.md"), join(root, "linked.md"));
		writeFileSync(join(outside, "outside.md"), "outside\n");
		symlinkSync(outside, join(root, "linked-directory"));

		assert.deepEqual(
			await readReviewRequirement(root, "  docs/plan with spaces.md  "),
			{ path: "docs/plan with spaces.md", content: "# Plan\n✓\n" },
		);
		assert.equal(await readReviewRequirement(root, "   "), undefined);
		for (const invalid of [
			"../escape.md",
			join(root, "docs", "plan with spaces.md"),
			"bad\0name.md",
			"plain.txt",
			"missing.md",
			"directory.md",
			"linked.md",
			"linked-directory/outside.md",
			"invalid.md",
			"large.md",
		]) await assert.rejects(readReviewRequirement(root, invalid));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("runs one aggregate audit with the captured candidate, parent, and requirement", async () => {
	const original = patch();
	const reviewServer = serverHarness();
	let reads = 0;
	let audits = 0;
	let requirementArgument = "";
	const requirement = { path: "docs/plan with spaces.md", content: "# Plan" };
	const harness = context({
		sessionManager: {
			getSessionDir: () => PARENT_SESSION_DIR,
			getSessionId: () => PARENT_SESSION_ID,
			getSessionFile: () => undefined,
		},
	});
	const controller = createReviewController(dependencies({
		async readPatch(repository) {
			reads += 1;
			assert.equal(repository, reads === 1 ? "/working" : ROOT);
			return original;
		},
		async readRequirement(root, argument) {
			assert.equal(root, ROOT);
			requirementArgument = argument;
			return requirement;
		},
		async runAudit(input) {
			audits += 1;
			assert.equal(input.repositoryRoot, ROOT);
			assert.equal(input.patch, original);
			assert.deepEqual(input.parentSession, {
				directory: PARENT_SESSION_DIR,
				id: PARENT_SESSION_ID,
			});
			assert.equal(input.requirement, requirement);
			assert.equal(input.signal?.aborted, false);
			return { findings: [] };
		},
		async createServer(options) {
			assert.equal(options.patch, original);
			assert.deepEqual(options.auditFindings, []);
			return reviewServer.server;
		},
	}));
	const running = controller.run("  docs/plan with spaces.md  ", harness.ctx);
	await waitForComponent(harness.components);
	assert.equal(audits, 1);
	assert.equal(reads, 2);
	assert.equal(requirementArgument, "docs/plan with spaces.md");
	assert.deepEqual(harness.notifications, [{ message: "Auditing staged changes…", type: "info" }]);

	const line = harness.components[0].render(100)[0];
	assert.equal(line.replaceAll(/\x1b\]8;;[^\x07]*\x07|\x1b\]8;;\x07/gu, ""), "Review ready  Open review ↗");
	assert.equal(line.includes(`${reviewServer.server.url}\x07Open review ↗`), true);
	assert.equal(line.includes(`${reviewServer.server.url}\x07Review ready`), false);
	assert.equal(harness.notifications.some(({ message }) => message.includes(reviewServer.server.url)), false);

	reviewServer.terminal.resolve({ kind: "approve", decidedAt: "2026-01-01T00:00:00.000Z" });
	await running;
	assert.equal(reviewServer.closeCalls, 1);
	assert.equal(harness.doneCalls, 1);
	assert.deepEqual(harness.editor, []);
	assert.equal(harness.notifications.at(-1)?.message, "Review approved.");
});

test("a reviewer failure prevents the browser server", async () => {
	let servers = 0;
	const controller = createReviewController(dependencies({
		async runAudit() { throw new Error("context reviewer failed"); },
		async createServer() { servers += 1; return serverHarness().server; },
	}));
	await assert.rejects(controller.run("", context().ctx), /context reviewer failed/u);
	assert.equal(servers, 0);
});

test("session shutdown aborts and awaits an audit still in flight", async () => {
	let servers = 0;
	const started = deferred<void>();
	const aborted = deferred<void>();
	const release = deferred<void>();
	const controller = createReviewController(dependencies({
		runAudit(input) {
			started.resolve();
			return new Promise((_resolve, reject) => input.signal?.addEventListener("abort", () => {
				aborted.resolve();
				void release.promise.then(() => reject(new Error("audit cancelled")));
			}, { once: true }));
		},
		async createServer() { servers += 1; return serverHarness().server; },
	}));
	const running = controller.run("", context().ctx);
	const rejected = assert.rejects(running, /audit cancelled/u);
	await started.promise;
	let shutdownFinished = false;
	const shutdown = controller.shutdown().then(() => { shutdownFinished = true; });
	await aborted.promise;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(shutdownFinished, false);
	release.resolve();
	await shutdown;
	await rejected;
	assert.equal(servers, 0);
});

test("post-audit staged drift aborts before serving", async () => {
	const first = patch("first");
	const second = patch("second");
	let reads = 0;
	let servers = 0;
	const controller = createReviewController(dependencies({
		async readPatch() { return reads++ === 0 ? first : second; },
		async createServer() { servers += 1; return serverHarness().server; },
	}));
	await assert.rejects(controller.run("", context().ctx), /changed during audit.*run \/review again/u);
	assert.equal(reads, 2);
	assert.equal(servers, 0);
});

test("stale and feedback decisions close first; feedback prefills exactly once without submission", async (t) => {
	for (const kind of ["stale", "send-feedback"] as const) await t.test(kind, async () => {
		const order: string[] = [];
		const terminal = deferred<ReviewServerDecision>();
		const server: ReviewServer = {
			url: "http://127.0.0.1:1234/secret/",
			decision: terminal.promise,
			async close() { order.push("close"); },
		};
		const harness = context();
		const originalSetEditorText = (harness.ctx as any).ui.setEditorText;
		(harness.ctx as any).ui.setEditorText = (text: string) => {
			order.push("editor");
			originalSetEditorText(text);
		};
		const controller = createReviewController(dependencies({ async createServer() { return server; } }));
		const running = controller.run("", harness.ctx);
		await waitForComponent(harness.components);
		if (kind === "stale") terminal.resolve({ kind, error: "Review is stale; run /review again." });
		else terminal.resolve({
			kind,
			decidedAt: "2026-01-01T00:00:00.000Z",
			feedbackMarkdown: "# Review feedback\n",
		});
		await running;
		if (kind === "stale") {
			assert.deepEqual(order, ["close"]);
			assert.deepEqual(harness.editor, []);
			assert.deepEqual(harness.notifications.at(-1), {
				message: "Review is stale; run /review again.", type: "error",
			});
		} else {
			assert.deepEqual(order, ["close", "editor"]);
			assert.deepEqual(harness.editor, ["# Review feedback\n"]);
		}
	});
});

test("negotiated cancel keybinding and session shutdown cancel one pending UI", async (t) => {
	for (const action of ["keybinding", "shutdown"] as const) await t.test(action, async () => {
		const reviewServer = serverHarness();
		const harness = context();
		const controller = createReviewController(dependencies({
			async createServer() { return reviewServer.server; },
		}));
		const running = controller.run("", harness.ctx);
		await waitForComponent(harness.components);
		if (action === "shutdown") await controller.shutdown();
		else {
			harness.components[0].handleInput?.("\x1b");
			harness.components[0].handleInput?.("\x03");
			assert.equal(harness.doneCalls, 0);
			harness.components[0].handleInput?.(CUSTOM_CANCEL_SEQUENCE);
			assert.deepEqual(harness.keybindingMatches, [
				{ data: "\x1b", binding: "tui.select.cancel" },
				{ data: "\x03", binding: "tui.select.cancel" },
				{ data: CUSTOM_CANCEL_SEQUENCE, binding: "tui.select.cancel" },
			]);
		}
		await running;
		assert.equal(harness.doneCalls, 1);
		assert.ok(reviewServer.closeCalls >= 1);
		assert.equal(harness.notifications.at(-1)?.message, "Review cancelled.");
		reviewServer.terminal.resolve({ kind: "approve", decidedAt: "later" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(harness.doneCalls, 1);
	});
});

test("entry point contains no browser launcher, URL logging, or message submission path", async () => {
	const source = await import("node:fs/promises").then(({ readFile }) =>
		readFile(new URL("./index.ts", import.meta.url), "utf8"));
	assert.doesNotMatch(source, /child_process|xdg-open|firefox|chromium|openExternal|console\.|sendUserMessage|sendMessage/u);
	assert.doesNotMatch(source, /registerCommand\((?!"review")/u);
});
