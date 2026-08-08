import assert from "node:assert/strict";
import test from "node:test";
import autosearch from "./index.ts";

const START = "Autosearch objective:\n\nobjective";
const CONTINUE = "Continue autosearch with one bounded pass toward this objective:\n\nobjective";

interface HarnessOptions {
	excludeFinishTool?: boolean;
	idle?: boolean;
	mode?: "tui" | "rpc" | "print";
}

function harness(options: HarnessOptions = {}) {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const tools = new Map<string, any>();
	const messages: string[] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const statuses: Array<string | undefined> = [];
	let activeTools = ["read", "bash"];
	let branch: any[] = [];

	const pi = {
		on(name: string, handler: (event: any, ctx: any) => any) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
			if (!options.excludeFinishTool) activeTools.push(tool.name);
		},
		getActiveTools() {
			return [...activeTools];
		},
		getAllTools() {
			return [...tools.values()]
				.filter((tool) => !options.excludeFinishTool || tool.name !== "finish_autosearch");
		},
		setActiveTools(names: string[]) {
			activeTools = names.filter((name) => !options.excludeFinishTool || name !== "finish_autosearch");
		},
		sendUserMessage(message: string) {
			messages.push(message);
		},
	};

	const ctx = {
		isIdle: () => options.idle ?? true,
		mode: options.mode ?? "tui",
		sessionManager: { getBranch: () => branch },
		ui: {
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
			setStatus(_key: string, status: string | undefined) {
				statuses.push(status);
			},
		},
	};

	autosearch(pi as any);
	handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

	return {
		activeTools: () => activeTools,
		command: (args: string) => commands.get("autosearch")!.handler(args, ctx),
		ctx,
		emit: async (name: string, event: any = { type: name }) => handlers.get(name)?.(event, ctx),
		messages,
		notifications,
		setToolCalls(...ids: string[]) {
			branch = [{
				type: "message",
				message: {
					role: "assistant",
					content: ids.map((id) => ({ type: "toolCall", id })),
				},
			}];
		},
		statuses,
		tool: () => tools.get("finish_autosearch"),
	};
}

function assistant(stopReason: string, errorMessage?: string) {
	return { role: "assistant", stopReason, errorMessage };
}

async function start(search: ReturnType<typeof harness>, objective = "objective") {
	await search.command(objective);
	const prompt = `Autosearch objective:\n\n${objective}`;
	assert.equal(search.messages.at(-1), prompt);
	return search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt,
		systemPrompt: "base prompt",
	});
}

async function runChild(search: ReturnType<typeof harness>, isError = false) {
	await search.emit("tool_execution_start", {
		type: "tool_execution_start",
		toolName: "delegate",
	});
	assert.equal(await search.emit("tool_call", {
		type: "tool_call",
		toolCallId: "child",
		toolName: "delegate",
		input: { agent: "scout", task: "bounded task" },
	}), undefined);
	await search.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "child",
		toolName: "delegate",
		result: {},
		isError,
	});
}

test("registers /autosearch and injects its objective", async () => {
	const search = harness();
	await search.command("  reduce validation loss below 1.0  ");

	const prompt = "Autosearch objective:\n\nreduce validation loss below 1.0";
	assert.deepEqual(search.messages, [prompt]);
	assert.ok(!search.activeTools().includes("finish_autosearch"));
	const result = await search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt,
		systemPrompt: "base prompt",
	});
	assert.match(result.systemPrompt, /^base prompt/);
	assert.match(result.systemPrompt, /reduce validation loss below 1\.0/);
	assert.match(result.systemPrompt, /finish_autosearch/);
	assert.match(result.systemPrompt, /parent overseer/);
	assert.match(result.systemPrompt, /call delegate exactly once with a fresh agent/);
	assert.match(result.systemPrompt, /Do not edit, write, or otherwise mutate/);
	assert.match(result.systemPrompt, /fresh non-mutating verification child/);
	assert.match(result.systemPrompt, /unresolved until authoritative evidence clears it/);
	assert.ok(search.activeTools().includes("finish_autosearch"));
	assert.equal(search.statuses.at(-1), "autosearch · pass 1");
	await assert.rejects(search.command("another objective"), /already active/);
});

