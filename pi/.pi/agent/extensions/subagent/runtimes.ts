/**
 * Runtimes — the two child CLIs `delegate` can spawn, and everything pure enough to test.
 *
 * `index.ts` imports pi's packages for their values; this module deliberately imports only types
 * from them, so `node --test runtimes.test.ts` can load it. Type imports are erased, value imports
 * are not: `rpi/questions.test.ts` fails today for exactly that reason. Hence the shared `Agent`
 * and `RunResult` types live here and `index.ts` imports them from this file, never the reverse.
 *
 * A runtime owns two things: the argv (plus stdin) that starts a child, and how that child's JSONL
 * folds into a `RunResult`. Everything downstream — classification, rendering, teardown — sees one
 * normalized shape and never learns which CLI produced it.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

export interface Agent {
	name: string;
	description: string;
	/** Required. This list is the agent's capability — nothing else adds to it or takes from it. */
	tools: string[];
	model?: string;
	/** claude only: `--effort`. pi spells this `--thinking` and inherits it from the session. */
	effort?: string;
	skills: "all" | "none";
	systemPrompt: string;
}

export interface RunResult {
	agent: string;
	task: string;
	/** The latest assistant text. The final turn's, once there is one; before that, the last thing said. */
	output: string;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	termination?: "cancelled";
	/** Tool the child is running right now. Progress only; absent once it has finished. */
	activity?: string;
	/** Thinking tokens so far, when the child reports them. The only sign of life during a long think. */
	thinking?: number;
	/** Every tool the child has run, in order. What `expanded` shows while the run is still going. */
	steps: Step[];
	turns: number;
	usage: Usage;
	durationMs: number;
}

export interface Step {
	tool: string;
	/** The salient argument — a command, a path, a pattern. Already flattened and truncated. */
	detail?: string;
	/** Absent while the tool is still running, which is also how a killed child's last step reads. */
	outcome?: "ok" | "failed";
}

/** Steps kept, and so also steps shown: a tail is a tail, and a loop cannot grow the parent's memory. */
export const STEP_LIMIT = 40;
/**
 * A memory bound, not a display one: a heredoc pasted into `bash` should not sit in the parent
 * across every step. How much of this actually fits on a line is the renderer's business, decided
 * against the terminal it can see.
 */
const DETAIL_STORED_MAX = 2000;

/**
 * The one argument worth showing, ordered by how specifically it identifies the call. `pattern`
 * outranks `path` because grep and find take both, and the pattern is the question — the path is
 * usually just the cwd. pi and claude agree on these names (`command`, `path`, `pattern`, `glob`;
 * claude spells read's path `file_path`), so one list serves both. Anything unrecognised shows
 * nothing rather than a blob of JSON.
 */
const DETAIL_KEYS = ["command", "pattern", "file_path", "path", "glob", "url", "query", "description"];

export function stepDetail(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined;
	for (const key of DETAIL_KEYS) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return preview(value, DETAIL_STORED_MAX);
	}
	return undefined;
}

/** What the parent session lends a child. A claude child never borrows the model — see `selectRuntime`. */
export interface Inherited {
	appendSystemPrompt?: string;
	model?: string;
}

export interface Invocation {
	command: string;
	args: string[];
	/** Written to the child's stdin and closed. Absent means the child gets no stdin at all. */
	input?: string;
}

/**
 * Live tool calls, keyed by id. `undefined` means the event carried no id: starting one records a
 * single unidentified tool, ending one clears everything. Only pi takes that path — claude always
 * identifies its calls, and guessing on its behalf would let one finished tool wipe a running
 * sibling off the progress line.
 */
export interface ActivityTracker {
	start(id: string | undefined, tool: string, detail?: string): void;
	end(id: string | undefined, failed?: boolean): void;
	/** Reported thinking so far. The line has to be recomputed here, or a think shows nothing at all. */
	think(tokens: number): void;
}

/**
 * The progress line and the step log, which are the same information at two depths: what is running
 * now, and everything that ran. Both are written onto `result`, so a snapshot of it renders without
 * consulting anything else.
 */
