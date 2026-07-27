import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ActivityTracker,
	type Agent,
	claudeTools,
	classifyResult,
	emptyUsage,
	CLAUDE_MODEL_NAMES,
	isEffortLevel,
	modelLabel,
	type RunResult,
	selectRuntime,
} from "./runtimes.ts";

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		name: "reviewer",
		description: "reviews",
		access: "read",
		skills: "none",
		systemPrompt: "You are a reviewer.",
		...overrides,
	};
}

function result(overrides: Partial<RunResult> = {}): RunResult {
	return {
		agent: "reviewer",
		task: "review it",
		output: "",
		turns: 0,
		usage: emptyUsage(),
		durationMs: 0,
		...overrides,
	};
}

/** Records what a run's progress line would show, without the rendering. */
function tracker(): ActivityTracker & { live: () => string[] } {
	const active = new Map<string, string>();
	let unidentified: string | undefined;
	return {
		start(id, tool) {
			if (id) active.set(id, tool);
			else unidentified = tool;
		},
		end(id) {
			if (id) {
				active.delete(id);
			} else {
				active.clear();
				unidentified = undefined;
			}
		},
		live: () => [...active.values(), ...(unidentified ? [unidentified] : [])],
	};
}

function runClaude(events: Record<string, unknown>[], into = result()): { result: RunResult; live: string[] } {
	const runtime = selectRuntime("claude-opus-5");
	const activity = tracker();
	for (const event of events) runtime.consume(event, into, activity);
	return { result: into, live: activity.live() };
}

test("the model name selects the runtime", () => {
	assert.equal(selectRuntime("claude-opus-5").name, "claude");
	assert.equal(selectRuntime("claude-haiku-4-5-20251001").name, "claude");
	// No model at all is the common case: a pi child that inherits the parent's model.
	assert.equal(selectRuntime(undefined).name, "pi");
	// pi models carry a provider prefix, but a bare pattern is legal too — settings.json uses one.
	assert.equal(selectRuntime("openai-codex/gpt-5.6-luna").name, "pi");
	assert.equal(selectRuntime("gpt-5.6-luna").name, "pi");
	// Running claude *through* pi is a pi model, and the slash keeps it clear of the guard below.
	assert.equal(selectRuntime("anthropic/claude-opus-5").name, "pi");
	// Aliases are not claude models here: `opusplan` silently resolves to sonnet under -p, so the
	// whole class is excluded rather than one member special-cased.
	assert.equal(selectRuntime("opus").name, "pi");
});

test("every name offered to the model actually selects claude", () => {
	// The `delegate` schema enumerates these, so a name here that routed to pi would let the model
	// ask for claude and silently get pi.
	assert.ok(CLAUDE_MODEL_NAMES.length > 0);
	for (const name of CLAUDE_MODEL_NAMES) assert.equal(selectRuntime(name).name, "claude", name);
	// Overriding any agent onto claude must translate its tools, whatever the file asked for.
	assert.deepEqual(claudeTools(agent({ access: "write", tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] })), [
		"Bash",
		"Edit",
		"Glob",
		"Grep",
		"Read",
		"Write",
	]);
	assert.deepEqual(claudeTools(agent({ access: "read", tools: ["web_search", "fetch_content", "read"] })), [
		"Read",
		"WebFetch",
		"WebSearch",
	]);
});

test("a bare claude-* name we do not know is broken, never quietly demoted to pi", () => {
	// A typo, and the failure it prevents: a roster entry that says claude while the child reviews
	// its own family.
	assert.throws(() => selectRuntime("claude-opus5"), /unknown claude model/);
	// The same guard catches a model that ships after this build.
	assert.throws(() => selectRuntime("claude-opus-6"), /unknown claude model/);
});

test("effort levels are validated because claude ignores a bad one", () => {
	assert.ok(isEffortLevel("high"));
	assert.ok(isEffortLevel("max"));
	assert.ok(!isEffortLevel("minimal"));
	assert.ok(!isEffortLevel("HIGH"));
});

test("access: read filters the explicit tools list, not just the default", () => {
	// The allowlist is claude's only fence — acceptEdits pre-approves whatever reaches it.
	assert.deepEqual(claudeTools(agent({ access: "read", tools: ["read", "bash"] })), ["Read"]);
	// ...and the fence must not simply delete the capability: the same list on a write agent keeps it.
	assert.deepEqual(claudeTools(agent({ access: "write", tools: ["read", "bash"] })), ["Bash", "Read"]);
});

test("tool names translate, and find/ls collapse to one Glob", () => {
	assert.deepEqual(claudeTools(agent({ access: "read", tools: ["read", "grep", "find", "ls"] })), [
		"Glob",
		"Grep",
		"Read",
	]);
	assert.deepEqual(claudeTools(agent({ access: "read", tools: ["web_search", "fetch_content"] })), [
		"WebFetch",
		"WebSearch",
	]);
	// A read agent naming no tools gets the same default pi gives it.
	assert.deepEqual(claudeTools(agent({ access: "read" })), ["Glob", "Grep", "Read"]);
});