test("keeps low-level retries within the current dispatched pass", async () => {
	const search = harness();
	await start(search);

	await search.emit("turn_start", { type: "turn_start", turnIndex: 0 });
	await search.emit("agent_end", {
		type: "agent_end",
		messages: [assistant("length")],
	});
	await search.emit("turn_start", { type: "turn_start", turnIndex: 0 });
	assert.equal(search.statuses.at(-1), "autosearch · pass 1 · turn 1");
	assert.deepEqual(search.messages, [START]);
	await runChild(search);

	await search.emit("agent_end", {
		type: "agent_end",
		messages: [assistant("stop")],
	});
	assert.deepEqual(search.messages, [START]);
	await search.emit("agent_settled");
	await search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: CONTINUE,
		systemPrompt: "base prompt",
	});
	assert.equal(search.statuses.at(-1), "autosearch · pass 2");
});

test("continues only after a successful settled run", async () => {
	const search = harness();
	await start(search);
	await runChild(search);
	await search.emit("agent_end", {
		type: "agent_end",
		messages: [
			assistant("error", "stale error"),
			{ role: "user" },
			assistant("stop"),
			{ role: "toolResult" },
		],
	});
	await search.emit("agent_settled");

	assert.deepEqual(search.messages, [START, CONTINUE]);
	assert.ok(!search.activeTools().includes("finish_autosearch"));
	assert.equal(search.statuses.at(-1), undefined);

	const continuation = await search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: CONTINUE,
		systemPrompt: "base prompt",
	});
	assert.match(continuation.systemPrompt, /Objective:\nobjective/);
	assert.ok(search.activeTools().includes("finish_autosearch"));
	assert.equal(search.statuses.at(-1), "autosearch · pass 2");
});

test("stops on every non-successful terminal result", async () => {
	const cases = [
		{ stopReason: "error", errorMessage: "provider failed", message: /provider failed/, type: "error" },
		{ stopReason: "length", message: /Agent stopped with reason: length/, type: "error" },
		{ stopReason: "aborted", message: /Agent stopped with reason: aborted/, type: "warning" },
	];

	for (const terminal of cases) {
		const search = harness();
		await start(search);
		await search.emit("agent_end", {
			type: "agent_end",
			messages: [assistant(terminal.stopReason, terminal.errorMessage)],
		});
		await search.emit("agent_settled");

		assert.deepEqual(search.messages, [START]);
		assert.ok(!search.activeTools().includes("finish_autosearch"));
		assert.equal(search.statuses.at(-1), undefined);
		assert.equal(search.notifications.at(-1)?.type, terminal.type);
		assert.match(search.notifications.at(-1)!.message, terminal.message);
	}
});

test("stops when a settled run has no assistant result", async () => {
	const search = harness();
	await start(search);
	await search.emit("agent_end", { type: "agent_end", messages: [] });
	await search.emit("agent_settled");

	assert.match(search.notifications.at(-1)!.message, /without an assistant result/);
	assert.ok(!search.activeTools().includes("finish_autosearch"));
});

test("a stale stop reason does not survive into the next settled run", async () => {
	const search = harness();
	await start(search);
	await runChild(search);
	await search.emit("agent_end", {
		type: "agent_end",
		messages: [assistant("stop")],
	});
	await search.emit("agent_settled");
	assert.deepEqual(search.messages, [START, CONTINUE]);

	await search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: CONTINUE,
		systemPrompt: "base prompt",
	});
	// The run dies without emitting agent_end; the previous "stop" must not trigger a continuation.
	await search.emit("agent_settled");

	assert.deepEqual(search.messages, [START, CONTINUE]);
	assert.match(search.notifications.at(-1)!.message, /without an assistant result/);
	assert.ok(!search.activeTools().includes("finish_autosearch"));
});

