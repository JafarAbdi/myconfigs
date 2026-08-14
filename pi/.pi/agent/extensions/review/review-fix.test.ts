import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	registerWiffResolveTool,
	WIFF_RESOLVE_TOOL,
	type FixTurn,
	type WiffResolveDependencies,
} from "./review-fix.ts";
import type {
	AddWiffReplyOptions,
	ResolveWiffCommentOptions,
	WiffComment,
	WiffPinnedOptions,
	WiffState,
} from "./review-wiff.ts";

const PROMPT = "Exact generated fix prompt\n\n# Wiff review";
const TARGET = {
	repositoryRoot: "/repository",
	wiffDataDir: "/agent/wiff/pi-session",
	session: "wiff-session",
	project: "wiff-project",
} as const;
const COMMENT_ID = "01J00000000000000000000007";

function comment(overrides: Partial<WiffComment> = {}): WiffComment {
	return {
		id: COMMENT_ID,
		number: 7,
		body: "Fix the defect.",
		target: { target: "review" },
		resolved: false,
		deleted: false,
		author: { name: "review/correctness", kind: "agent" },
		...overrides,
	};
}

function state(comments: readonly WiffComment[]): WiffState {
	return {
		session: { id: TARGET.session, project: TARGET.project, source: "stdin" },
		comments,
		verdicts: [],
	};
}

interface DependencyCall {
	readonly name: "read" | "reply" | "resolve";
	readonly options: WiffPinnedOptions | AddWiffReplyOptions | ResolveWiffCommentOptions;
}

function dependencyDouble(
	states: readonly WiffState[],
	overrides: Partial<WiffResolveDependencies> = {},
): WiffResolveDependencies & { readonly calls: DependencyCall[] } {
	const remaining = [...states];
	const calls: DependencyCall[] = [];
	return {
		calls,
		async readWiffState(options) {
			calls.push({ name: "read", options });
			const next = remaining.shift();
			if (!next) throw new Error("unexpected Wiff state read");
			return next;
		},
		async addWiffReply(options) {
			calls.push({ name: "reply", options });
		},
		async resolveWiffComment(options) {
			calls.push({ name: "resolve", options });
		},
		...overrides,
	};
}

interface RegisteredTool {
	readonly name: string;
	readonly executionMode?: string;
	readonly parameters: any;
	execute(
		toolCallId: string,
		parameters: { comment: string; reply?: string },
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

type FakeHandlerResult = { readonly action: "handled" } | undefined;

function extensionHarness(initialTools: readonly string[] = ["read", WIFF_RESOLVE_TOOL, "bash"]) {
	let activeTools = [...initialTools];
	const tools: RegisteredTool[] = [];
	const activeSets: string[][] = [];
	const messages: string[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => FakeHandlerResult>>();
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) {
			activeTools = [...names];
			activeSets.push([...names]);
		},
		sendUserMessage(message: string) { messages.push(message); },
		on(name: string, handler: (event: any, ctx: any) => FakeHandlerResult) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
	};
	return {
		// SAFETY: the fake `pi` implements only the ExtensionAPI members registerWiffResolveTool actually calls.
		pi: pi as never,
		tools,
		activeSets,
		messages,
		get activeTools() { return [...activeTools]; },
		setActiveTools(names: readonly string[]) { activeTools = [...names]; },
		async emit(name: string, event: any = {}, ctx: any = {}) {
			let result: FakeHandlerResult;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
			return result;
		},
	};
}

function fixTurn(): FixTurn {
	return { prompt: PROMPT, target: TARGET };
}

async function activate(
	harness: ReturnType<typeof extensionHarness>,
	controller: ReturnType<typeof registerWiffResolveTool>,
): Promise<void> {
	controller.arm(fixTurn());
	await harness.emit("before_agent_start", { prompt: PROMPT });
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), true);
}

function registeredTool(harness: ReturnType<typeof extensionHarness>): RegisteredTool {
	assert.equal(harness.tools.length, 1);
	return harness.tools[0]!;
}

function assertPinnedSignal(options: WiffPinnedOptions, signal: AbortSignal): void {
	assert.deepEqual(options, { ...TARGET, signal });
}

test("registers one bounded sequential tool and removes only it at session start", async () => {
	const harness = extensionHarness(["read", WIFF_RESOLVE_TOOL, "other"]);
	registerWiffResolveTool(harness.pi, dependencyDouble([]));
	await harness.emit("session_start");
	const tool = registeredTool(harness);
	assert.equal(tool.name, WIFF_RESOLVE_TOOL);
	assert.equal(tool.executionMode, "sequential");
	assert.deepEqual(tool.parameters.required, ["comment"]);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.parameters.properties.comment.type, "string");
	assert.equal(tool.parameters.properties.reply.type, "string");
	assert.equal(tool.parameters.properties.reply.maxLength > 0, true);
	assert.deepEqual(harness.activeTools, ["read", "other"]);
});

