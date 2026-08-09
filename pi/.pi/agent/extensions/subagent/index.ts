/**
 * Subagent — run one task in a fresh-context child process.
 *
 * Agents are markdown files in ./agents/: frontmatter defines role metadata and capabilities, and
 * the body is appended to the child's default system prompt. The child gets its own persistent
 * session and fresh context, so it cannot see this conversation.
 *
 * Why this is code and not a bash recipe: the child's tool allowlist comes from the agent file,
 * never from the model. If the model composed the command line, "this reviewer cannot edit code"
 * would be whatever it happened to type that turn.
 *
 * A delegation runs on `pi` unless its requested model names a supported native claude model —
 * see `selectRuntime` in ./runtimes.ts, which also holds everything about a child that is pure
 * enough to test. This file keeps extension wiring and rendering; ./run-agent.ts owns child processes.
 *
 * Parallelism is free — pi runs sibling tool calls from one assistant message concurrently, so
 * N `delegate` calls in one message is N concurrent agents. Hence no tasks[]/chain[] modes.
 *
 * Failure is read from `stopReason`, not the exit code: neither CLI sets one reliably. pi's json
 * mode exits 0 on a failed run, and claude exits 0 with empty stderr even for an unknown model.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadAgents } from "./agents.ts";
import { runAgent, shutdownAgents } from "./run-agent.ts";
import {
	type Agent,
	childSessionDir,
	classifyResult,
	delegateModelNames,
	type Inherited,
	isRecord,
	isRunResult,
	modelLabel,
	preview,
	type RunResult,
} from "./runtimes.ts";

const AGENT_DIR = getAgentDir();
const TASK_PREVIEW_MAX = 60;

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
	private readonly text: string;
	private readonly ellipsis: string;

	// The ellipsis carries its own styling because `truncateToWidth` closes every open code before
	// appending it: an unstyled "…" lands in the terminal's default foreground, the one glyph on the
	// line not dimmed like the text it stands in for.
	constructor(text: string, ellipsis: string) {
		this.text = text;
		this.ellipsis = ellipsis;
	}
	render(width: number): string[] {
		// Padded, so a shorter line overwrites whatever the previous frame left on that row.
		return [truncateToWidth(this.text, width, this.ellipsis, true)];
	}
	invalidate(): void {}
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

/** One line collapsed, then header/task/steps/report when expanded. */
function continuationBreadcrumb(runId: string): string {
	return `[Run ${runId}; continue with delegate({ runId: ${JSON.stringify(runId)}, task: "..." })]`;
}