test("skills: all grants Skill, skills: none is its absence", () => {
	assert.ok(claudeTools(agent({ skills: "all", tools: ["read"] })).includes("Skill"));
	assert.ok(!claudeTools(agent({ skills: "none", tools: ["read"] })).includes("Skill"));
});

test("a tool with no claude equivalent is a load error, not a silent drop", () => {
	assert.throws(() => claudeTools(agent({ tools: ["read", "telepathy"] })), /no claude equivalent/);
	// `delegate` is dropped rather than translated: no child may delegate further.
	assert.deepEqual(claudeTools(agent({ access: "write", tools: ["read", "delegate"] })), ["Read"]);
});

test("claude argv fences the child and carries one system prompt", () => {
	const reviewer = agent({ model: "claude-opus-5", effort: "high", tools: ["read", "grep"] });
	const { command, args, input } = selectRuntime(reviewer.model).invoke(reviewer, "review it", {
		appendSystemPrompt: "inherited discipline",
		model: "openai-codex/gpt-5.6-luna",
	});

	assert.equal(command, "claude");
	// Repeating the flag silently drops all but the last, so both prompts travel as one argument.
	const systemFlags = args.filter((arg) => arg === "--append-system-prompt");
	assert.equal(systemFlags.length, 1);
	const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
	assert.match(systemPrompt, /inherited discipline/);
	assert.match(systemPrompt, /You are a reviewer\./);

	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "claude-opus-5"]);
	assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
	// The parent's model never crosses the runtime boundary.
	assert.ok(!args.includes("openai-codex/gpt-5.6-luna"));

	// Availability and permission are separate grants; a write agent needs both or its Write is
	// denied mid-run while the run still reports success.
	assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
	assert.equal(args[args.indexOf("--allowed-tools") + 1], "Grep,Read");
	assert.equal(args[args.indexOf("--tools") + 1], "Grep,Read");
	assert.ok(args.includes("--strict-mcp-config"));
	// stream-json refuses to run without it.
	assert.ok(args.includes("--verbose"));
	assert.ok(args.includes("--no-session-persistence"));

	// The task goes on stdin: --tools and --allowed-tools are variadic and swallow a positional.
	assert.equal(input, "Task: review it");
	assert.ok(!args.includes("Task: review it"));
});

test("a pi agent still inherits the session model", () => {
	const scout = agent({ access: "read", tools: ["read"] });
	const { args, input } = selectRuntime(scout.model).invoke(scout, "look", { model: "openai-codex/gpt-5.6-luna" });
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.6-luna");
	// pi takes its prompt as an argument and is given no stdin at all.
	assert.equal(input, undefined);
	assert.ok(args.includes("Task: look"));
});

test("pi accumulates usage per message, where claude assigns a run total once", () => {
	// The asymmetry a refactor gets wrong: pi reports each turn, claude reports the run.
	const runtime = selectRuntime(undefined);
	const run = result();
	const activity = tracker();
	const turn = (input: number, cost: number) => ({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
			usage: {
				input,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
		},
	});

	runtime.consume({ type: "tool_execution_start", toolName: "read", toolCallId: "1" }, run, activity);
	assert.deepEqual(activity.live(), ["read"]);
	runtime.consume({ type: "tool_execution_end", toolCallId: "1" }, run, activity);
	assert.deepEqual(activity.live(), []);

	runtime.consume(turn(10, 0.01), run, activity);
	runtime.consume(turn(30, 0.02), run, activity);
	assert.equal(run.turns, 2);
	assert.equal(run.usage.input, 40);
	assert.equal(run.usage.output, 10);
	assert.ok(Math.abs(run.usage.cost.total - 0.03) < 1e-9);
	assert.equal(run.output, "done");
	// pi reports a provider, so the header shows the qualified name; claude leaves it unset.
	assert.equal(modelLabel(run), "openai-codex/gpt-5.6-luna");
	assert.equal(classifyResult(run).kind, "success");
});

test("a pi tool event with no id still clears the line, because pi omits ids", () => {
	const runtime = selectRuntime(undefined);
	const run = result();
	const activity = tracker();
	runtime.consume({ type: "tool_execution_start", toolName: "bash" }, run, activity);
	assert.deepEqual(activity.live(), ["bash"]);
	runtime.consume({ type: "tool_execution_end" }, run, activity);
	assert.deepEqual(activity.live(), []);
});

