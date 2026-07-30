/**
 * Subagent — run one bounded task in a fresh-context child process.
 *
 * Agents are markdown files in ./agents/: frontmatter defines role metadata and capabilities, and
 * the body is appended to the child's default system prompt. The child gets no session, so it
 * cannot see this conversation.
 *
 * Why this is code and not a bash recipe: the child's tool allowlist comes from the agent file,
 * never from the model. If the model composed the command line, "this reviewer cannot edit code"
 * would be whatever it happened to type that turn.
 *
 * A delegation runs on `pi` unless its requested model names a supported native claude model —
 * see `selectRuntime` in ./runtimes.ts, which also holds everything about a child that is pure
 * enough to test. This file keeps the extension wiring and the process itself.
 *
 * Parallelism is free — pi runs sibling tool calls from one assistant message concurrently, so
 * N `delegate` calls in one message is N concurrent agents. Hence no tasks[]/chain[] modes.
 *
 * Failure is read from `stopReason`, not the exit code: neither CLI sets one reliably. pi's json
 * mode exits 0 on a failed run, and claude exits 0 with empty stderr even for an unknown model.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { type Component, Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type Agent,
	agentFromFrontmatter,
	childEnvironment,
	claudeTools,
	classifyResult,
	delegateModelNames,
	emptyUsage,
	type Inherited,
	isRecord,
	isRunResult,
	modelLabel,
	preview,
	type RunResult,
	createActivityTracker,
	selectRuntime,
} from "./runtimes.ts";

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");
/** `~/.pi/agent`, two levels up from `extensions/subagent/`. */
const AGENT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
/** Children still running. The abort signal covers a cancelled call; this covers a dead session. */
const LIVE = new Set<ReturnType<typeof spawn>>();
const TASK_PREVIEW_MAX = 60;

/** Detached copy for a progress render: `result` keeps mutating, a rendered snapshot must not. */
function snapshot(result: RunResult, startedAtMs: number): RunResult {
	return {
		...result,
		usage: { ...result.usage, cost: { ...result.usage.cost } },
		// Copied per step, not just per array: a running step is mutated in place when it finishes,
		// and a rendered snapshot must keep showing what was true when it was taken.
		steps: result.steps.map((step) => ({ ...step })),
		durationMs: Date.now() - startedAtMs,
	};
}

/**
 * The pi models this user actually runs — `enabledModels` from settings, the same list pi's own
 * model picker cycles. Offering the whole catalogue instead would be hundreds of names the parent
 * has no auth for, in a tool description it pays for every turn. Missing or malformed settings
 * leave only the claude names, which is a shorter menu rather than a broken tool.
 */
function enabledModels(): string[] {
	try {
		const settings: unknown = JSON.parse(readFileSync(join(AGENT_DIR, "settings.json"), "utf-8"));
		const enabled = isRecord(settings) ? settings.enabledModels : undefined;
		return Array.isArray(enabled) ? enabled.filter((name): name is string => typeof name === "string") : [];
	} catch {
		return [];
	}
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
			agents.push(agentFromFrontmatter(name, frontmatter, body.trim()));
		} catch (error) {
			broken.push(`${name}: ${error instanceof Error ? error.message : error}`);
		}
	}
	return {
		agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
		broken,
	};
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
	inherited: Inherited,
	model: string | undefined,
	signal: AbortSignal | undefined,
	onProgress?: (partial: RunResult) => void,
): Promise<RunResult> {
	const startedAtMs = Date.now();
	const runtime = selectRuntime(model);
	const invocation = runtime.invoke(agent, task, inherited, model);
	const result: RunResult = {
		agent: agent.name,
		task,
		output: "",
		model: model ?? inherited.model,
		steps: [],
		turns: 0,
		usage: emptyUsage(),
		durationMs: 0,
	};

	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			env: childEnvironment(runtime.name),
			shell: false,
			stdio: [invocation.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (invocation.input !== undefined && child.stdin) {
			// A child that dies before reading its prompt turns this write into an EPIPE, and an
			// unhandled `error` on a stream takes the whole session down. The close handler below
			// already reports the run as the failure it is.
			child.stdin.on("error", () => {});
			child.stdin.end(invocation.input);
		}
		// Tracked so session teardown can end it. A child outliving its session is not merely a
		// stray process: it goes on spending tokens with nothing left to read what it produces.
		LIVE.add(child);
		let pending = "";
		let stderr = "";
		const activity = createActivityTracker(result);

		const consume = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return; // A non-JSON line is diagnostic noise, not a protocol failure.
			}
			if (!isRecord(event)) return;
			if (runtime.consume(event, result, activity)) onProgress?.(snapshot(result, startedAtMs));
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
			// A step still open here never finished, and keeps its running mark to say so rather
			// than reading as the last thing that succeeded.
			result.activity = undefined;
			result.durationMs = Date.now() - startedAtMs;
			if (!result.output.trim() && !result.errorMessage && stderr.trim()) {
				result.errorMessage = stderr.trim().split("\n").slice(-5).join("\n");
			}
			resolve(result);
		});
	});
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

