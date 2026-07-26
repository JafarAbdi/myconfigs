/**
 * Subagent — run one bounded task in a fresh-context `pi` child process.
 *
 * Agents are markdown files in ./agents/: frontmatter becomes CLI flags, the body is appended to
 * the child's default system prompt. The child gets `--no-session`, so it cannot see this conversation.
 *
 * Why this is code and not a bash recipe: the child's tool allowlist comes from the agent file,
 * never from the model. If the model composed the command line, "this reviewer cannot edit code"
 * would be whatever it happened to type that turn.
 *
 * Parallelism is free — pi runs sibling tool calls from one assistant message concurrently, so
 * N `delegate` calls in one message is N concurrent agents. Hence no tasks[]/chain[] modes.
 *
 * Failure is read from `stopReason`, not the exit code: in `--mode json` a failed run still
 * exits 0 (the exit code is only set on the text-mode branch of print mode).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	getMarkdownTheme,
	parseFrontmatter,
	type Theme,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");
// `/audit` ships beside the agents it runs. pi's automatic scan reads `~/.pi/agent/prompts` one
// level deep and never descends into `extensions/`, so it is announced — see `resources_discover`.
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");
// A read-access agent must be structurally unable to mutate the workspace, and no child may
// delegate further. Exclusions are applied after the allowlist, so these win either way.
const MUTATING_TOOLS = ["edit", "write", "bash"];
/** What a read agent gets when its file names no tools: look at things, and find them first. */
const READ_TOOLS = ["read", "grep", "find", "ls"];
const NEVER_IN_CHILD = ["delegate"];
/** Children still running. The abort signal covers a cancelled call; this covers a dead session. */
const LIVE = new Set<ReturnType<typeof spawn>>();
const TASK_PREVIEW_MAX = 60;

interface Agent {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	access: "read" | "write";
	skills: "all" | "none";
	systemPrompt: string;
}

interface RunResult {
	agent: string;
	task: string;
	/** Text from the final assistant turn only. */
	output: string;
	/** Last nonempty assistant text, retained only for incomplete diagnostics. */
	diagnosticOutput?: string;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	termination?: "cancelled";
	/** Tool the child is running right now. Progress only; absent once it has finished. */
	activity?: string;
	turns: number;
	usage: Usage;
	durationMs: number;
}

/** Detached copy for a progress render: `result` keeps mutating, a rendered snapshot must not. */
function snapshot(result: RunResult, startedAtMs: number): RunResult {
	return {
		...result,
		usage: { ...result.usage, cost: { ...result.usage.cost } },
		durationMs: Date.now() - startedAtMs,
	};
}

/** `tools: read, grep` and `tools: [read, grep]` are both natural YAML. Accept whichever. */
function toolList(value: unknown): string[] | undefined {
	const parts = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value.map(String) : [];
	const tools = parts.map((tool) => tool.trim()).filter(Boolean);
	return tools.length ? tools : undefined;
}

/**
 * Every readable agent, and the reason each unreadable one was skipped. One malformed file used to
 * throw out of here — which happens inside the extension factory, so a stray typo in an agent's
 * frontmatter took `delegate` itself off the table, with the explanation in a startup diagnostic
 * nobody is looking at by then. Losing one agent should cost one agent.
 */
function loadAgents(): { agents: Agent[]; broken: string[] } {
	if (!existsSync(AGENTS_DIR)) return { agents: [], broken: [] };
	const agents: Agent[] = [];
	const broken: string[] = [];
	for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const name = entry.name.slice(0, -3);
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
				readFileSync(join(AGENTS_DIR, entry.name), "utf-8"),
			);
			const description = frontmatter.description;
			const access = frontmatter.access;
			if (typeof description !== "string" || !description) throw new Error("missing a description");
			if (access !== "read" && access !== "write") throw new Error("must declare access: read or write");
			const model = frontmatter.model;
			agents.push({
				name,
				description,
				tools: toolList(frontmatter.tools),
				model: typeof model === "string" ? model : undefined,
				access,
				skills: frontmatter.skills === "none" ? "none" : "all",
				systemPrompt: body.trim(),
			});
		} catch (error) {
			broken.push(`${name}: ${error instanceof Error ? error.message : error}`);
		}
	}
	return {
		agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
		broken,
	};
}

