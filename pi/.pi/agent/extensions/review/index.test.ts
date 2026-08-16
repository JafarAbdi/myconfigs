import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TerminalInputHandler } from "@earendil-works/pi-coding-agent";

import { RESULT_TOOL_ENV } from "../subagent/runtimes.ts";
import { AUDIT_RESULT_TOOL } from "./audit-output.ts";
import review, {
	createReviewController,
	registerReview,
	REVIEW_SCOPE_ENTRY,
	summarizeWiffState,
	type ReviewDependencies,
} from "./index.ts";
import { WIFF_RESOLVE_TOOL } from "./review-fix.ts";
import { REVIEW_INTENT_MODEL, REVIEW_INTENT_RESULT_TOOL } from "./review-intent.ts";
import type { AuditFinding } from "./audit.ts";
import type { ReviewPatch } from "./review-git.ts";
import type {
	AddWiffCommentOptions,
	CreateWiffSessionOptions,
	PullWiffReviewOptions,
	PushWiffReviewOptions,
	RefreshWiffSessionOptions,
	RemoveWiffSessionOptions,
	ResumeWiffOptions,
	WiffBaseOptions,
	WiffComment,
	WiffPinnedOptions,
	WiffState,
} from "./review-wiff.ts";

const ROOT = "/repository";
const AGENT_DIR = "/agent";
const PI_SESSION_DIR = "/sessions/project";
const PI_SESSION_ID = "018f-parent-session";
const WIFF_DATA_DIR = `${AGENT_DIR}/wiff/${PI_SESSION_ID}`;
const SESSION = "2e4ypv3bb";
const PROJECT = "repository-project";
const MARKDOWN = "# Wiff review\n\n> comment 1: fix this\n";

function patch(raw = "exact patch", empty = false): ReviewPatch {
	return {
		snapshot: {
			repositoryRoot: ROOT,
			headOid: "2".repeat(40),
			view: "overall",
			paths: ["src/a.ts"],
			raw: Buffer.from(raw),
		},
		text: raw,
		empty,
	};
}

function finding(overrides: Partial<AuditFinding> = {}): AuditFinding {
	return {
		category: "contract",
		filePath: "src/a.ts",
		side: "additions",
		line: 12,
		message: "Contract violated; the invariant no longer holds.",
		...overrides,
	};
}

function wiffComment(overrides: Partial<WiffComment> = {}): WiffComment {
	return {
		id: "01J00000000000000000000001",
		number: 1,
		body: "Fix this defect.",
		target: { target: "review" },
		resolved: false,
		deleted: false,
		author: { name: "review/contract", kind: "agent" },
		...overrides,
	};
}

function wiffState(overrides: Partial<WiffState> = {}): WiffState {
	return {
		session: { id: SESSION, project: PROJECT, source: "stdin" },
		comments: [],
		verdicts: [],
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

interface ContextOptions {
	mode?: string;
	sessionId?: string;
	sessionDir?: string | undefined;
	select?: Array<string | undefined>;
	confirm?: boolean[];
}

function context(options: ContextOptions = {}) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const widgets: Array<{ key: string; content: string[] | undefined }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const selects: Array<{ title: string; options: string[]; cancellable: boolean }> = [];
	const confirms: Array<{
		title: string;
		message: string;
		cancellable: boolean;
	}> = [];
	const components: Array<{
		render(width: number): string[];
		handleInput?(data: string): void;
	}> = [];
	const tuiCalls: string[] = [];
	const terminalHandlers = new Set<TerminalInputHandler>();
	const choices = [...(options.select ?? [])];
	const answers = [...(options.confirm ?? [])];
	let idleCalls = 0;
	let sessionDirCalls = 0;
	let doneCalls = 0;
	let expanded = false;
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: "/working",
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		sessionManager: {
			getSessionId() { return options.sessionId ?? PI_SESSION_ID; },
			getSessionDir() {
				sessionDirCalls += 1;
				return Object.hasOwn(options, "sessionDir") ? options.sessionDir : PI_SESSION_DIR;
			},
		},
		async waitForIdle() { idleCalls += 1; },
		ui: {
			theme: {
				fg(_color: string, text: string) { return text; },
				bold(text: string) { return text; },
			},
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			setWidget(key: string, content: string[] | undefined) { widgets.push({ key, content }); },
			setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
			getToolsExpanded() { return expanded; },
			onTerminalInput(handler: TerminalInputHandler) {
				terminalHandlers.add(handler);
				return () => terminalHandlers.delete(handler);
			},
			async select(title: string, values: string[], dialog?: { signal?: AbortSignal }) {
				selects.push({ title, options: [...values], cancellable: Boolean(dialog?.signal) });
				return choices.shift();
			},
			async confirm(title: string, message: string, dialog?: { signal?: AbortSignal }) {
				confirms.push({ title, message, cancellable: Boolean(dialog?.signal) });
				return answers.shift() ?? false;
			},
			custom<T>(factory: (...args: any[]) => any): Promise<T> {
				return new Promise<T>((resolve, reject) => {
					const tui = {
						stop() { tuiCalls.push("stop"); },
						start() { tuiCalls.push("start"); },
						requestRender(force?: boolean) { tuiCalls.push(`requestRender(${force})`); },
					};
					try {
						const component = factory(
							tui,
							ctx.ui.theme,
							{ matches: () => false },
							(value: T) => {
								doneCalls += 1;
								resolve(value);
							},
						);
						components.push(component);
					} catch (error) {
						reject(error);
					}
				});
			},
		},
	};
	return {
		// SAFETY: the fake `ctx` implements only the ExtensionCommandContext members this harness's dependencies use.
		ctx: ctx as never,
		notifications,
		widgets,
		statuses,
		selects,
		confirms,
		components,
		tuiCalls,
		get idleCalls() { return idleCalls; },
		get sessionDirCalls() { return sessionDirCalls; },
		get doneCalls() { return doneCalls; },
		get terminalListeners() { return terminalHandlers.size; },
		set expanded(value: boolean) { expanded = value; },
	};
}