test("finish_autosearch reports done or blocked and terminates", async () => {
	for (const outcome of ["done", "blocked"] as const) {
		const search = harness();
		await start(search);
		await runChild(search);
		search.setToolCalls("call");
		const result = await search.tool().execute(
			"call",
			{ outcome, evidence: "  exact evidence  " },
			undefined,
			undefined,
			search.ctx,
		);

		assert.equal(result.terminate, true);
		assert.match(result.content[0].text, new RegExp(`Autosearch ${outcome === "done" ? "complete" : "blocked"}`));
		assert.match(result.content[0].text, /Objective: objective/);
		assert.match(result.content[0].text, /Evidence: exact evidence/);
		assert.match(result.content[0].text, /Stats:/);
		assert.ok(!search.activeTools().includes("finish_autosearch"));
		assert.equal(search.statuses.at(-1), undefined);

		await search.emit("agent_end", {
			type: "agent_end",
			messages: [assistant("toolUse")],
		});
		await search.emit("agent_settled");
		assert.deepEqual(search.messages, [START]);
	}
});

test("completion summary reports search activity and usage", async () => {
	const search = harness();
	await start(search);
	await runChild(search);
	await search.emit("turn_start", { type: "turn_start", turnIndex: 0 });
	await search.emit("turn_start", { type: "turn_start", turnIndex: 1 });
	await search.emit("tool_execution_start", { type: "tool_execution_start", toolName: "bash" });
	await search.emit("tool_execution_start", { type: "tool_execution_start", toolName: "read" });
	await search.emit("tool_execution_start", { type: "tool_execution_start", toolName: "finish_autosearch" });
	await search.emit("message_end", {
		type: "message_end",
		message: {
			role: "assistant",
			usage: { input: 1_200, output: 345, cost: { total: 0.1234 } },
		},
	});
	await search.emit("message_end", {
		type: "message_end",
		message: {
			role: "toolResult",
			usage: { input: 300, output: 50, cost: { total: 0.02 } },
		},
	});
	await search.emit("session_compact", {
		type: "session_compact",
		compactionEntry: {
			usage: { input: 100, output: 25, cost: { total: 0.01 } },
		},
	});
	search.setToolCalls("call");

	const result = await search.tool().execute(
		"call",
		{ outcome: "done", evidence: "verified" },
		undefined,
		undefined,
		search.ctx,
	);

	assert.match(
		result.content[0].text,
		/Stats: parent 1 pass · 2 turns · 3 work tools · .* · usage incl\. nested 1\.6k in \/ 420 out · \$0\.153$/,
	);
});

test("starts a fresh search after completion", async () => {
	const search = harness();
	await start(search);
	await runChild(search);
	search.setToolCalls("call");
	await search.tool().execute(
		"call",
		{ outcome: "done", evidence: "evidence" },
		undefined,
		undefined,
		search.ctx,
	);
	await search.emit("agent_end", {
		type: "agent_end",
		messages: [assistant("toolUse")],
	});
	await search.emit("agent_settled");

	const result = await start(search, "next objective");
	assert.match(result.systemPrompt, /Objective:\nnext objective/);
	assert.ok(search.activeTools().includes("finish_autosearch"));
});

test("finish_autosearch rejects sibling tool calls", async () => {
	const search = harness();
	await start(search);
	await runChild(search);
	search.setToolCalls("call", "sibling");

	await assert.rejects(search.tool().execute(
		"call",
		{ outcome: "done", evidence: "evidence" },
		undefined,
		undefined,
		search.ctx,
	), /must be called alone/);
	assert.ok(search.activeTools().includes("finish_autosearch"));
	assert.equal(search.statuses.at(-1), "autosearch · pass 1");
});