function buildArgs(
	agent: Agent,
	task: string,
	inheritedAppendSystemPrompt: string | undefined,
	inheritedModel: string | undefined,
): string[] {
	const excluded = [...NEVER_IN_CHILD, ...(agent.access === "read" ? MUTATING_TOOLS : [])];
	// Prompts are literal arguments: pi reads one as a file only when the string names an existing
	// path. Agent bodies are multi-line, so they cannot accidentally name a file.
	const args = ["--mode", "json", "-p", "--no-session"];
	if (inheritedAppendSystemPrompt?.trim()) {
		args.push("--append-system-prompt", inheritedAppendSystemPrompt);
	}
	args.push("--append-system-prompt", agent.systemPrompt);
	args.push("--exclude-tools", excluded.join(","));
	// A read agent that named no tools still gets an explicit allowlist. Without `--tools` the
	// child starts from pi's default active set — read, bash, edit, write — so removing the
	// mutating three leaves it holding `read` alone: no grep, no find, no ls, nothing to look for
	// anything it was not handed the path to. The exclusions stay as the belt to this brace, since
	// they also catch mutating tools contributed by extensions the child loads.
	const tools = agent.tools ?? (agent.access === "read" ? READ_TOOLS : undefined);
	if (tools) args.push("--tools", tools.join(","));
	// A child with no `model:` follows this session, not settings.json. Otherwise raising the parent
	// to a stronger model leaves every reviewer silently on whatever the default happens to be —
	// the one setting that would change what a review is worth, decided somewhere you are not.
	const model = agent.model ?? inheritedModel;
	if (model) args.push("--model", model);
	if (agent.skills === "none") args.push("--no-skills");
	// Last, and safe unquoted: spawn runs without a shell. Prefixed because pi has no `--` argument
	// terminator, so position alone does not protect it: a task opening with `--` or `@` is read as
	// a flag or a file and silently dropped, leaving a child with no prompt, and one opening with a
	// single `-` is an unknown option, which exits 1 before the agent runs.
	args.push(`Task: ${task}`);
	return args;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, args };
	return { command: "pi", args };
}

const COUNT_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function emptyUsage(): Usage {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const cost = value.cost;
	return (
		COUNT_KEYS.every((key) => typeof value[key] === "number") && COST_KEYS.every((key) => typeof cost[key] === "number")
	);
}

