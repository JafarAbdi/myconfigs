import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type ActivityTracker,
	type Agent,
	agentFromFrontmatter,
	childEnvironment,
	claudeTools,
	classifyResult,
	delegateModelNames,
	emptyUsage,
	CLAUDE_MODEL_NAMES,
	modelLabel,
	type RunResult,
	createActivityTracker,
	selectRuntime,
	stepDetail,
} from "./runtimes.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		name: "reviewer",
		description: "reviews",
		tools: ["read"],
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
		steps: [],
		turns: 0,
		usage: emptyUsage(),
		durationMs: 0,
		...overrides,
	};
}

function runClaude(events: Record<string, unknown>[], into = result()): { result: RunResult } {
	const runtime = selectRuntime("claude-opus-5");
	const activity = createActivityTracker(into);
	for (const event of events) runtime.consume(event, into, activity);
	return { result: into };
}

/** The step log as `expanded` prints it, glyph and all. */
function steps(result: RunResult): string[] {
	return result.steps.map(
		(step) =>
			`${!step.outcome ? "⋯" : step.outcome === "failed" ? "✗" : "✓"} ${step.tool}${step.detail ? ` ${step.detail}` : ""}`,
	);
}

test("agent frontmatter reads only role and capability fields", () => {
	assert.deepEqual(
		agentFromFrontmatter(
			"reviewer",
			{
				description: "reviews",
				tools: "read, grep",
				skills: "none",
				model: "claude-opus-5",
				effort: "high",
				unknown: true,
			},
			"Review it.",
		),
		{
			name: "reviewer",
			description: "reviews",
			tools: ["read", "grep"],
			skills: "none",
			systemPrompt: "Review it.",
		},
	);
});

test("audit is the extension's one review policy and slash discovery is gone", () => {
	const agents = join(EXTENSION_DIR, "agents");
	const policy = readFileSync(join(agents, "audit.md"), "utf-8");
	assert.equal(existsSync(join(agents, "correctness-reviewer.md")), false);
	assert.equal(existsSync(join(agents, "context-style-reviewer.md")), false);
	assert.equal(existsSync(join(EXTENSION_DIR, "prompts", "audit.md")), false);
	assert.match(policy, /requirements, behavior/);
	assert.match(policy, /project context/);
	assert.match(policy, /deletion-first simplicity/);
	assert.ok(
		policy.includes(
			'PI_OFFLINE=1 pi --mode json --no-session -p "/context-files" \\\n' +
				"  | jq -r 'select(.type==\"message_end\" and .message.customType==\"context-files\") | .message.content'",
		),
	);
	const extension = readFileSync(join(EXTENSION_DIR, "index.ts"), "utf-8");
	assert.doesNotMatch(extension, /promptPaths/);
});

test("delegate model choices add native claude only outside SSH", () => {
	const piModels = ["openai-codex/gpt-5.6-luna", "llama.cpp/qwen36"];
	assert.deepEqual(delegateModelNames(piModels, false), piModels);
	assert.deepEqual(delegateModelNames(piModels, true), [...piModels, ...CLAUDE_MODEL_NAMES]);
});