test("finish_autosearch requires one child in the current pass", async () => {
	const search = harness();
	await start(search);
	search.setToolCalls("call");

	await assert.rejects(search.tool().execute(
		"call",
		{ outcome: "done", evidence: "evidence" },
		undefined,
		undefined,
		search.ctx,
	), /requires exactly one fresh child/);
});

test("finish_autosearch rejects an untracked tool call", async () => {
	const search = harness();
	await start(search);
	await runChild(search);

	await assert.rejects(search.tool().execute(
		"missing",
		{ outcome: "done", evidence: "evidence" },
		undefined,
		undefined,
		search.ctx,
	), /Could not find finish_autosearch call missing/);
	assert.ok(search.activeTools().includes("finish_autosearch"));
});

test("enforces one fresh child per pass", async () => {
	const resumed = harness();
	await start(resumed);
	assert.deepEqual(await resumed.emit("tool_call", {
		type: "tool_call",
		toolCallId: "resumed",
		toolName: "delegate",
		input: { runId: "prior", task: "continue" },
	}), {
		block: true,
		reason: "Autosearch child passes must start fresh",
		terminate: true,
	});
	assert.deepEqual(await resumed.emit("tool_call", {
		type: "tool_call",
		toolCallId: "retry",
		toolName: "delegate",
		input: { agent: "scout", task: "retry fresh" },
	}), {
		block: true,
		reason: "Autosearch child passes must start fresh",
		terminate: true,
	});

	const repeated = harness();
	await start(repeated);
	await runChild(repeated);
	assert.deepEqual(await repeated.emit("tool_call", {
		type: "tool_call",
		toolCallId: "second",
		toolName: "delegate",
		input: { agent: "reviewer", task: "second child" },
	}), {
		block: true,
		reason: "Autosearch permits exactly one child per pass",
		terminate: true,
	});
});

test("propagates child execution failure without continuation", async () => {
	const search = harness();
	await start(search);
	await runChild(search, true);
	await search.emit("agent_end", {
		type: "agent_end",
		messages: [assistant("stop")],
	});
	await search.emit("agent_settled");

	assert.deepEqual(search.messages, [START]);
	assert.match(search.notifications.at(-1)!.message, /child execution failed/);
	assert.ok(!search.activeTools().includes("finish_autosearch"));
});

test("refuses tool filters that exclude finish_autosearch", async () => {
	const search = harness({ excludeFinishTool: true });
	await assert.rejects(search.command("objective"), /excluded by the active tool filters/);
	assert.ok(!search.activeTools().includes("finish_autosearch"));
	assert.deepEqual(search.messages, []);
});

test("only the dispatched prompt can consume a pending objective", async () => {
	const search = harness();
	await search.command("objective");

	assert.equal(await search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: "unrelated prompt",
		systemPrompt: "base prompt",
	}), undefined);
	assert.ok(!search.activeTools().includes("finish_autosearch"));

	const result = await search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: START,
		systemPrompt: "base prompt",
	});
	assert.match(result.systemPrompt, /Objective:\nobjective/);
	assert.ok(search.activeTools().includes("finish_autosearch"));
	assert.equal(await search.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: START,
		systemPrompt: "base prompt",
	}), undefined);
});

test("rejects missing objectives, busy sessions, and non-TUI use", async () => {
	await assert.rejects(harness().command("  "), /Usage/);
	await assert.rejects(harness({ idle: false }).command("objective"), /agent is busy/);
	await assert.rejects(harness({ mode: "print" }).command("objective"), /interactive TUI/);
	await assert.rejects(harness({ mode: "rpc" }).command("objective"), /interactive TUI/);
});

test("session shutdown ends the search", async () => {
	const search = harness();
	await start(search);
	await search.emit("session_shutdown");

	assert.ok(!search.activeTools().includes("finish_autosearch"));
	assert.equal(search.statuses.at(-1), undefined);
});