/**
 * One line, cut to the width the terminal actually has. `Text` wraps instead, which turns a long
 * command into two or three rows and buries the next one; and a fixed character budget is a display
 * decision made by someone who cannot see the pane. Truncating here means the same log reads at 60
 * columns and at 200, and re-reads correctly when the pane is resized.
 */
class Line implements Component {
	// The ellipsis carries its own styling because `truncateToWidth` closes every open code before
	// appending it: an unstyled "…" lands in the terminal's default foreground, the one glyph on the
	// line not dimmed like the text it stands in for.
	constructor(
		private readonly text: string,
		private readonly ellipsis: string,
	) {}
	render(width: number): string[] {
		// Padded, so a shorter line overwrites whatever the previous frame left on that row.
		return [truncateToWidth(this.text, width, this.ellipsis, true)];
	}
}

/** The run as it happened, one tool per line — the whole point of expanding a run still in flight. */
function stepLines(result: RunResult, theme: Theme): Component[] {
	if (!result.steps.length) return [];
	const lines: Component[] = [new Text(theme.fg("muted", "── steps ──"), 0, 0)];
	for (const step of result.steps) {
		const glyph = !step.outcome
			? theme.fg("accent", "⋯")
			: step.outcome === "failed"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		const detail = step.detail ? theme.fg("dim", ` ${step.detail}`) : "";
		lines.push(new Line(`${glyph} ${theme.fg("toolTitle", step.tool)}${detail}`, theme.fg("dim", "…")));
	}
	return lines;
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
	const roster =
		catalog.map((agent) => `${agent.name} (${agent.tools.join(", ")}): ${agent.description}`).join("; ") || "none";
	const piModels = enabledModels();
	let inheritedAppendSystemPrompt: string | undefined;

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

	const registerDelegate = (includeNativeClaude: boolean): void => {
		const offeredModels = delegateModelNames(piModels, includeNativeClaude);
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				`Run one bounded task as a configured agent in its own process with a fresh context. ` +
				`The agent cannot see this conversation, so the task must contain everything it needs — ` +
				`prefer file paths over pasted contents, it can read them itself. Emit several delegate ` +
				`calls in one message to run agents concurrently and mutually blind. Omit \`model\` to use ` +
				`the current Pi model; pass it to select an enabled Pi model` +
				(includeNativeClaude ? ` or a native local Claude model. ` : `. `) +
				`Agents: ${roster}`,
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
				model: Type.Optional(
					Type.Union(
						offeredModels.map((name) => Type.Literal(name)),
						{
							description: includeNativeClaude
								? "Run on this model. Bare claude-* names use the local claude CLI; provider-qualified names use Pi. Omit to use the current Pi model."
								: "Run on this Pi model. Omit to use the current Pi model.",
						},
					),
				),
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
				for (const line of stepLines(details, theme)) container.addChild(line);
				if (!isPartial && outcome.message) {
					container.addChild(new Text(theme.fg("error", outcome.message), 0, 0));
				}
				if (details.output.trim()) {
					// "The run finished and this is its report" and "this is the last thing it said" are
					// different claims, and the label is the only thing that distinguishes them.
					const finished = !isPartial && outcome.kind === "success";
					container.addChild(
						new Text(theme.fg(finished ? "muted" : "warning", finished ? "── report ──" : "── last output ──"), 0, 0),
					);
					container.addChild(new Markdown(details.output.trim(), 0, 0, getMarkdownTheme()));
				}
				return container;
			},

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const { agents } = loadAgents();
				const found = agents.find((candidate) => candidate.name === params.agent);
				if (!found) {
					throw new Error(`unknown agent ${params.agent}; available: ${agents.map((a) => a.name).join(", ") || "none"}`);
				}
				// Native claude needs translated tools; Pi uses the agent's tool names directly.
				const runtime = selectRuntime(params.model);
				if (runtime.name === "claude") claudeTools(found);
				const inherited: Inherited = {
					appendSystemPrompt: inheritedAppendSystemPrompt,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				};
				const result = await runAgent(found, params.task, ctx.cwd, inherited, params.model, signal, (partial) => {
					onUpdate?.({
						content: [{ type: "text", text: partial.activity ?? "thinking" }],
						details: partial,
					});
				});
				const outcome = classifyResult(result);
				if (outcome.kind !== "success") {
					const failure = truncateHead(outcome.message ?? `${found.name} failed.`, { maxLines: 10, maxBytes: 1000 });
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
	};

	registerDelegate(true);
	const stopListeningForSsh = pi.events.on("ssh:connected", () => registerDelegate(false));
	pi.on("session_shutdown", stopListeningForSsh);
}