function isRunResult(value: unknown): value is RunResult {
	if (!isRecord(value)) return false;
	const optionalStrings = [
		"diagnosticOutput",
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

type OutcomeKind = "success" | "cancelled" | "aborted" | "model-error" | "invalid-response" | "length";

interface ResultOutcome {
	kind: OutcomeKind;
	label: string;
	message?: string;
}

function modelLabel(result: RunResult): string | undefined {
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

function classifyResult(result: RunResult): ResultOutcome {
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

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = once(child, "close");
	child.kill("SIGKILL");
	await closed;
}

function runAgent(
	agent: Agent,
	task: string,
	cwd: string,
	inheritedAppendSystemPrompt: string | undefined,
	inheritedModel: string | undefined,
	signal: AbortSignal | undefined,
	onProgress?: (partial: RunResult) => void,
): Promise<RunResult> {
	const startedAtMs = Date.now();
	const invocation = piInvocation(buildArgs(agent, task, inheritedAppendSystemPrompt, inheritedModel));
	const result: RunResult = {
		agent: agent.name,
		task,
		output: "",
		model: agent.model ?? inheritedModel,
		turns: 0,
		usage: emptyUsage(),
		durationMs: 0,
	};

	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Tracked so session teardown can end it. A child outliving its session is not merely a
		// stray process: it goes on spending tokens with nothing left to read what it produces.
		LIVE.add(child);
		let pending = "";
		let stderr = "";
		const activeTools = new Map<string, string>();
		let unidentifiedActivity: string | undefined;

		const updateActivity = () => {
			result.activity =
				[...activeTools.values(), ...(unidentifiedActivity ? [unidentifiedActivity] : [])].join(", ") || undefined;
			onProgress?.(snapshot(result, startedAtMs));
		};

		const consume = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return; // A non-JSON line is diagnostic noise, not a protocol failure.
			}
			if (!isRecord(event)) return;
			if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
				if (typeof event.toolCallId === "string") activeTools.set(event.toolCallId, event.toolName);
				else unidentifiedActivity = event.toolName;
				updateActivity();
				return;
			}
			if (event.type === "tool_execution_end") {
				if (typeof event.toolCallId === "string") {
					activeTools.delete(event.toolCallId);
				} else {
					activeTools.clear();
					unidentifiedActivity = undefined;
				}
				updateActivity();
				return;
			}
			if (event.type !== "message_end" || !isRecord(event.message)) return;
			if (event.message.role !== "assistant") return;
			const message = event.message;
			result.turns += 1;
			if (typeof message.provider === "string") result.provider = message.provider;
			if (typeof message.model === "string") result.model = message.model;
			result.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			result.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			if (isRecord(message.usage)) addUsage(result.usage, message.usage as Partial<Usage>);
			const text = assistantText(message.content);
			result.output = text;
			if (text.trim()) result.diagnosticOutput = text;
			onProgress?.(snapshot(result, startedAtMs));
		};

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				consume(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const kill = () => {
			result.termination = "cancelled";
			void terminateChild(child);
		};
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });

		child.once("error", reject);
		// `close`, not `exit`: exit fires when the process ends, close when its stdio has drained.
		// The report is the last thing written, so settling on `exit` races the pipe and loses it —
		// intermittently, and only under load, which is the worst way to lose an agent's whole run.
		child.once("close", () => {
			LIVE.delete(child);
			signal?.removeEventListener("abort", kill);
			consume(pending);
			activeTools.clear();
			unidentifiedActivity = undefined;
			result.activity = undefined;
			result.durationMs = Date.now() - startedAtMs;
			if (!result.output.trim() && !result.errorMessage && stderr.trim()) {
				result.errorMessage = stderr.trim().split("\n").slice(-5).join("\n");
			}
			resolve(result);
		});
	});
}

function preview(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	return `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1000)}s`;
}

function formatStats(result: RunResult): string {
	const parts: string[] = [];
	if (result.turns) parts.push(`${result.turns} turn${result.turns > 1 ? "s" : ""}`);
	if (result.usage.input) parts.push(`↑${formatTokens(result.usage.input)}`);
	if (result.usage.output) parts.push(`↓${formatTokens(result.usage.output)}`);
	if (result.usage.cacheRead) parts.push(`R${formatTokens(result.usage.cacheRead)}`);
	if (result.usage.cost.total) parts.push(`$${result.usage.cost.total.toFixed(4)}`);
	parts.push(formatDuration(result.durationMs));
	const model = modelLabel(result);
	if (model) parts.push(model);
	return parts.join(" ");
}