test("activates only an exact pending prompt and preserves current tool changes", async () => {
	const harness = extensionHarness();
	const controller = registerWiffResolveTool(harness.pi, dependencyDouble([]));

	controller.arm(fixTurn());
	harness.setActiveTools(["read", "late-tool"]);
	await harness.emit("before_agent_start", { prompt: `${PROMPT} ` });
	assert.deepEqual(harness.activeTools, ["read", "late-tool"]);
	await harness.emit("before_agent_start", { prompt: PROMPT });
	assert.deepEqual(harness.activeTools, ["read", "late-tool"]);

	controller.arm(fixTurn());
	await harness.emit("before_agent_start", { prompt: PROMPT });
	assert.deepEqual(harness.activeTools, ["read", "late-tool", WIFF_RESOLVE_TOOL]);
	harness.setActiveTools(["read", WIFF_RESOLVE_TOOL, "wrong-turn-tool"]);
	await harness.emit("before_agent_start", { prompt: "Ordinary user prompt" });
	assert.deepEqual(harness.activeTools, ["read", "wrong-turn-tool"]);

	controller.arm(fixTurn());
	await harness.emit("before_agent_start", { prompt: PROMPT });
	harness.setActiveTools(["read", WIFF_RESOLVE_TOOL, "newer-tool"]);
	controller.clear();
	assert.deepEqual(harness.activeTools, ["read", "newer-tool"]);
});

test("execute independently rejects inactive and merely pending invocations", async () => {
	const harness = extensionHarness();
	const dependencies = dependencyDouble([]);
	const controller = registerWiffResolveTool(harness.pi, dependencies);
	const tool = registeredTool(harness);
	await assert.rejects(
		tool.execute("call", { comment: "7" }),
		/only during the active \/review fix invocation/u,
	);
	controller.arm(fixTurn());
	await assert.rejects(
		tool.execute("call", { comment: "7" }),
		/only during the active \/review fix invocation/u,
	);
	assert.deepEqual(dependencies.calls, []);
});

test("resolves a decimal display number with pinned identity, signal, author, and canonical ID", async () => {
	const live = comment();
	const final = state([
		{ ...live, resolved: true },
		comment({ id: "open", number: 8, body: "still open" }),
		comment({
			id: "reply",
			number: 9,
			target: { target: "comment", id: "open" },
		}),
		comment({ id: "deleted", number: 10, deleted: true }),
		comment({ id: "resolved", number: 11, resolved: true }),
	]);
	const dependencies = dependencyDouble([state([live]), final]);
	const harness = extensionHarness();
	const controller = registerWiffResolveTool(harness.pi, dependencies);
	await activate(harness, controller);
	const signal = new AbortController().signal;
	const result = await registeredTool(harness).execute("call", { comment: "7" }, signal);

	assert.deepEqual(dependencies.calls.map(({ name }) => name), ["read", "resolve", "read"]);
	assertPinnedSignal(dependencies.calls[0]!.options, signal);
	assert.deepEqual(dependencies.calls[1]!.options, {
		...TARGET,
		signal,
		author: "pi-review",
		commentId: COMMENT_ID,
	});
	assertPinnedSignal(dependencies.calls[2]!.options, signal);
	assert.match(result.content[0]!.text, new RegExp(COMMENT_ID, "u"));
	assert.match(result.content[0]!.text, /Remaining unresolved top-level comments: 1/u);
	assert.deepEqual(result.details, { commentId: COMMENT_ID, remaining: 1 });
});

test("adds an exact reply, revalidates by durable ID, resolves, then verifies", async () => {
	const live = comment();
	const reply = "  Fixed the root cause.\n";
	const dependencies = dependencyDouble([
		state([live]),
		state([{ ...live, number: 70 }]),
		state([{ ...live, number: 70, resolved: true }]),
	]);
	const harness = extensionHarness();
	const controller = registerWiffResolveTool(harness.pi, dependencies);
	await activate(harness, controller);
	const signal = new AbortController().signal;
	await registeredTool(harness).execute("call", { comment: COMMENT_ID, reply }, signal);

	assert.deepEqual(
		dependencies.calls.map(({ name }) => name),
		["read", "reply", "read", "resolve", "read"],
	);
	assert.deepEqual(dependencies.calls[1]!.options, {
		...TARGET,
		signal,
		author: "pi-review",
		commentId: COMMENT_ID,
		body: reply,
	});
	assert.deepEqual(dependencies.calls[3]!.options, {
		...TARGET,
		signal,
		author: "pi-review",
		commentId: COMMENT_ID,
	});
	for (const call of dependencies.calls) assert.equal(call.options.signal, signal);
});