export function createActivityTracker(result: RunResult): ActivityTracker {
	// Live calls point at their entry in `result.steps`, so finishing one marks the step that started
	// it rather than appending a second line for the same call.
	const live = new Map<string, Step>();
	let unidentified: Step | undefined;

	const refresh = () => {
		const running = [...live.values(), ...(unidentified ? [unidentified] : [])];
		// Nothing running is not nothing happening: a long think shows its token count instead.
		result.activity = running.length
			? running.map((step) => (step.detail ? `${step.tool}(${step.detail})` : step.tool)).join(", ")
			: result.thinking
				? `thinking ${result.thinking}`
				: undefined;
	};

	return {
		start(id, tool, detail) {
			const step: Step = { tool, detail };
			// Oldest first, because the tail is what you are watching.
			if (result.steps.length >= STEP_LIMIT) result.steps.shift();
			result.steps.push(step);
			if (id) live.set(id, step);
			else unidentified = step;
			refresh();
		},
		think(tokens) {
			result.thinking = tokens;
			refresh();
		},
		end(id, failed) {
			const finish = (step: Step) => {
				step.outcome = failed ? "failed" : "ok";
			};
			if (id) {
				const step = live.get(id);
				if (step) finish(step);
				live.delete(id);
			} else {
				// pi omits the id on some events; ending without one ends everything, which is only
				// correct because pi never runs two of these concurrently.
				for (const step of live.values()) finish(step);
				live.clear();
				if (unidentified) finish(unidentified);
				unidentified = undefined;
			}
			refresh();
		},
	};
}

export interface Runtime {
	name: "pi" | "claude";
	invoke(agent: Agent, task: string, inherited: Inherited): Invocation;
	/**
	 * True when the event changed something worth redrawing. Both CLIs interleave bookkeeping the
	 * parent has no use for — claude alone emits a `thinking_tokens` line every few hundred
	 * milliseconds — and repainting the tool card for each of those is work nobody sees.
	 */
	consume(event: Record<string, unknown>, result: RunResult, activity: ActivityTracker): boolean;
}

/**
 * Exact model names, no aliases. `opus`/`sonnet`/`haiku` all work on the CLI, but an alias is a
 * name that means something else, and one of them is a trap: `opusplan` runs as `claude-sonnet-5`
 * under `-p`, being a plan-mode alias, and a headless subagent never plans. Excluding aliases
 * removes that whole class of surprise instead of special-casing one member of it.
 */
const CLAUDE_MODELS = new Set(["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5-20251001"]);
/** The same list as a value the `delegate` schema can enumerate: how the model learns these names. */
export const CLAUDE_MODEL_NAMES = [...CLAUDE_MODELS].sort();
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
/**
 * The one capability rule left. Depth is always exactly one: a child that could delegate would make
 * the fan-out unbounded, and nothing in the parent is watching a grandchild's spend.
 */
const NEVER_IN_CHILD = ["delegate"];
const CLAUDE_TOOLS: Record<string, string> = {
	read: "Read",
	grep: "Grep",
	find: "Glob",
	ls: "Glob",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
	web_search: "WebSearch",
	fetch_content: "WebFetch",
};

const COUNT_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: Usage, next: Partial<Usage>): void {
	for (const key of COUNT_KEYS) total[key] += next[key] ?? 0;
	for (const key of COST_KEYS) total.cost[key] += next.cost?.[key] ?? 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const cost = value.cost;
	return (
		COUNT_KEYS.every((key) => typeof value[key] === "number") && COST_KEYS.every((key) => typeof cost[key] === "number")
	);
}

export function isRunResult(value: unknown): value is RunResult {
	if (!isRecord(value)) return false;
	const optionalStrings = [
		"stopReason",
		"errorMessage",
		"provider",
		"model",
		"activity",
		"termination",
	];
	return (
		typeof value.agent === "string" &&
		typeof value.task === "string" &&
		typeof value.output === "string" &&
		typeof value.turns === "number" &&
		typeof value.durationMs === "number" &&
		Array.isArray(value.steps) &&
		(value.thinking === undefined || typeof value.thinking === "number") &&
		isUsage(value.usage) &&
		optionalStrings.every((key) => value[key] === undefined || typeof value[key] === "string") &&
		(value.termination === undefined || value.termination === "cancelled")
	);
}

function assistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function preview(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type OutcomeKind = "success" | "cancelled" | "aborted" | "model-error" | "invalid-response" | "length";

export interface ResultOutcome {
	kind: OutcomeKind;
	label: string;
	message?: string;
}

export function modelLabel(result: RunResult): string | undefined {
	if (result.provider && result.model) {
		return result.model.startsWith(`${result.provider}/`) ? result.model : `${result.provider}/${result.model}`;
	}
	return result.model ?? result.provider;
}

function errorContext(result: RunResult): string {
	const model = modelLabel(result);
	return model ? ` (${preview(model, 100)})` : "";
}

function errorDetail(result: RunResult): string | undefined {
	const detail = result.errorMessage?.replace(/\s+/g, " ").trim();
	if (!detail) return undefined;
	return detail.length > 300 ? `${detail.slice(0, 299)}…` : detail;
}

export function classifyResult(result: RunResult): ResultOutcome {
	const context = errorContext(result);
	const detail = errorDetail(result);
	const suffix = detail ? `: ${detail}` : ".";

	if (detail && /\b(?:TimeoutError|ETIMEDOUT|timeout|time(?:d)?\s*out|deadline exceeded)\b/i.test(detail)) {
		return {
			kind: "aborted",
			label: "timeout/abort",
			message: `${result.agent} timed out or was aborted${context}${suffix}`,
		};
	}
	if (result.termination === "cancelled") {
		return {
			kind: "cancelled",
			label: "cancelled",
			message: `${result.agent} was cancelled.`,
		};
	}
	if (result.stopReason === "length") {
		return {
			kind: "length",
			label: "output limit",
			message: `${result.agent} exceeded its output limit${context}. Retry with a narrower task or request a shorter response.`,
		};
	}
	if (result.stopReason === "aborted") {
		return {
			kind: "aborted",
			label: "timeout/abort",
			message: `${result.agent} timed out or was aborted${context}${suffix}`,
		};
	}
	if (result.stopReason === "error") {
		return {
			kind: "model-error",
			label: "model error",
			message: `${result.agent} model error${context}${suffix}`,
		};
	}
	if (result.stopReason !== "stop" || !result.output.trim()) {
		const reason = detail ?? (result.stopReason ? `unexpected stop reason: ${result.stopReason}` : undefined);
		return {
			kind: "invalid-response",
			label: "no usable text",
			message: `${result.agent} returned no usable final text${context}${reason ? `: ${reason}` : "."} Retry; if this persists, check the model/provider.`,
		};
	}
	return { kind: "success", label: "completed" };
}

/**
 * The claude tool allowlist for an agent: pi's vocabulary in, claude's out — so switching an agent
 * between runtimes never means rewriting its `tools:`, and one reviewer prompt runs on either
 * family.
 *
 * The list is passed through, not edited: what `tools:` says is what the agent gets, a shell
 * included. Anything that filtered it here would let a file state one capability while the child
 * holds another.
 */
export function claudeTools(agent: Agent): string[] {
	const allowed = new Set<string>();
	for (const tool of agent.tools) {
		if (NEVER_IN_CHILD.includes(tool)) continue;
		const mapped = CLAUDE_TOOLS[tool];
		if (!mapped) throw new Error(`tool ${tool} has no claude equivalent`);
		allowed.add(mapped);
	}
	// `skills: all` must grant Skill explicitly: the allowlist fences it like any other tool, so
	// omitting it is the whole of `skills: none` — no `--disable-slash-commands` needed.
	if (agent.skills === "all") allowed.add("Skill");
	// `find` and `ls` both map to Glob, so dedupe is load-bearing, not tidiness. Sorted for a
	// stable command line.
	return [...allowed].sort();
}

const claudeRuntime: Runtime = {
	name: "claude",

	invoke(agent, task, inherited) {
		// Repeating `--append-system-prompt` silently drops all but the last, so the inherited text
		// and the agent body travel as one argument.
		const systemPrompt = [inherited.appendSystemPrompt?.trim(), agent.systemPrompt]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");
		const tools = claudeTools(agent).join(",");
		const args = [
			"-p",
			// stream-json refuses to run without it, rather than falling back.
			"--verbose",
			"--output-format",
			"stream-json",
			"--no-session-persistence",
			// No `--mcp-config` alongside it, so the child loads zero MCP servers: nothing outside
			// the allowlist, and nothing to orphan when the child is killed.
			"--strict-mcp-config",
			"--append-system-prompt",
			systemPrompt,
		];
		// Always set: naming a claude model is *how* an agent selected this runtime.
		if (agent.model) args.push("--model", agent.model);
		if (agent.effort) args.push("--effort", agent.effort);
		// Pinned, or `~/.claude/settings.json` decides whether a subagent's tools run at all.
		args.push("--permission-mode", "acceptEdits");
		// Availability and permission are separate grants: without this a tool is offered and then
		// denied mid-run, and the run still reports success. So the agent file grants outright —
		// `bash` in a file is a pre-approved shell.
		args.push("--allowed-tools", tools);
		// An exact allowlist, extension- and MCP-contributed tools included. Empty is legal: claude
		// reads `--tools ""` as "no tools at all".
		args.push("--tools", tools);
		// On stdin, because `--tools` and `--allowed-tools` are variadic and swallow a trailing
		// positional prompt. Prefixed like pi's so both families read an identical brief.
		return { command: "claude", args, input: `Task: ${task}` };
	},

	consume(event, result, activity) {
		if (event.type === "system") {
			if (event.subtype === "thinking_tokens" && typeof event.estimated_tokens === "number") {
				activity.think(event.estimated_tokens);
				return true;
			}
			if (event.subtype !== "init" || typeof event.model !== "string") return false;
			result.model = event.model;
			return true;
		}
		if (event.type === "assistant" || event.type === "user") {
			const message = event.message;
			if (!isRecord(message)) return false;
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (!isRecord(block)) continue;
				if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
					activity.start(block.id, block.name, stepDetail(block.input));
				} else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
					activity.end(block.tool_use_id, block.is_error === true);
				}
			}
			// Kept as it arrives, so a child killed before its final envelope still shows the last
			// thing it said rather than nothing at all.
			if (event.type === "assistant") {
				const text = assistantText(message.content);
				if (text.trim()) result.output = text;
			}
			return true;
		}
		if (event.type !== "result") return false;
		if (typeof event.num_turns === "number") result.turns = event.num_turns;
		// The envelope is authoritative when it says anything. An empty one is not a final answer,
		// so it does not get to erase the last real text — `classifyResult` already rejects a run
		// that produced no text at all.
		if (typeof event.result === "string" && event.result.trim()) result.output = event.result;
		result.usage = claudeUsage(event);
		const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
		// Worst news first, and the order is load-bearing. Hitting the output limit is not an error,
		// so a truncated run arrives here as a plain success — test success first and it is swallowed
		// as a finished answer, leaving `length` reachable only when the run also failed.
		if (event.is_error === true || event.subtype !== "success" || denials.length) {
			result.stopReason = "error";
			result.errorMessage = claudeFailure(event, denials);
		} else if (event.stop_reason === "max_tokens") {
			result.stopReason = "length";
		} else {
			result.stopReason = "stop";
		}
		return true;
	},
};