test("child environments apply only their runtime-specific defaults", () => {
	const parent = { PI_SSH_DESCRIPTOR: "{}" };
	assert.deepEqual(childEnvironment("pi", parent), {
		...parent,
		PI_DELEGATE_CHILD: "1",
	});
	assert.deepEqual(childEnvironment("claude", parent), {
		...parent,
		CLAUDE_CODE_MAX_RETRIES: "3",
	});
	const configured = { CLAUDE_CODE_MAX_RETRIES: "7" };
	assert.equal(childEnvironment("claude", configured), configured);
	const local = {};
	assert.equal(childEnvironment("pi", local), local);
});

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
	assert.deepEqual(claudeTools(agent({ tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] })), [
		"Bash",
		"Edit",
		"Glob",
		"Grep",
		"Read",
		"Write",
	]);
	assert.deepEqual(claudeTools(agent({ tools: ["web_search", "fetch_content", "read"] })), [
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

test("the tools line is the capability, passed through unedited", () => {
	// A file that asks for a shell gets one; nothing here may quietly hand the child less than the
	// file describes.
	assert.deepEqual(claudeTools(agent({ tools: ["read", "bash"] })), ["Bash", "Read"]);
	assert.deepEqual(claudeTools(agent({ tools: ["read"] })), ["Read"]);
});

test("tool names translate, and find/ls collapse to one Glob", () => {
	assert.deepEqual(claudeTools(agent({ tools: ["read", "grep", "find", "ls"] })), ["Glob", "Grep", "Read"]);
	assert.deepEqual(claudeTools(agent({ tools: ["web_search", "fetch_content"] })), ["WebFetch", "WebSearch"]);
});

test("a file that grants nothing gets nothing, not pi's default four", () => {
	// Without an explicit flag the child falls back to read, bash, edit and write — the opposite of
	// what an empty list asks for.
	const { args } = selectRuntime(undefined).invoke(agent({ tools: ["delegate"] }), "look", {});
	assert.ok(args.includes("--no-tools"));
	assert.ok(!args.includes("--tools"));
	assert.deepEqual(claudeTools(agent({ tools: ["delegate"] })), []);
});

test("skills: all grants Skill, skills: none is its absence", () => {
	assert.ok(claudeTools(agent({ skills: "all", tools: ["read"] })).includes("Skill"));
	assert.ok(!claudeTools(agent({ skills: "none", tools: ["read"] })).includes("Skill"));
});

test("a tool with no claude equivalent is a load error, not a silent drop", () => {
	assert.throws(() => claudeTools(agent({ tools: ["read", "telepathy"] })), /no claude equivalent/);
	// `delegate` is dropped rather than translated: no child may delegate further.
	assert.deepEqual(claudeTools(agent({ tools: ["read", "delegate"] })), ["Read"]);
});

test("claude argv fences the child and carries one system prompt", () => {
	const reviewer = agent({ tools: ["read", "grep"] });
	const model = "claude-opus-5";
	const { command, args, input } = selectRuntime(model).invoke(
		reviewer,
		"review it",
		{
			appendSystemPrompt: "inherited discipline",
			model: "openai-codex/gpt-5.6-luna",
		},
		model,
	);

	assert.equal(command, "claude");
	// Repeating the flag silently drops all but the last, so both prompts travel as one argument.
	const systemFlags = args.filter((arg) => arg === "--append-system-prompt");
	assert.equal(systemFlags.length, 1);
	const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
	assert.match(systemPrompt, /inherited discipline/);
	assert.match(systemPrompt, /You are a reviewer\./);

	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "claude-opus-5"]);
	assert.ok(!args.includes("--effort"));
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

test("a provider-qualified delegate model launches pi", () => {
	const reviewer = agent({ tools: ["read", "bash"] });
	const model = "openai-codex/gpt-5.6-luna";
	const runtime = selectRuntime(model);
	assert.equal(runtime.name, "pi");
	const { args } = runtime.invoke(reviewer, "review", {}, model);
	assert.equal(args[args.indexOf("--model") + 1], model);
	assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
});

test("an omitted delegate model launches pi and inherits the session model", () => {
	const scout = agent({ tools: ["read"] });
	const { args, input } = selectRuntime(undefined).invoke(scout, "look", { model: "openai-codex/gpt-5.6-luna" });
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.6-luna");
	// pi takes its prompt as an argument and is given no stdin at all.
	assert.equal(input, undefined);
	assert.ok(args.includes("Task: look"));
});

test("pi accumulates usage per message, where claude assigns a run total once", () => {
	// The asymmetry a refactor gets wrong: pi reports each turn, claude reports the run.
	const runtime = selectRuntime(undefined);
	const run = result();
	const activity = createActivityTracker(run);
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

	runtime.consume({ type: "tool_execution_start", toolName: "read", toolCallId: "1", args: { path: "a.ts" } }, run, activity);
	assert.equal(run.activity, "read(a.ts)");
	runtime.consume({ type: "tool_execution_end", toolCallId: "1" }, run, activity);
	assert.equal(run.activity, undefined);
	assert.deepEqual(steps(run), ["✓ read a.ts"]);

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
	const activity = createActivityTracker(run);
	runtime.consume({ type: "tool_execution_start", toolName: "bash" }, run, activity);
	assert.equal(run.activity, "bash");
	runtime.consume({ type: "tool_execution_end" }, run, activity);
	assert.equal(run.activity, undefined);
	assert.deepEqual(steps(run), ["✓ bash"]);
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

test("a tool call carries the argument that identifies it", () => {
	// `Bash` alone tells you an agent is busy; the command tells you what it is doing.
	assert.equal(stepDetail({ command: "git show --stat HEAD", description: "inspect" }), "git show --stat HEAD");
	assert.equal(stepDetail({ file_path: "/home/juruc/myconfigs/pi/index.ts" }), "/home/juruc/myconfigs/pi/index.ts");
	assert.equal(stepDetail({ pattern: "selectRuntime" }), "selectRuntime");
	// pi and claude name these fields identically, so one rule serves both lanes.
	assert.equal(stepDetail({ path: "runtimes.ts" }), "runtimes.ts");
	// grep and find take both, and the pattern is the question — the path is usually just the cwd.
	assert.equal(stepDetail({ pattern: "selectRuntime", path: "." }), "selectRuntime");
	assert.equal(stepDetail({ pattern: "**/*.ts", path: "packages", glob: "*.ts" }), "**/*.ts");
	// Nothing recognisable beats a blob of JSON on the progress line.
	assert.equal(stepDetail({ mystery: 3 }), undefined);
	assert.equal(stepDetail(undefined), undefined);
	// Newlines are flattened, because a step is one line by construction.
	assert.equal(stepDetail({ command: "git log\n  --oneline" }), "git log --oneline");
	// Not cut to fit a terminal — that is the renderer's job, against a width it can see. Only a
	// pathological argument is capped, and only so it cannot sit in the parent's memory.
	assert.equal(stepDetail({ command: `echo ${"x".repeat(200)}` })?.length, 205);
	assert.equal(stepDetail({ command: "x".repeat(5000) })?.length, 2000);
});

test("both lanes report the same call the same way", () => {
	const seen: string[] = [];
	const activity: ActivityTracker = {
		start: (_id, tool, detail) => seen.push(`start ${tool} ${detail}`),
		end: (_id, failed) => seen.push(`end ${failed}`),
	};
	selectRuntime("claude-opus-5").consume(
		{
			type: "assistant",
			message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls -la" } }] },
		},
		result(),
		activity,
	);
	selectRuntime(undefined).consume(
		{ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls -la" } },
		result(),
		activity,
	);
	assert.deepEqual(seen, ["start Bash ls -la", "start bash ls -la"]);

	selectRuntime("claude-opus-5").consume(
		{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true }] } },
		result(),
		activity,
	);
	selectRuntime(undefined).consume({ type: "tool_execution_end", toolCallId: "a", isError: true }, result(), activity);
	assert.deepEqual(seen.slice(-2), ["end true", "end true"]);
});

test("tool activity tracks by id, and an unidentified result ends nothing", () => {
	const runtime = selectRuntime("claude-opus-5");
	const run = result();
	const activity = createActivityTracker(run);
	const message = (role: string, content: unknown[]) => ({ type: role, message: { role, content } });

	runtime.consume(message("assistant", [{ type: "tool_use", id: "a", name: "Read" }]), run, activity);
	runtime.consume(message("assistant", [{ type: "tool_use", id: "b", name: "Grep" }]), run, activity);
	assert.equal(run.activity, "Read, Grep");

	// A block with no id must not clear the pair: that would drop a running sibling off the line.
	runtime.consume(message("user", [{ type: "tool_result" }]), run, activity);
	assert.equal(run.activity, "Read, Grep");

	runtime.consume(message("user", [{ type: "tool_result", tool_use_id: "a" }]), run, activity);
	assert.equal(run.activity, "Grep");
	// The finished one is marked; the one still running keeps its ⋯ even after the run ends.
	assert.deepEqual(steps(run), ["✓ Read", "⋯ Grep"]);
});

test("a think before any tool still shows on the line", () => {
	// During a long initial think no tool has started, so this is the only visible activity.
	const { result: run } = runClaude([{ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }]);
	assert.equal(run.activity, "thinking 50");

	// A running tool outranks it, and the count returns when the tool finishes.
	const message = (role: string, content: unknown[]) => ({ type: role, message: { role, content } });
	const runtime = selectRuntime("claude-opus-5");
	const activity = createActivityTracker(run);
	runtime.consume(message("assistant", [{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }]), run, activity);
	assert.equal(run.activity, "Bash(ls)");
	runtime.consume(message("user", [{ type: "tool_result", tool_use_id: "a" }]), run, activity);
	assert.equal(run.activity, "thinking 50");
});

test("bookkeeping events do not ask for a redraw", () => {
	const runtime = selectRuntime("claude-opus-5");
	const run = result();
	const activity = createActivityTracker(run);
	const consume = (event: Record<string, unknown>) => runtime.consume(event, run, activity);

	assert.equal(consume({ type: "rate_limit_event" }), false);
	assert.equal(consume({ type: "assistant" }), false);
	// Thinking tokens are the exception: during a long think they are the only thing moving.
	assert.equal(consume({ type: "system", subtype: "thinking_tokens", estimated_tokens: 40 }), true);
	assert.equal(run.thinking, 40);

	assert.equal(consume({ type: "system", subtype: "init", model: "claude-opus-5" }), true);
	assert.equal(consume({ type: "assistant", message: { role: "assistant", content: [] } }), true);
	assert.equal(consume({ type: "result", subtype: "success", result: "done" }), true);
});

test("a child killed before its envelope still shows the last thing it said", () => {
	const { result: run } = runClaude([
		{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] } },
	]);
	assert.equal(run.output, "thinking out loud");
	// Kept for reading, not mistaken for an answer: no envelope arrived, so this is not a success.
	assert.equal(classifyResult(run).kind, "invalid-response");
});

test("the result envelope wins, and an empty one does not erase the text before it", () => {
	const said = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "midway" }] } };
	const { result: finished } = runClaude([said, { type: "result", subtype: "success", stop_reason: "end_turn", result: "the report" }]);
	assert.equal(finished.output, "the report");
	assert.equal(classifyResult(finished).kind, "success");

	// An empty final answer is not an answer, so the earlier text survives for reading.
	const { result: blank } = runClaude([said, { type: "result", subtype: "success", stop_reason: "end_turn", result: "" }]);
	assert.equal(blank.output, "midway");
});