test("rejects unknown, non-canonical decimal, deleted, resolved, and blank requests", async (t) => {
	for (const item of [
		{ name: "unknown", reference: "missing", value: comment(), error: /Unknown Wiff comment/u },
		{ name: "non-canonical decimal", reference: "07", value: comment(), error: /Unknown Wiff comment/u },
		{ name: "deleted", reference: "7", value: comment({ deleted: true }), error: /is deleted/u },
		{ name: "resolved", reference: COMMENT_ID, value: comment({ resolved: true }), error: /already resolved/u },
	]) {
		await t.test(item.name, async () => {
			const dependencies = dependencyDouble([state([item.value])]);
			const harness = extensionHarness();
			const controller = registerWiffResolveTool(harness.pi, dependencies);
			await activate(harness, controller);
			await assert.rejects(
				registeredTool(harness).execute("call", { comment: item.reference }),
				item.error,
			);
			assert.deepEqual(dependencies.calls.map(({ name }) => name), ["read"]);
		});
	}

	await t.test("blank reply", async () => {
		const dependencies = dependencyDouble([]);
		const harness = extensionHarness();
		const controller = registerWiffResolveTool(harness.pi, dependencies);
		await activate(harness, controller);
		await assert.rejects(
			registeredTool(harness).execute("call", { comment: "7", reply: " \n\t" }),
			/reply must not be blank/u,
		);
		assert.deepEqual(dependencies.calls, []);
	});
});

test("leaves a successful reply visible when revalidation prevents resolution", async () => {
	const live = comment();
	const dependencies = dependencyDouble([
		state([live]),
		state([{ ...live, resolved: true }]),
	]);
	const harness = extensionHarness();
	const controller = registerWiffResolveTool(harness.pi, dependencies);
	await activate(harness, controller);
	await assert.rejects(
		registeredTool(harness).execute("call", { comment: "7", reply: "Addressed." }),
		new RegExp(`Reply was added to Wiff comment ${COMMENT_ID}.*already resolved`, "u"),
	);
	assert.deepEqual(dependencies.calls.map(({ name }) => name), ["read", "reply", "read"]);
});

test("does not claim success when post-resolution state remains unresolved", async () => {
	const live = comment();
	const dependencies = dependencyDouble([state([live]), state([live])]);
	const harness = extensionHarness();
	const controller = registerWiffResolveTool(harness.pi, dependencies);
	await activate(harness, controller);
	await assert.rejects(
		registeredTool(harness).execute("call", { comment: COMMENT_ID }),
		/did not report comment .* as resolved/u,
	);
	assert.deepEqual(dependencies.calls.map(({ name }) => name), ["read", "resolve", "read"]);
});

test("a busy fix dispatch is deferred until settlement and then activates normally", async () => {
	const harness = extensionHarness();
	const controller = registerWiffResolveTool(harness.pi, dependencyDouble([]));
	controller.arm(fixTurn());

	const result = await harness.emit("input", {
		text: PROMPT,
		source: "extension",
		streamingBehavior: undefined,
	}, { isIdle: () => false });
	assert.deepEqual(result, { action: "handled" });
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), false);
	assert.deepEqual(harness.messages, []);

	await harness.emit("agent_settled", {}, { isIdle: () => true });
	assert.deepEqual(harness.messages, [PROMPT]);
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), false);
	await harness.emit("before_agent_start", { prompt: PROMPT });
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), true);
});

test("queued different prompts keep the tool through current work and clear it at their context", async () => {
	const harness = extensionHarness();
	const dependencies = dependencyDouble([]);
	const controller = registerWiffResolveTool(harness.pi, dependencies);
	await activate(harness, controller);

	await harness.emit("input", {
		text: "Queued extension follow-up",
		source: "extension",
		streamingBehavior: "followUp",
	});
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), true);
	await harness.emit("context", { messages: [] }, { hasPendingMessages: () => true });
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), true);
	await harness.emit("context", {
		messages: [{ role: "user", content: [{ type: "text", text: PROMPT }], timestamp: 1 }],
	});
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), true);
	await harness.emit("context", {
		messages: [
			{ role: "user", content: [{ type: "text", text: PROMPT }], timestamp: 1 },
			{ role: "assistant", content: [], timestamp: 2 },
			{
				role: "user",
				content: [{ type: "text", text: "Queued extension follow-up" }],
				timestamp: 3,
			},
		],
	});
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), false);
	await assert.rejects(
		registeredTool(harness).execute("call", { comment: "7" }),
		/only during the active \/review fix invocation/u,
	);
});

test("settle, session start, shutdown, and explicit clear remove only the resolver", async () => {
	const harness = extensionHarness();
	const controller = registerWiffResolveTool(harness.pi, dependencyDouble([]));
	for (const event of ["agent_settled", "session_start", "session_shutdown"] as const) {
		await activate(harness, controller);
		harness.setActiveTools(["read", WIFF_RESOLVE_TOOL, `${event}-tool`]);
		await harness.emit(event);
		assert.deepEqual(harness.activeTools, ["read", `${event}-tool`]);
	}

	controller.arm(fixTurn());
	await harness.emit("session_start");
	await harness.emit("before_agent_start", { prompt: PROMPT });
	assert.equal(harness.activeTools.includes(WIFF_RESOLVE_TOOL), false);
});

test("contains no timer-based lifecycle logic", () => {
	const source = readFileSync(new URL("./review-fix.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /setTimeout|setInterval/u);
});