/**
 * `modelUsage` is the run total; the envelope's own `usage` counts the final turn only. Assigned,
 * never accumulated: there is one of these per run.
 */
function claudeUsage(event: Record<string, unknown>): Usage {
	const usage = emptyUsage();
	const perModel = isRecord(event.modelUsage) ? Object.values(event.modelUsage) : [];
	for (const entry of perModel) {
		if (!isRecord(entry)) continue;
		addUsage(usage, {
			input: typeof entry.inputTokens === "number" ? entry.inputTokens : 0,
			output: typeof entry.outputTokens === "number" ? entry.outputTokens : 0,
			cacheRead: typeof entry.cacheReadInputTokens === "number" ? entry.cacheReadInputTokens : 0,
			cacheWrite: typeof entry.cacheCreationInputTokens === "number" ? entry.cacheCreationInputTokens : 0,
		});
	}
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	// Only the total is reported; claude gives no per-component costs to split it into.
	if (typeof event.total_cost_usd === "number") usage.cost.total = event.total_cost_usd;
	return usage;
}

/**
 * A bad `--model` exits 0 with empty stderr and `subtype: "success"` — the whole diagnosis is
 * in-band, so everything the envelope knows goes into the message.
 */
function claudeFailure(event: Record<string, unknown>, denials: unknown[]): string {
	const parts: string[] = [];
	const denied = denials
		.map((denial) => (isRecord(denial) && typeof denial.tool_name === "string" ? denial.tool_name : undefined))
		.filter((name): name is string => Boolean(name));
	if (denied.length) parts.push(`denied ${[...new Set(denied)].join(", ")} — the run reported success anyway`);
	if (typeof event.subtype === "string" && event.subtype !== "success") parts.push(event.subtype);
	if (typeof event.terminal_reason === "string") parts.push(event.terminal_reason);
	if (event.api_error_status != null) parts.push(`api status ${String(event.api_error_status)}`);
	if (typeof event.result === "string" && event.result.trim()) parts.push(event.result.trim());
	return parts.join("; ") || "claude reported a failure with no detail";
}