function renderDelegateResult(
	result: { content: Array<{ type: string; text?: string }>; details: unknown },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	const details = result.details;
	if (!isRunResult(details)) {
		const first = result.content[0];
		return new Text(first?.type === "text" ? first.text ?? "(no output)" : "(no output)", 0, 0);
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
	const visibleReport = details.output.trim();
	if (visibleReport) {
		// "The run finished and this is its report" and "this is the last thing it said" are
		// different claims, and the label is the only thing that distinguishes them.
		const finished = !isPartial && outcome.kind === "success";
		container.addChild(
			new Text(theme.fg(finished ? "muted" : "warning", finished ? "── report ──" : "── last output ──"), 0, 0),
		);
		container.addChild(new Markdown(visibleReport, 0, 0, getMarkdownTheme()));
	}
	return container;
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const { agents: catalog, broken } = loadAgents();
	const continuable = new Map<
		string,
		{
			agent: string;
			model?: string;
			thinkingLevel?: Inherited["thinkingLevel"];
			sessionDir: string;
		}
	>();
	const roster = catalog.map((agent) =>
		`${agent.name} (${agent.tools.length ? agent.tools.join(", ") : "no tools"}): ${agent.description}`
	).join("; ") || "none";
	const piModels = enabledModels();
	let inheritedAppendSystemPrompt: string | undefined;

	// Said where it will be read. A skipped agent is silent otherwise: the roster simply comes up
	// one short, and nothing connects that to the file you just edited.
	pi.on("session_start", (_event, ctx) => {
		if (broken.length) ctx.ui.notify(`subagent skipped ${broken.join("; ")}`, "warning");
	});

	// `/new`, `/resume`, `/reload` and quit all land here. Idempotent: a child that has already
	// closed is no longer tracked, and ending one that is mid-exit is harmless.
	pi.on("session_shutdown", shutdownAgents);

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
				`Run one isolated task as a configured agent. Start a fresh run with agent, or ` +
				`resume an exact prior continuable run with runId. The child does not see the parent ` +
				`conversation, so provide a complete brief and exact file paths. Omit model to inherit the current Pi model` +
				(includeNativeClaude ? `; enabled Pi and native local Claude models are available. ` : `; enabled Pi models are available. `) +
				`Agents: ${roster}`,
			promptSnippet: "Delegate or continue one agent task in its own process",
			parameters: Type.Object({
				agent: Type.Optional(Type.String({
					description: `Fresh run role; one of: ${catalog.map((agent) => agent.name).join(", ")}`,
				})),
				runId: Type.Optional(Type.String({
					description: "Exact prior continuable run; cannot be combined with agent or model.",
					minLength: 1,
				})),
				task: Type.String({
					description: "The complete brief; the child does not see the parent conversation.",
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
				const label = args.runId
					? continuable.get(args.runId)?.agent ?? args.runId
					: args.agent || "…";
				const task = args.task ? preview(args.task, TASK_PREVIEW_MAX) : "…";
				return new Text(theme.fg("toolTitle", theme.bold(label)) + theme.fg("dim", `(${task})`), 0, 0);
			},

			// Called during the run too (isPartial), so this is where progress, the full task, and the
			// report all live: renderCall never receives `expanded`, so nothing collapsible can go there.
			renderResult: renderDelegateResult,

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const { agents } = loadAgents();
				let agent: Agent;
				let model: string | undefined;
				let inherited: Inherited;
				let runId: string | undefined;
				let sessionDir: string;

				if (params.runId) {
					if (params.agent || params.model) throw new Error("agent and model must be omitted when runId is given");
					const prior = continuable.get(params.runId);
					if (!prior) throw new Error(`unknown or non-continuable run ${params.runId}`);
					const found = agents.find((candidate) => candidate.name === prior.agent);
					if (!found?.continuable) throw new Error(`run ${params.runId} cannot be continued`);
					agent = found;
					model = prior.model;
					runId = params.runId;
					sessionDir = prior.sessionDir;
					inherited = {
						appendSystemPrompt: inheritedAppendSystemPrompt,
						model,
						thinkingLevel: prior.thinkingLevel,
						sessionDir,
						sessionId: runId,
						resume: true,
					};
				} else {
					if (!params.agent) throw new Error("agent is required when runId is omitted");
					const found = agents.find((candidate) => candidate.name === params.agent);
					if (!found) {
						throw new Error(`unknown agent ${params.agent}; available: ${agents.map((a) => a.name).join(", ") || "none"}`);
					}
					agent = found;
					model = params.model;
					sessionDir = childSessionDir(
						ctx.sessionManager.getSessionDir(),
						ctx.sessionManager.getSessionId(),
						AGENT_DIR,
					);
					runId = agent.continuable ? randomUUID() : undefined;
					inherited = {
						appendSystemPrompt: inheritedAppendSystemPrompt,
						model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						thinkingLevel: ctx.thinkingLevel,
						sessionDir,
						sessionId: runId,
					};
				}

				const result = await runAgent({
					agent,
					task: params.task,
					cwd: ctx.cwd,
					inherited,
					model,
					signal,
					onProgress: (partial) => {
						onUpdate?.({
							content: [{ type: "text", text: partial.activity ?? "thinking" }],
							details: partial,
						});
					},
				});
				if (runId && agent.continuable) {
					continuable.set(runId, {
						agent: agent.name,
						model: modelLabel(result),
						thinkingLevel: inherited.thinkingLevel,
						sessionDir,
					});
				}
				const outcome = classifyResult(result);
				if (outcome.kind !== "success") {
					const continuation = runId && agent.continuable
						? `${continuationBreadcrumb(runId)}\n\n`
						: "";
					return {
						content: [{
							type: "text" as const,
							text: `${continuation}${outcome.message ?? `${agent.name} failed.`}`,
						}],
						details: result,
						usage: result.usage,
					};
				}
				const report = [
					runId && agent.continuable
						? continuationBreadcrumb(runId)
						: "",
					result.output,
				].filter(Boolean).join("\n\n");
				return {
					content: [{ type: "text" as const, text: report }],
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