test("run usage comes from modelUsage, which is the only cumulative figure", () => {
	const { result: run } = runClaude([
		{ type: "system", subtype: "init", model: "claude-opus-5" },
		{
			type: "result",
			subtype: "success",
			is_error: false,
			stop_reason: "end_turn",
			num_turns: 5,
			result: "the report",
			total_cost_usd: 0.63,
			// The envelope's own `usage` is the final turn only — 26 against a true 565.
			usage: { input_tokens: 26, output_tokens: 4 },
			modelUsage: {
				"claude-opus-5": {
					inputTokens: 565,
					outputTokens: 1200,
					cacheReadInputTokens: 16046,
					cacheCreationInputTokens: 14887,
				},
			},
		},
	]);

	assert.equal(run.stopReason, "stop");
	assert.equal(run.output, "the report");
	assert.equal(run.turns, 5);
	assert.equal(run.model, "claude-opus-5");
	assert.equal(run.usage.input, 565);
	assert.equal(run.usage.output, 1200);
	assert.equal(run.usage.cacheRead, 16046);
	assert.equal(run.usage.cacheWrite, 14887);
	assert.equal(run.usage.totalTokens, 565 + 1200 + 16046 + 14887);
	assert.equal(run.usage.cost.total, 0.63);
	// No provider, so the header renders exactly the name written in the agent file.
	assert.equal(run.provider, undefined);
	assert.equal(classifyResult(run).kind, "success");
});

test("hitting the output limit is not an error, and must not be read as success", () => {
	// The regression this ordering exists for: no error signal anywhere in the envelope, so testing
	// success first would report cut-off text as a finished answer.
	const { result: run } = runClaude([
		{
			type: "result",
			subtype: "success",
			is_error: false,
			stop_reason: "max_tokens",
			num_turns: 2,
			result: "half a rep",
			permission_denials: [],
		},
	]);
	assert.equal(run.stopReason, "length");
	assert.equal(classifyResult(run).kind, "length");
});

test("a denied tool is a failure even though claude reports success", () => {
	const { result: run } = runClaude([
		{
			type: "result",
			subtype: "success",
			is_error: false,
			stop_reason: "end_turn",
			num_turns: 2,
			result: "I have written the file.",
			permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_1" }],
		},
	]);
	assert.equal(run.stopReason, "error");
	assert.match(run.errorMessage ?? "", /denied Write/);
	// The child's own claim to have written the file is kept, as evidence of nothing.
	assert.match(run.errorMessage ?? "", /I have written the file\./);
	assert.equal(classifyResult(run).kind, "model-error");
});

test("a run that was truncated and denied is still reported as denied", () => {
	const { result: run } = runClaude([
		{
			type: "result",
			subtype: "success",
			is_error: false,
			stop_reason: "max_tokens",
			result: "…",
			permission_denials: [{ tool_name: "Edit" }],
		},
	]);
	assert.equal(run.stopReason, "error");
});

test("an unknown model fails in-band, with exit code 0 and empty stderr", () => {
	const { result: run } = runClaude([
		{
			type: "result",
			subtype: "success",
			is_error: true,
			api_error_status: 404,
			terminal_reason: "error",
			result: "",
			permission_denials: [],
		},
	]);
	assert.equal(run.stopReason, "error");
	assert.match(run.errorMessage ?? "", /api status 404/);
	assert.equal(classifyResult(run).kind, "model-error");
});

test("tool activity tracks by id, and an unidentified result ends nothing", () => {
	const runtime = selectRuntime("claude-opus-5");
	const run = result();
	const activity = tracker();
	const message = (role: string, content: unknown[]) => ({ type: role, message: { role, content } });

	runtime.consume(message("assistant", [{ type: "tool_use", id: "a", name: "Read" }]), run, activity);
	runtime.consume(message("assistant", [{ type: "tool_use", id: "b", name: "Grep" }]), run, activity);
	assert.deepEqual(activity.live(), ["Read", "Grep"]);

	// A block with no id must not clear the pair: that would drop a running sibling off the line.
	runtime.consume(message("user", [{ type: "tool_result" }]), run, activity);
	assert.deepEqual(activity.live(), ["Read", "Grep"]);

	runtime.consume(message("user", [{ type: "tool_result", tool_use_id: "a" }]), run, activity);
	assert.deepEqual(activity.live(), ["Grep"]);
});

test("bookkeeping events do not ask for a redraw", () => {
	const runtime = selectRuntime("claude-opus-5");
	const run = result();
	const activity = tracker();
	const consume = (event: Record<string, unknown>) => runtime.consume(event, run, activity);

	// claude emits this every few hundred milliseconds for the whole run.
	assert.equal(consume({ type: "system", subtype: "thinking_tokens", estimated_tokens: 40 }), false);
	assert.equal(consume({ type: "rate_limit_event" }), false);
	assert.equal(consume({ type: "assistant" }), false);

	assert.equal(consume({ type: "system", subtype: "init", model: "claude-opus-5" }), true);
	assert.equal(consume({ type: "assistant", message: { role: "assistant", content: [] } }), true);
	assert.equal(consume({ type: "result", subtype: "success", result: "done" }), true);
});

test("assistant text is kept only as a diagnostic; the report comes from the result envelope", () => {
	const { result: run } = runClaude([
		{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] } },
	]);
	assert.equal(run.diagnosticOutput, "thinking out loud");
	assert.equal(run.output, "");
	// No result envelope arrived, so the run has no usable text — a truncated child, not a success.
	assert.equal(classifyResult(run).kind, "invalid-response");
});