const piRuntime: Runtime = {
	name: "pi",

	invoke(agent, task, inherited) {
		// Prompts are literal arguments: pi reads one as a file only when the string names an existing
		// path. Agent bodies are multi-line, so they cannot accidentally name a file.
		const args = ["--mode", "json", "-p", "--no-session"];
		if (inherited.appendSystemPrompt?.trim()) {
			args.push("--append-system-prompt", inherited.appendSystemPrompt);
		}
		args.push("--append-system-prompt", agent.systemPrompt);
		// No `--exclude-tools` beside this: pi's `isAllowedTool` (core/agent-session.js) applies the
		// allowlist to extension- and SDK-registered tools alike, so a deny list could only restate
		// it and then drift from it. `delegate` is excluded by not being granted.
		const tools = agent.tools.filter((tool) => !NEVER_IN_CHILD.includes(tool));
		// Explicit both ways: without `--tools` the child would fall back to pi's default active set
		// (read, bash, edit, write) — a file that grants nothing must get nothing, not the default.
		args.push(...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]));
		// A pi child with no `model:` follows this session rather than settings.json: otherwise raising
		// the parent to a stronger model would leave every reviewer on whatever the default happens to
		// be — the one setting that changes what a review is worth, decided somewhere you are not.
		// Inheritance stays inside pi's namespace; a claude agent always names its model, which is how
		// it selected that runtime in the first place.
		const model = agent.model ?? inherited.model;
		if (model) args.push("--model", model);
		if (agent.skills === "none") args.push("--no-skills");
		// Last, and safe unquoted: spawn runs without a shell. Prefixed because pi has no `--` argument
		// terminator, so position alone does not protect it: a task opening with `--` or `@` is read as
		// a flag or a file and silently dropped, leaving a child with no prompt, and one opening with a
		// single `-` is an unknown option, which exits 1 before the agent runs.
		args.push(`Task: ${task}`);
		return piInvocation(args);
	},

	consume(event, result, activity) {
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			activity.start(
				typeof event.toolCallId === "string" ? event.toolCallId : undefined,
				event.toolName,
				stepDetail(event.args),
			);
			return true;
		}
		if (event.type === "tool_execution_end") {
			activity.end(typeof event.toolCallId === "string" ? event.toolCallId : undefined, event.isError === true);
			return true;
		}
		if (event.type !== "message_end" || !isRecord(event.message)) return false;
		if (event.message.role !== "assistant") return false;
		const message = event.message;
		result.turns += 1;
		if (typeof message.provider === "string") result.provider = message.provider;
		if (typeof message.model === "string") result.model = message.model;
		result.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
		result.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		if (isRecord(message.usage)) addUsage(result.usage, message.usage as Partial<Usage>);
		result.output = assistantText(message.content);
		return true;
	},
};

function piInvocation(args: string[]): Invocation {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * The model name *is* the runtime: there is no `runtime:` key to keep in sync with it, and pi
 * models carry a provider prefix, so the two namespaces cannot collide.
 *
 * Throws on a bare `claude-*` name this list does not know — a typo like `claude-opus5`, or a model
 * that shipped after this list was written. Both would otherwise be handed quietly to pi, which is
 * the one outcome worth preventing: an agent whose roster entry says claude, reviewing its own
 * family. Running claude *through* pi is spelled `anthropic/claude-opus-5` and never reaches here.
 */
export function selectRuntime(model: string | undefined): Runtime {
	if (!model) return piRuntime;
	if (CLAUDE_MODELS.has(model)) return claudeRuntime;
	if (!model.includes("/") && model.startsWith("claude-")) {
		throw new Error(`unknown claude model ${model}; known: ${[...CLAUDE_MODELS].sort().join(", ")}`);
	}
	return piRuntime;
}

export function isEffortLevel(value: string): boolean {
	return EFFORT_LEVELS.has(value);
}

export const EFFORT_HELP = [...EFFORT_LEVELS].join(", ");