function resultHeader(result: RunResult, isPartial: boolean, theme: Theme): string {
	const outcome = classifyResult(result);
	const glyph = isPartial
		? theme.fg("accent", "⋯")
		: outcome.kind === "success"
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");
	let header = `${glyph} ${theme.fg("toolTitle", theme.bold(result.agent))}`;
	if (!isPartial) {
		const color = outcome.kind === "success" ? "success" : "error";
		header += ` ${theme.fg(color, `[${outcome.label}]`)}`;
	}
	const stats = [result.activity, formatStats(result)].filter(Boolean).join(" · ");
	return `${header} ${theme.fg("muted", `· ${stats}`)}`;
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const { agents: catalog, broken } = loadAgents();
	const roster = catalog.map((agent) => `${agent.name} (${agent.access}): ${agent.description}`).join("; ") || "none";
	let inheritedAppendSystemPrompt: string | undefined;

	// The prompts that drive these agents travel with them, so the extension announces its own
	// directory rather than depending on a settings.json entry that can be lost without a word.
	pi.on("resources_discover", () => ({ promptPaths: [PROMPTS_DIR] }));

	// Said where it will be read. A skipped agent is silent otherwise: the roster simply comes up
	// one short, and nothing connects that to the file you just edited.
	pi.on("session_start", (_event, ctx) => {
		if (broken.length) ctx.ui.notify(`subagent skipped ${broken.join("; ")}`, "warning");
	});

	// `/new`, `/resume`, `/reload` and quit all land here. Idempotent: a child that has already
	// closed is gone from the set, and SIGTERM to one that is mid-exit is harmless.
	pi.on("session_shutdown", async () => {
		await Promise.all([...LIVE].map(terminateChild));
	});

	pi.on("before_agent_start", (event) => {
		inheritedAppendSystemPrompt = event.systemPromptOptions.appendSystemPrompt;
	});

	// Returning preserves rich details and nested usage; this delegate-only hook supplies the
	// error bit that custom-tool return values cannot set themselves.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "delegate" || !isRunResult(event.details)) return;
		if (classifyResult(event.details).kind !== "success") return { isError: true };
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			`Run one bounded task as a configured agent in its own pi process with a fresh context. ` +
			`The agent cannot see this conversation, so the task must contain everything it needs — ` +
			`prefer file paths over pasted contents, it can read them itself. Emit several delegate ` +
			`calls in one message to run agents concurrently and mutually blind. Agents: ${roster}`,
		promptSnippet: "Delegate a bounded task to a fresh-context agent in its own process",
		promptGuidelines: [
			"Use delegate for independent review, research, or a bounded implementation.",
			"Emit two or more delegate calls in a single message when the results must be independent; write every task before issuing any of them.",
		],
		parameters: Type.Object({
			agent: Type.String({
				description: `One of: ${catalog.map((agent) => agent.name).join(", ")}`,
			}),
			task: Type.String({
				description: "The complete brief. The agent sees nothing else.",
				minLength: 1,
			}),
		}),

		renderCall(args, theme) {
			const agent = args.agent || "…";
			const task = args.task ? preview(args.task, TASK_PREVIEW_MAX) : "…";
			return new Text(theme.fg("toolTitle", theme.bold(agent)) + theme.fg("dim", `(${task})`), 0, 0);
		},

		// Called during the run too (isPartial), so this is where progress, the full task, and the
		// report all live: renderCall never receives `expanded`, so nothing collapsible can go there.
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details;
			if (!isRunResult(details)) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const outcome = classifyResult(details);
			const header = new Text(resultHeader(details, isPartial, theme), 0, 0);
			if (!expanded) return header;
			const container = new Container();
			container.addChild(header);
			container.addChild(new Text(theme.fg("muted", "── task ──"), 0, 0));
			container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
			if (!isPartial && outcome.message) {
				container.addChild(new Text(theme.fg("error", outcome.message), 0, 0));
			}
			const report = outcome.kind === "success" ? details.output : details.diagnosticOutput;
			if (report?.trim()) {
				const incomplete = isPartial || outcome.kind !== "success";
				const label = incomplete ? "── diagnostic (incomplete) ──" : "── report ──";
				container.addChild(new Text(theme.fg(incomplete ? "warning" : "muted", label), 0, 0));
				container.addChild(new Markdown(report.trim(), 0, 0, getMarkdownTheme()));
			}
			return container;
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { agents } = loadAgents();
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) {
				throw new Error(`unknown agent ${params.agent}; available: ${agents.map((a) => a.name).join(", ") || "none"}`);
			}
			const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const result = await runAgent(
				agent,
				params.task,
				ctx.cwd,
				inheritedAppendSystemPrompt,
				inheritedModel,
				signal,
				(partial) => {
					onUpdate?.({
						content: [{ type: "text", text: partial.activity ?? "thinking" }],
						details: partial,
					});
				},
			);
			const outcome = classifyResult(result);
			if (outcome.kind !== "success") {
				const failure = truncateHead(outcome.message ?? `${agent.name} failed.`, { maxLines: 10, maxBytes: 1000 });
				return {
					content: [{ type: "text" as const, text: failure.content }],
					details: result,
					usage: result.usage,
				};
			}
			// Tools must bound what they put in the parent's context, and several of these run at
			// once. `details` keeps the whole report for the expanded view.
			const report = truncateHead(result.output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: report.truncated
							? `${report.content}\n\n[Report truncated to ${formatSize(report.outputBytes)} of ${formatSize(report.totalBytes)} — full text in the tool details.]`
							: report.content,
					},
				],
				details: result,
				usage: result.usage,
			};
		},
	});
}