function extensionHarness(options: {
	readonly activeTools?: readonly string[];
	readonly sendUserMessage?: (
		message: string,
		options?: { deliverAs?: "steer" | "followUp" },
	) => void;
} = {}) {
	const commands = new Map<string, any>();
	const renderers = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	const tools: any[] = [];
	const sent: string[] = [];
	const deliveries: Array<{ deliverAs?: "steer" | "followUp" }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	let activeTools = [...(options.activeTools ?? ["read"])];
	const pi = {
		registerTool(tool: any) { tools.push(tool); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerEntryRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
		appendEntry<T>(type: string, data: T) { entries.push({ type, data }); },
		on(name: string, handler: (event: any, ctx: any) => void) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		sendUserMessage(message: string, delivery: { deliverAs?: "steer" | "followUp" } = {}) {
			options.sendUserMessage?.(message, delivery);
			sent.push(message);
			deliveries.push(delivery);
		},
	};
	return {
		// SAFETY: the fake `pi` implements only the ExtensionAPI members registerReview actually calls.
		pi: pi as never,
		commands,
		renderers,
		tools,
		sent,
		deliveries,
		entries,
		get activeTools() { return [...activeTools]; },
		async emit(name: string, event: any = {}, ctx: any = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function dependencies(overrides: Partial<ReviewDependencies> = {}): ReviewDependencies {
	const original = patch();
	return {
		async loadBorderedLoader() {
			return (_tui, _theme, message) => {
				const aborts = new AbortController();
				return {
					signal: aborts.signal,
					render: () => [message],
					handleInput(data: string) {
						if (data === "\x1b") aborts.abort(new Error("loader cancelled"));
					},
					invalidate() {},
				};
			};
		},
		deriveWiffDataDir(piSessionId) {
			assert.equal(piSessionId, PI_SESSION_ID);
			return WIFF_DATA_DIR;
		},
		async resolveRepositoryRoot() { return ROOT; },
		async resolveIntent() {
			return {
				selection: { view: "overall", paths: ["src/a.ts"] },
				resolvedPaths: ["src/a.ts"],
			};
		},
		async readPatch() { return original; },
		async runAudit() { return { findings: [] }; },
		async runReviewSynthesis(input) { return input.candidates; },
		reviewSnapshotsEqual(left, right) {
			return left.repositoryRoot === right.repositoryRoot &&
				left.headOid === right.headOid &&
				left.view === right.view &&
				left.paths.length === right.paths.length &&
				left.paths.every((path, index) => path === right.paths[index]) &&
				left.raw.equals(right.raw);
		},
		async hasWiffSession() { return false; },
		async createWiffSession() {},
		async refreshWiffSession() {},
		async readWiffState() { return wiffState(); },
		async renderWiffMarkdown() { return MARKDOWN; },
		async addWiffComment() {},
		async addWiffReply() {},
		async resolveWiffComment() {},
		async removeWiffSession() {},
		async resumeWiff() {},
		async pullWiffReview() {},
		async pushWiffReview() {},
		async resolveCheckedOutPullRequest() {
			return { number: 42, githubToken: "pull-token" };
		},
		async resolveGithubToken() { return "push-token"; },
		...overrides,
	};
}

interface WiffDoubleOptions {
	present?: boolean;
	state?: WiffState;
	removeOnResume?: boolean;
	failPublishAt?: number;
	failRemove?: boolean;
}

interface WiffCall {
	name: string;
	options: unknown;
}

interface WiffDouble {
	calls: WiffCall[];
	published: AddWiffCommentOptions[];
	present: boolean;
	deps: Partial<ReviewDependencies>;
}

function wiffDouble(options: WiffDoubleOptions = {}): WiffDouble {
	const calls: WiffCall[] = [];
	const published: AddWiffCommentOptions[] = [];
	const state = options.state ?? wiffState();
	const double: WiffDouble = {
		calls,
		published,
		present: options.present ?? false,
		deps: {},
	};
	double.deps = {
		async hasWiffSession(value) {
			calls.push({ name: "has", options: value });
			return double.present;
		},
		async createWiffSession(value) {
			calls.push({ name: "create", options: value });
			double.present = true;
		},
		async refreshWiffSession(value) {
			calls.push({ name: "refresh", options: value });
		},
		async readWiffState(value) {
			calls.push({ name: "state", options: value });
			return state;
		},
		async renderWiffMarkdown(value) {
			calls.push({ name: "markdown", options: value });
			return MARKDOWN;
		},
		async addWiffComment(value) {
			calls.push({ name: "comment", options: value });
			if (published.length === options.failPublishAt) throw new Error("publish failed");
			published.push(value);
		},
		async removeWiffSession(value) {
			calls.push({ name: "remove", options: value });
			if (options.failRemove) throw new Error("remove failed");
			double.present = false;
		},
		async resumeWiff(value) {
			calls.push({ name: "resume", options: value });
			value.tui.stop();
			value.tui.start();
			value.tui.requestRender(true);
			if (options.removeOnResume) double.present = false;
		},
		async pullWiffReview(value) {
			calls.push({ name: "pull", options: value });
			value.tui.stop();
			value.tui.start();
			value.tui.requestRender(true);
			double.present = true;
		},
		async pushWiffReview(value) {
			calls.push({ name: "push", options: value });
		},
	};
	return double;
}

function callOptions<T>(double: WiffDouble, name: string, index = 0): T {
	const calls = double.calls.filter((call) => call.name === name);
	assert.ok(calls[index], `missing ${name} call ${index}`);
	// SAFETY: callers request exactly the options type the named Wiff dependency call was made with.
	return calls[index].options as T;
}

function assertBase(options: WiffBaseOptions): void {
	assert.equal(options.repositoryRoot, ROOT);
	assert.equal(options.wiffDataDir, WIFF_DATA_DIR);
	assert.equal(options.signal?.aborted, false);
}

function assertPinned(options: WiffPinnedOptions): void {
	assertBase(options);
	assert.equal(options.session, SESSION);
	assert.equal(options.project, PROJECT);
}

test("marked review children register only their result tool", async (t) => {
	for (const resultTool of [AUDIT_RESULT_TOOL, REVIEW_INTENT_RESULT_TOOL]) {
		await t.test(resultTool, () => {
			const previous = process.env[RESULT_TOOL_ENV];
			const tools: string[] = [];
			let commands = 0;
			try {
				process.env[RESULT_TOOL_ENV] = resultTool;
				// SAFETY: a marked result-tool child only registers its result tool; the fake below implements no other ExtensionAPI member.
				review({
					registerTool(tool: { name: string }) { tools.push(tool.name); },
					registerCommand() { commands += 1; },
				} as never);
			} finally {
				if (previous === undefined) delete process.env[RESULT_TOOL_ENV];
				else process.env[RESULT_TOOL_ENV] = previous;
			}
			assert.deepEqual(tools, [resultTool]);
			assert.equal(commands, 0);
		});
	}
});

test("registers one /review command and one normally inactive resolver with static completion", async () => {
	const extension = extensionHarness({ activeTools: ["read", WIFF_RESOLVE_TOOL, "bash"] });
	let dependencyCalls = 0;
	registerReview(extension.pi, dependencies({
		async resolveRepositoryRoot() { dependencyCalls += 1; return ROOT; },
	}));
	await extension.emit("session_start");
	assert.deepEqual([...extension.commands.keys()], ["review"]);
	assert.deepEqual(extension.tools.map(({ name }) => name), [WIFF_RESOLVE_TOOL]);
	assert.deepEqual(extension.activeTools, ["read", "bash"]);
	const complete = extension.commands.get("review").getArgumentCompletions;
	assert.deepEqual(complete("").map(({ value, description }: any) => [value, description]), [
		["pull", "import the checked-out pull request"],
		["audit", "audit exact local Git changes"],
		["open", "open the private Wiff review"],
		["discuss", "discuss feedback read-only"],
		["fix", "address unresolved feedback"],
		["push", "publish one review author"],
		["remove", "remove the private review"],
	]);
	assert.deepEqual(complete("pu").map(({ value }: any) => value), ["pull", "push"]);
	assert.equal(complete("pull "), null);
	assert.equal(complete("unknown"), null);
	assert.equal(dependencyCalls, 0);
});

test("bare /review shows a cancellable action picker and cancellation does no external work", async () => {
	let roots = 0;
	const harness = context({ select: [undefined] });
	const controller = createReviewController(dependencies({
		async resolveRepositoryRoot() { roots += 1; return ROOT; },
	}));
	await controller.run("", harness.ctx);
	assert.deepEqual(harness.selects, [{
		title: "Review action",
		options: ["pull", "audit", "open", "discuss", "fix", "push", "remove"],
		cancellable: true,
	}]);
	assert.equal(roots, 0);
	assert.equal(harness.idleCalls, 1);
});

test("audit routing preserves unknown input whole and uses only audit's remainder", async (t) => {
	for (const item of [
		{ argument: "audit staged files", request: "staged files" },
		{ argument: "staged files", request: "staged files" },
		{ argument: "all changes except docs", request: "all changes except docs" },
	]) {
		await t.test(item.argument, async () => {
			let request: string | undefined;
			const controller = createReviewController(dependencies({
				async resolveIntent(input) {
					request = input.request;
					throw new Error("stop after routing");
				},
			}));
			await assert.rejects(controller.run(item.argument, context().ctx), /stop after routing/u);
			assert.equal(request, item.request);
		});
	}
});

test("non-audit actions reject arguments before repository or Wiff work", async () => {
	for (const action of ["pull", "open", "discuss", "fix", "push", "remove"]) {
		let roots = 0;
		const harness = context();
		const controller = createReviewController(dependencies({
			async resolveRepositoryRoot() { roots += 1; return ROOT; },
		}));
		await assert.rejects(controller.run(`${action} extra`, harness.ctx), new RegExp(`${action} accepts no arguments`, "u"));
		assert.equal(roots, 0);
		assert.equal(harness.sessionDirCalls, 0);
	}
});

test("every run requires TUI and a non-empty Pi session ID; only audit requires a session directory", async () => {
	const nonTui = context({ mode: "rpc" });
	await assert.rejects(
		createReviewController(dependencies()).run("discuss", nonTui.ctx),
		/requires TUI/u,
	);
	assert.equal(nonTui.idleCalls, 0);

	const missingId = context({ sessionId: "" });
	await assert.rejects(
		createReviewController(dependencies()).run("discuss", missingId.ctx),
		/non-empty Pi session ID/u,
	);
	assert.equal(missingId.idleCalls, 1);

	const noDirectory = context({ sessionDir: undefined });
	await assert.rejects(
		createReviewController(dependencies()).run("audit", noDirectory.ctx),
		/session directory for child agents/u,
	);
	const discuss = context({ sessionDir: undefined });
	const double = wiffDouble({ present: true });
	await createReviewController(dependencies({ ...double.deps })).run("discuss", discuss.ctx);
	assert.equal(discuss.sessionDirCalls, 0);
});

test("private Wiff identity is derived from the full Pi ID and reaches every exact operation", async () => {
	const double = wiffDouble({ present: true });
	let derived = "";
	const controller = createReviewController(dependencies({
		deriveWiffDataDir(id) {
			derived = id;
			return WIFF_DATA_DIR;
		},
		...double.deps,
	}));
	const message = await controller.run("fix", context().ctx);
	assert.equal(derived, PI_SESSION_ID);
	assert.doesNotMatch(message!, /WIFF_DATA_DIR/u);
	assertBase(callOptions(double, "has"));
	assertBase(callOptions(double, "state"));
	assertPinned(callOptions(double, "markdown"));
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(source, /deriveWiffDataDir\(getAgentDir\(\), piSessionId\)/u);
});

test("a new audit keeps exact capture, ordered publication, one Wiff open, then starts discussion", async () => {
	const findings = [
		finding(),
		finding({
			category: "test-integrity",
			filePath: "src/b.ts",
			side: "deletions",
			line: 3,
			message: "A regression is no longer proved.",
		}),
	];
	const double = wiffDouble();
	const harness = context();
	const events: string[] = [];
	let reads = 0;
	const scopes: unknown[] = [];
	const submitted: string[] = [];
	const controller = createReviewController(dependencies({
		async resolveIntent(input) {
			assert.equal(input.request, "unstaged greeting");
			assert.deepEqual(input.parentSession, { directory: PI_SESSION_DIR, id: PI_SESSION_ID });
			assert.equal(input.signal?.aborted, false);
			return {
				selection: { view: "overall", paths: ["src/a.ts"] },
				resolvedPaths: ["src/a.ts"],
			};
		},
		async readPatch() {
			reads += 1;
			if (reads === 2) events.push("freshness");
			return patch();
		},
		async runAudit(input) {
			events.push("audit");
			assert.equal(input.guidance, "unstaged greeting");
			input.onProgress?.({
				reviewer: "contract",
				model: "provider/model",
				phase: "complete",
				turns: 1,
				findings: 1,
			});
			return { findings };
		},
		...double.deps,
		async hasWiffSession(options) {
			events.push("discover");
			return await double.deps.hasWiffSession!(options);
		},
		async runReviewSynthesis(input) {
			events.push("synthesis");
			assert.deepEqual(input.patch, patch());
			assert.equal(input.candidates, findings);
			assert.deepEqual(input.openComments, []);
			assert.deepEqual(input.parentSession, { directory: PI_SESSION_DIR, id: PI_SESSION_ID });
			assert.equal(input.signal?.aborted, false);
			return input.candidates;
		},
		async createWiffSession(options) {
			events.push("create");
			await double.deps.createWiffSession!(options);
		},
	}));
	await controller.run(
		"audit unstaged greeting",
		harness.ctx,
		(feedback) => submitted.push(feedback),
		(scope) => scopes.push(scope),
	);

	assert.equal(reads, 2);
	assert.deepEqual(events.slice(0, 5), ["audit", "discover", "synthesis", "freshness", "create"]);
	assert.deepEqual(scopes, [{
		model: REVIEW_INTENT_MODEL,
		view: "overall",
		selection: "selected subset",
		paths: ["src/a.ts"],
	}]);
	assert.deepEqual(double.calls.map(({ name }) => name), [
		"has", "create", "state", "comment", "comment", "resume", "has", "state", "markdown",
	]);
	const created = callOptions<CreateWiffSessionOptions>(double, "create");
	assertBase(created);
	assert.equal(created.patch.toString("utf8"), "exact patch");
	assert.equal("session" in created, false);
	assert.equal("project" in created, false);
	assert.deepEqual(double.published.map(({ author, side }) => [author, side]), [
		["review/contract", undefined],
		["review/test-integrity", "before"],
	]);
	for (const comment of double.published) assertPinned(comment);
	assert.equal(double.calls.filter(({ name }) => name === "resume").length, 1);
	assert.deepEqual(harness.selects, []);
	assert.deepEqual(harness.tuiCalls, ["stop", "start", "requestRender(true)"]);
	assert.equal(harness.terminalListeners, 0);
	assert.equal(submitted.length, 1);
	assert.match(submitted[0]!, /Discuss the feedback/u);
	assert.match(submitted[0]!, /# Wiff review/u);
	assert.deepEqual(harness.components.slice(0, 3).map((component) => component.render(80)[0]), [
		"Luna is resolving review scope…",
		"Synthesizing review findings…",
		"Publishing review to Wiff…",
	]);
	assert.equal(
		harness.notifications.at(-1)?.message,
		summarizeWiffState(wiffState()),
	);
});

test("an audit with no findings skips synthesis and all Wiff work", async () => {
	const double = wiffDouble({ present: true });
	const harness = context();
	let reads = 0;
	let syntheses = 0;
	let submissions = 0;
	const controller = createReviewController(dependencies({
		...double.deps,
		async readPatch() { reads += 1; return patch(); },
		async runReviewSynthesis() { syntheses += 1; return []; },
	}));
	await controller.run("audit", harness.ctx, () => { submissions += 1; });
	assert.equal(reads, 1);
	assert.equal(syntheses, 0);
	assert.equal(submissions, 0);
	assert.deepEqual(double.calls, []);
	assert.deepEqual(double.published, []);
	assert.deepEqual(harness.components.map((component) => component.render(80)[0]), [
		"Luna is resolving review scope…",
	]);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Review complete: all 4 reviewers returned no findings. Synthesis and publication were skipped.",
		type: "info",
	});
	assert.equal(
		harness.notifications.some(({ message }) => message.startsWith("Review published")),
		false,
	);
	assert.equal(harness.terminalListeners, 0);
});

test("a repeated audit compares only current open top-level comments and publishes the stub selection", async () => {
	const open = wiffComment();
	const state = wiffState({
		comments: [
			open,
			wiffComment({ id: "resolved", number: 2, resolved: true }),
			wiffComment({ id: "deleted", number: 3, deleted: true }),
			wiffComment({
				id: "reply",
				number: 4,
				target: { target: "comment", id: open.id },
			}),
		],
	});
	const candidates = [finding(), finding({ category: "simplicity", line: 20 })];
	const double = wiffDouble({ present: true, state, removeOnResume: true });
	const harness = context();
	const controller = createReviewController(dependencies({
		...double.deps,
		async runAudit() { return { findings: candidates }; },
		async runReviewSynthesis(input) {
			assert.deepEqual(input.openComments, [open]);
			assert.equal(input.candidates, candidates);
			return [candidates[1]!];
		},
	}));
	await controller.run("audit", harness.ctx);
	assert.deepEqual(double.calls.map(({ name }) => name), [
		"has", "state", "refresh", "comment", "resume", "has",
	]);
	const refreshed = callOptions<RefreshWiffSessionOptions>(double, "refresh");
	assertPinned(refreshed);
	assert.equal(refreshed.patch.toString("utf8"), "exact patch");
	assert.equal(double.calls.filter(({ name }) => name === "create").length, 0);
	assert.deepEqual(double.published.map(({ line }) => line), [20]);
	assert.equal(
		harness.notifications.find(({ message }) => message.startsWith("Review published"))?.message,
		`Review published 1 finding to Wiff review ${SESSION}.`,
	);
});

test("audit refuses a non-stdin private review before refresh or publication", async () => {
	const state = wiffState({
		session: { id: SESSION, project: PROJECT, source: "forge github" },
	});
	const double = wiffDouble({ present: true, state });
	let syntheses = 0;
	await assert.rejects(
		createReviewController(dependencies({
			...double.deps,
			async runAudit() { return { findings: [finding()] }; },
			async runReviewSynthesis() { syntheses += 1; return []; },
		})).run("audit", context().ctx),
		/source "forge github", not stdin.*\/review remove/u,
	);
	assert.equal(syntheses, 0);
	assert.deepEqual(double.calls.map(({ name }) => name), ["has", "state"]);
	assert.equal(double.calls.some(({ name }) => ["create", "refresh", "comment"].includes(name)), false);
});

test("pull refuses an existing private review before resolving GitHub state", async () => {
	const double = wiffDouble({ present: true });
	let github = 0;
	await assert.rejects(
		createReviewController(dependencies({
			...double.deps,
			async resolveCheckedOutPullRequest() {
				github += 1;
				return { number: 42, githubToken: "secret" };
			},
		})).run("pull", context().ctx),
		/private Wiff review already exists.*\/review open.*\/review remove/u,
	);
	assert.equal(github, 0);
	assert.deepEqual(double.calls.map(({ name }) => name), ["has"]);
});

test("an existing private review from another repository fails with an actionable recovery", async () => {
	const double = wiffDouble({ present: true });
	await assert.rejects(
		createReviewController(dependencies({
			...double.deps,
			async readWiffState() { throw new Error("no session found for project other-repository"); },
		})).run("open", context().ctx),
		/unavailable from the current repository.*return to the review's repository.*new Pi session.*no session found for project other-repository/u,
	);
});

test("pull uses visible cancellable lookup, checked-out PR handoff, private data, and post-state", async () => {
	const double = wiffDouble();
	const harness = context();
	const events: string[] = [];
	const controller = createReviewController(dependencies({
		...double.deps,
		async resolveCheckedOutPullRequest(repositoryRoot, signal) {
			events.push("github");
			assert.equal(repositoryRoot, ROOT);
			assert.equal(signal?.aborted, false);
			return { number: 42, githubToken: "private-token" };
		},
		async pullWiffReview(options) {
			events.push("pull");
			await double.deps.pullWiffReview!(options);
		},
	}));
	await controller.run("pull", harness.ctx);
	assert.deepEqual(events, ["github", "pull"]);
	const pulled = callOptions<PullWiffReviewOptions>(double, "pull");
	assertBase(pulled);
	assert.equal(pulled.pullRequestNumber, 42);
	assert.equal(pulled.githubToken, "private-token");
	assert.deepEqual(harness.tuiCalls, ["stop", "start", "requestRender(true)"]);
	assert.deepEqual(harness.components.map((component) => component.render(80)[0]), [
		"Finding pull request…",
		undefined,
		"Reading Wiff review…",
	]);
	assert.match(harness.notifications[0]!.message, /syncing pull request #42.*handing over/u);
	assert.equal(harness.notifications.at(-1)?.message, summarizeWiffState(wiffState()));
});

test("open pins the existing review, hands off once, and reports Wiff removal", async () => {
	const double = wiffDouble({ present: true, removeOnResume: true });
	const harness = context();
	await createReviewController(dependencies({ ...double.deps })).run("open", harness.ctx);
	assertPinned(callOptions<ResumeWiffOptions>(double, "resume"));
	assert.equal(double.calls.filter(({ name }) => name === "resume").length, 1);
	assert.equal(harness.notifications.at(-1)?.message, `Wiff removed review ${SESSION}.`);
	assert.deepEqual(harness.tuiCalls, ["stop", "start", "requestRender(true)"]);
});

test("discuss is one strictly read-only turn with no freshness or mutation guidance", async () => {
	const double = wiffDouble({ present: true });
	let patchReads = 0;
	const message = await createReviewController(dependencies({
		...double.deps,
		async readPatch() { patchReads += 1; return patch(); },
	})).run("discuss", context().ctx);
	assert.equal(patchReads, 0);
	assert.match(message!, /strictly read-only/u);
	assert.match(message!, new RegExp(SESSION, "u"));
	assert.match(message!, new RegExp(PROJECT, "u"));
	assert.match(message!, new RegExp(WIFF_DATA_DIR, "u"));
	assert.match(message!, /# Wiff review/u);
	assert.doesNotMatch(message!, /untrusted|BEGIN WIFF|END WIFF/iu);
	assert.doesNotMatch(message!, /--agent|wiff comment|env WIFF_DATA_DIR/u);
	assert.deepEqual(double.calls.map(({ name }) => name), ["has", "state", "markdown"]);
});

test("fix edits and tests before narrow addressed-only resolution without CLI recipes", async () => {
	const double = wiffDouble({ present: true });
	const message = await createReviewController(dependencies({ ...double.deps }))
		.run("fix", context().ctx);
	assert.match(message!, new RegExp(SESSION, "u"));
	assert.match(message!, new RegExp(PROJECT, "u"));
	assert.match(message!, /Edit the code, fix each root cause, and run relevant tests/u);
	assert.match(message!, /call `wiff_resolve` once for each comment completely addressed/u);
	assert.match(message!, /Leave partially addressed or unclear comments unchanged/u);
	assert.ok(message!.indexOf("run relevant tests") < message!.indexOf("wiff_resolve"));
	assert.match(message!, /# Wiff review/u);
	assert.doesNotMatch(message!, /WIFF_DATA_DIR|env\s+WIFF|wiff comment|wiff \.\.\.|--session|--project|--agent/iu);
	assert.doesNotMatch(message!, /untrusted|BEGIN WIFF|END WIFF/iu);
});

test("registered fix arms its exact turn and tool while discuss and audit discussion do not", async () => {
	const live = wiffComment();
	const state = wiffState({ comments: [live] });
	const resolvedState = wiffState({ comments: [{ ...live, resolved: true }] });
	const double = wiffDouble({ present: true, state });
	const resolutionCalls: unknown[] = [];
	let resolved = false;
	const extension = extensionHarness();
	registerReview(extension.pi, dependencies({
		...double.deps,
		async runAudit() { return { findings: [finding()] }; },
		async readWiffState(options) {
			double.calls.push({ name: "state", options });
			return resolved ? resolvedState : state;
		},
		async resolveWiffComment(options) {
			resolutionCalls.push(options);
			resolved = true;
		},
	}));
	const command = extension.commands.get("review");

	await command.handler("discuss", context().ctx);
	assert.match(extension.sent[0]!, /strictly read-only/u);
	await extension.emit("before_agent_start", { prompt: extension.sent[0] });
	assert.equal(extension.activeTools.includes(WIFF_RESOLVE_TOOL), false);

	await command.handler("audit", context().ctx);
	assert.match(extension.sent[1]!, /strictly read-only/u);
	assert.match(extension.sent[1]!, /# Wiff review/u);
	await extension.emit("before_agent_start", { prompt: extension.sent[1] });
	assert.equal(extension.activeTools.includes(WIFF_RESOLVE_TOOL), false);

	await command.handler("fix", context().ctx);
	const fixPrompt = extension.sent[2]!;
	assert.deepEqual(extension.deliveries, [{}, {}, {}]);
	assert.match(fixPrompt, /wiff_resolve/u);
	assert.equal(extension.activeTools.includes(WIFF_RESOLVE_TOOL), false);
	await extension.emit("before_agent_start", { prompt: fixPrompt });
	assert.equal(extension.activeTools.includes(WIFF_RESOLVE_TOOL), true);
	const signal = new AbortController().signal;
	await extension.tools[0].execute("call", { comment: "1" }, signal);
	assert.deepEqual(resolutionCalls, [{
		repositoryRoot: ROOT,
		wiffDataDir: WIFF_DATA_DIR,
		session: SESSION,
		project: PROJECT,
		signal,
		author: "pi-review",
		commentId: live.id,
	}]);
});

test("push derives deterministic unique authors and obtains a token only after exact confirmation", async () => {
	const state = wiffState({
		description: {
			author: { name: "alice", kind: "human" },
			title: "Review title",
			body: "",
		},
		comments: [
			wiffComment({ id: "1", number: 1, author: { name: "review/tests", kind: "agent" } }),
			wiffComment({ id: "2", number: 2, author: { name: "alice", kind: "human" } }),
			wiffComment({
				id: "3",
				number: 3,
				resolved: true,
				author: { name: "sam", kind: "human" },
			}),
		],
		verdicts: [
			{ author: { name: "review/tests", kind: "agent" }, disposition: "approve" },
			{ author: { name: "alice", kind: "agent" }, disposition: "request_changes" },
		],
	});
	const double = wiffDouble({ present: true, state });
	const harness = context({ select: ["review/tests (agent)"], confirm: [true] });
	const events: string[] = [];
	const controller = createReviewController(dependencies({
		...double.deps,
		async resolveGithubToken(_root, signal) {
			events.push("token");
			assert.equal(signal?.aborted, false);
			return "private-token";
		},
		async pushWiffReview(options) {
			events.push("push");
			await double.deps.pushWiffReview!(options);
		},
	}));
	await controller.run("push", harness.ctx);
	assert.deepEqual(harness.selects[0]?.options, [
		"alice (human)",
		"review/tests (agent)",
		"sam (human)",
		"alice (agent)",
	]);
	assert.deepEqual(events, ["token", "push"]);
	assert.match(harness.confirms[0]!.message, new RegExp(`Session: ${SESSION}`, "u"));
	assert.match(harness.confirms[0]!.message, /Author: review\/tests/u);
	assert.match(harness.confirms[0]!.message, /Kind: agent/u);
	assert.match(harness.confirms[0]!.message, /Verdict: approve \(may be submitted\)/u);
	const pushed = callOptions<PushWiffReviewOptions>(double, "push");
	assertPinned(pushed);
	assert.equal(pushed.author, "review/tests");
	assert.equal(pushed.agent, true);
	assert.equal(pushed.githubToken, "private-token");
	assert.match(harness.components.at(-1)!.render(80)[0]!, /Publishing Wiff review/u);
	assert.match(harness.notifications.at(-1)!.message, /Published review\/tests \(agent\)/u);
});

test("push cancellation or rejected confirmation never resolves a token or reports success", async (t) => {
	for (const item of [
		{ name: "picker cancelled", select: [undefined], confirm: [] },
		{ name: "confirmation rejected", select: ["alice (human)"], confirm: [false] },
	]) {
		await t.test(item.name, async () => {
			const state = wiffState({
				description: {
					author: { name: "alice", kind: "human" },
					title: "Title",
					body: "",
				},
			});
			const double = wiffDouble({ present: true, state });
			let tokens = 0;
			const harness = context({ select: item.select, confirm: item.confirm });
			await createReviewController(dependencies({
				...double.deps,
				async resolveGithubToken() { tokens += 1; return "token"; },
			})).run("push", harness.ctx);
			assert.equal(tokens, 0);
			assert.equal(double.calls.some(({ name }) => name === "push"), false);
			assert.equal(harness.notifications.some(({ message }) => message.startsWith("Published")), false);
		});
	}
});

test("push errors before the picker when Wiff has no authors", async () => {
	const double = wiffDouble({ present: true });
	const harness = context();
	await assert.rejects(
		createReviewController(dependencies({ ...double.deps })).run("push", harness.ctx),
		/no authors to push/u,
	);
	assert.deepEqual(harness.selects, []);
});

test("remove confirms exact identity, title, and open count before a cancellable exact removal", async () => {
	const state = wiffState({
		description: {
			author: { name: "alice", kind: "human" },
			title: "Review title",
			body: "body",
		},
		comments: [
			wiffComment({ id: "1", number: 1, author: { name: "alice", kind: "human" } }),
			wiffComment({
				id: "2",
				number: 2,
				resolved: true,
				author: { name: "alice", kind: "human" },
			}),
			wiffComment({
				id: "3",
				number: 3,
				deleted: true,
				author: { name: "alice", kind: "human" },
			}),
		],
	});
	const double = wiffDouble({ present: true, state });
	const harness = context({ confirm: [true] });
	await createReviewController(dependencies({ ...double.deps })).run("remove", harness.ctx);
	assert.equal(harness.confirms[0]?.title, `Remove Wiff review ${SESSION}?`);
	assert.match(harness.confirms[0]!.message, new RegExp(`Session: ${SESSION}`, "u"));
	assert.match(harness.confirms[0]!.message, /Title: Review title/u);
	assert.match(harness.confirms[0]!.message, /Open comments: 1/u);
	assertPinned(callOptions<RemoveWiffSessionOptions>(double, "remove"));
	assert.match(harness.components.at(-1)!.render(80)[0]!, /Removing Wiff review/u);
	assert.deepEqual(harness.notifications.at(-1), {
		message: `Removed Wiff review ${SESSION}.`,
		type: "info",
	});
});

test("remove cancellation and failure never report success", async (t) => {
	await t.test("confirmation cancellation", async () => {
		const double = wiffDouble({ present: true });
		const harness = context({ confirm: [false] });
		await createReviewController(dependencies({ ...double.deps })).run("remove", harness.ctx);
		assert.equal(double.calls.some(({ name }) => name === "remove"), false);
	});
	await t.test("CLI failure", async () => {
		const double = wiffDouble({ present: true, failRemove: true });
		const harness = context({ confirm: [true] });
		await assert.rejects(
			createReviewController(dependencies({ ...double.deps })).run("remove", harness.ctx),
			/remove failed/u,
		);
		assert.equal(harness.notifications.some(({ message }) => message.startsWith("Removed")), false);
	});
});

test("generic loader Escape combines cancellation with the run signal and stops captured work", async () => {
	const started = deferred<void>();
	let states = 0;
	const harness = context();
	const controller = createReviewController(dependencies({
		async resolveRepositoryRoot(_root) {
			return await new Promise<string>((_resolve, reject) => {
				started.resolve();
				const componentReady = () => {
					// SAFETY: this test's loader component is the one built by loadBorderedLoader above, which always sets `signal`.
					const signal = (harness.components[0] as any)?.signal;
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				};
				queueMicrotask(componentReady);
			});
		},
		async readWiffState() { states += 1; return wiffState(); },
	}));
	const running = controller.run("discuss", harness.ctx);
	await started.promise;
	await Promise.resolve();
	assert.equal(harness.components[0]?.render(80)[0], "Reading Wiff review…");
	harness.components[0]?.handleInput?.("\x1b");
	await assert.rejects(running, /Wiff review reading cancelled/u);
	assert.equal(states, 0);
});

test("a Wiff handoff failure completes the custom component and propagates without success", async () => {
	const double = wiffDouble({ present: true });
	const harness = context();
	await assert.rejects(
		createReviewController(dependencies({
			...double.deps,
			async resumeWiff() { throw new Error("wiff resume exited (9)"); },
		})).run("open", harness.ctx),
		/wiff resume exited \(9\)/u,
	);
	assert.equal(harness.doneCalls, 2);
	assert.equal(harness.notifications.some(({ message }) => message.startsWith("Wiff review ")), false);
});

test("synthesis failure leaves private Wiff state untouched", async () => {
	const double = wiffDouble();
	await assert.rejects(
		createReviewController(dependencies({
			async runAudit() { return { findings: [finding()] }; },
			...double.deps,
			async runReviewSynthesis() { throw new Error("synthesis failed"); },
		})).run("audit", context().ctx),
		/synthesis failed/u,
	);
	assert.deepEqual(double.calls.map(({ name }) => name), ["has"]);
	assert.equal(double.calls.some(({ name }) => ["create", "refresh", "comment"].includes(name)), false);
});

test("post-synthesis freshness failure leaves private Wiff state untouched", async () => {
	let reads = 0;
	let synthesized = false;
	const double = wiffDouble();
	await assert.rejects(
		createReviewController(dependencies({
			async readPatch() { return reads++ === 0 ? patch("first") : patch("second"); },
			async runAudit() { return { findings: [finding()] }; },
			...double.deps,
			async runReviewSynthesis(input) {
				synthesized = true;
				return input.candidates;
			},
		})).run("audit", context().ctx),
		/Selected candidate changed during audit/u,
	);
	assert.equal(synthesized, true);
	assert.deepEqual(double.calls.map(({ name }) => name), ["has"]);
	assert.equal(double.calls.some(({ name }) => ["create", "refresh", "comment"].includes(name)), false);
});

test("publication failure stops, removes only a newly created review, and reports selected total", async () => {
	const findings = [
		finding(),
		finding({ category: "simplicity", line: 20 }),
		finding({ category: "test-integrity", line: 30 }),
	];
	const selected = [findings[0]!, findings[2]!];
	const double = wiffDouble({ failPublishAt: 1 });
	const harness = context();
	await createReviewController(dependencies({
		async runAudit() { return { findings }; },
		async runReviewSynthesis() { return selected; },
		...double.deps,
	})).run("audit", harness.ctx);
	assert.deepEqual(double.calls.map(({ name }) => name), [
		"has", "create", "state", "comment", "comment", "remove",
	]);
	const cleanup = callOptions<RemoveWiffSessionOptions>(double, "remove");
	assert.equal(cleanup.signal, undefined);
	assert.equal(double.calls.some(({ name }) => name === "resume"), false);
	assert.match(harness.notifications.at(-1)!.message, /could not publish.*test-integrity/u);
	assert.equal(harness.statuses.at(-1)?.text, "review: publication failed");
	assert.match(harness.widgets.at(-1)!.content!.join("\n"), /Published: 1\/2 findings/u);
	assert.match(harness.widgets.at(-1)!.content!.at(-1)!, /Removed the newly created/u);
});

test("publication failure retains an existing refreshed review and reports partial state", async () => {
	const double = wiffDouble({ present: true, failPublishAt: 1 });
	const harness = context();
	await createReviewController(dependencies({
		async runAudit() {
			return { findings: [finding(), finding({ category: "simplicity", line: 20 })] };
		},
		...double.deps,
	})).run("audit", harness.ctx);
	assert.deepEqual(double.calls.map(({ name }) => name), [
		"has", "state", "refresh", "comment", "comment",
	]);
	assert.equal(double.present, true);
	assert.match(
		harness.widgets.at(-1)!.content!.at(-1)!,
		/Retained the refreshed Wiff session and its 1 published comment/u,
	);
});

test("shutdown during publication aborts the child and removes a newly created review", async () => {
	const started = deferred<void>();
	const double = wiffDouble();
	const controller = createReviewController(dependencies({
		async runAudit() { return { findings: [finding()] }; },
		...double.deps,
		async addWiffComment(options) {
			double.calls.push({ name: "comment", options });
			started.resolve();
			await new Promise<void>((_resolve, reject) => options.signal?.addEventListener(
				"abort",
				() => reject(options.signal?.reason ?? new Error("publication aborted")),
				{ once: true },
			));
		},
	}));
	const running = controller.run("audit", context().ctx);
	const rejected = assert.rejects(running, /Review session shut down/u);
	await started.promise;
	await controller.shutdown();
	await rejected;
	assert.deepEqual(double.calls.map(({ name }) => name), [
		"has", "create", "state", "comment", "remove",
	]);
	assert.equal(callOptions<RemoveWiffSessionOptions>(double, "remove").signal, undefined);
	assert.equal(double.present, false);
});

test("shutdown aborts and awaits an in-flight audit without touching Wiff", async () => {
	const started = deferred<void>();
	const aborted = deferred<void>();
	const release = deferred<void>();
	const double = wiffDouble();
	const controller = createReviewController(dependencies({
		runAudit(input) {
			started.resolve();
			return new Promise((_resolve, reject) => input.signal?.addEventListener("abort", () => {
				aborted.resolve();
				void release.promise.then(() => reject(new Error("audit cancelled")));
			}, { once: true }));
		},
		...double.deps,
	}));
	const running = controller.run("audit", context().ctx);
	const rejected = assert.rejects(running, /audit cancelled/u);
	await started.promise;
	let shutdownFinished = false;
	const shutdown = controller.shutdown().then(() => { shutdownFinished = true; });
	await aborted.promise;
	await Promise.resolve();
	assert.equal(shutdownFinished, false);
	release.resolve();
	await shutdown;
	await rejected;
	assert.deepEqual(double.calls, []);
	await assert.rejects(controller.run("audit", context().ctx), /shutting down/u);
});

test("scope entries remain registered and expandable", async () => {
	const extension = extensionHarness();
	registerReview(extension.pi, dependencies());
	const renderer = extension.renderers.get(REVIEW_SCOPE_ENTRY);
	assert.ok(renderer);
	const data = {
		model: REVIEW_INTENT_MODEL,
		view: "overall",
		selection: "whole view",
		paths: ["src/a.ts", "src/b.ts"],
	};
	const theme = { fg: (_color: string, text: string) => text };
	assert.match(renderer({ data }, { expanded: false }, theme).render(200)[0]!, /Ctrl\+O details/u);
	assert.deepEqual(renderer({ data }, { expanded: true }, theme).render(200).slice(-2), [
		'  "src/a.ts"',
		'  "src/b.ts"',
	]);
});

test("registered failures are reported and shutdown aborts the context", async () => {
	const extension = extensionHarness();
	registerReview(extension.pi, dependencies({
		async resolveRepositoryRoot() { throw new Error("repository failed"); },
	}));
	const harness = context();
	await extension.commands.get("review").handler("open", harness.ctx);
	assert.deepEqual(harness.notifications.at(-1), { message: "repository failed", type: "error" });
	let aborts = 0;
	await extension.emit("session_shutdown", {}, { abort() { aborts += 1; } });
	assert.equal(aborts, 1);
});

test("a synchronous fix send failure clears the armed resolver", async () => {
	let attemptedPrompt = "";
	const extension = extensionHarness({
		sendUserMessage(message) {
			attemptedPrompt = message;
			throw new Error("send failed");
		},
	});
	const double = wiffDouble({ present: true });
	registerReview(extension.pi, dependencies({ ...double.deps }));
	const harness = context();
	await extension.commands.get("review").handler("fix", harness.ctx);
	assert.deepEqual(harness.notifications.at(-1), { message: "send failed", type: "error" });
	await extension.emit("before_agent_start", { prompt: attemptedPrompt });
	assert.equal(extension.activeTools.includes(WIFF_RESOLVE_TOOL), false);
});

test("the unified controller has no forced menu, shell transport, sidecar, or fallback", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /child_process|--if-needed|APPROVE_DECISION|REOPEN_DECISION|DECISIONS/u);
	assert.doesNotMatch(source, /review-state|session picker|spawnSync|execSync|shell\s*:/u);
	assert.match(source, /pi\.appendEntry\(REVIEW_SCOPE_ENTRY, scope\)/u);
	assert.match(source, /pi\.sendUserMessage\(feedback\)/u);
	assert.equal((source.match(/registerCommand\("review"/gu) ?? []).length, 1);
});
