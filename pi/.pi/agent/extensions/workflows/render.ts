import {
	getMarkdownTheme,
	keyHint,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";
import { truncateUtf8Bytes } from "./agent-run.ts";
import {
	JOB_SCHEMA_VERSION,
	type JobProjection,
	type JobState,
	type WorkflowNodeState,
} from "./job-store.ts";
import { WORKFLOW_TOOL_OUTPUT_BYTES_MAX } from "./limits.ts";
import {
	duration,
	shortId,
	tokenCount,
	workflowNodeSummary,
} from "./presentation.ts";

interface RenderContext {
	isError: boolean;
	args?: unknown;
}

interface AgentRunArgs {
	agent: string;
	task: string;
	context?: "fresh" | "fork";
	cwd?: string;
	background?: boolean;
}

interface WorkflowStartArgs {
	goal: string;
	context?: "fresh" | "fork";
	cwd?: string;
}

interface JobIdArgs {
	id?: string;
}

interface AgentResultDetails {
	agent: string;
	access: "read" | "write";
	cwd: string;
	durationMs: number;
	model?: string;
	stopReason?: string;
}

type WorkflowLedgerEntry =
	| { kind: "node"; node: WorkflowNodeState }
	| { kind: "omission"; nodes: WorkflowNodeState[] };

const COMPACT_WORKFLOW_NODE_COUNT_MAX = 10;
const COMPACT_WORKFLOW_NODE_HEAD_COUNT = 3;
const COMPACT_WORKFLOW_NODE_TAIL_COUNT = 4;

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function preview(value: string, lengthMax: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > lengthMax ? `${compact.slice(0, lengthMax - 1)}…` : compact;
}

function isJobProjection(value: unknown): value is JobProjection {
	if (typeof value !== "object" || value === null) return false;
	const projection = value as Partial<JobProjection>;
	if (typeof projection.state !== "object" || projection.state === null) return false;
	return projection.state.version === JOB_SCHEMA_VERSION &&
		typeof projection.state.id === "string";
}

function isAgentResult(value: unknown): value is AgentResultDetails {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<AgentResultDetails>;
	return typeof candidate.agent === "string" && typeof candidate.durationMs === "number";
}

function stateMark(
	state: JobState["state"] | WorkflowNodeState["state"],
	theme: Theme,
): string {
	switch (state) {
		case "succeeded":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("warning", "■");
		case "running":
			return theme.fg("accent", "●");
		case "pending":
		case "queued":
			return theme.fg("muted", "○");
	}
}

function jobTitle(state: JobState, theme: Theme): string {
	let text = `${stateMark(state.state, theme)} `;
	text += theme.fg("toolTitle", theme.bold(state.type));
	text += ` ${theme.fg("accent", shortId(state.id))}`;
	text += theme.fg("muted", ` • ${state.state}`);
	if (state.nodes?.length) {
		text += theme.fg("muted", ` • ${workflowNodeSummary(state.nodes, true)}`);
	} else if (state.type === "workflow" && ["queued", "running"].includes(state.state)) {
		text += theme.fg("muted", " • coordinator choosing first nodes");
	}
	if (state.startedAt && state.endedAt) {
		const elapsedMs = Date.parse(state.endedAt) - Date.parse(state.startedAt);
		text += theme.fg("dim", ` • ${duration(elapsedMs)}`);
	}
	if (state.type === "agent" && state.state === "running" && state.activity) {
		text += theme.fg("warning", ` • ${state.activity}`);
	}
	if (state.toolCount) text += theme.fg("dim", ` • ${state.toolCount} tools`);
	if (state.usage) {
		text += theme.fg("dim", ` • ${tokenCount(state.usage.totalTokens)} tok`);
		text += theme.fg("dim", ` • $${state.usage.cost.total.toFixed(3)}`);
	}
	return text;
}

function nodeLine(node: WorkflowNodeState, theme: Theme): string {
	let text = `  ${stateMark(node.state, theme)} ${theme.fg("accent", node.id)}`;
	text += theme.fg("muted", ` · ${node.agent}`);
	if (node.dependsOn.length > 0) {
		text += theme.fg("dim", ` ← ${node.dependsOn.join(", ")}`);
	}
	if (node.state === "running" && node.activity) {
		text += theme.fg("warning", ` · ${node.activity}`);
	}
	if (node.error) text += theme.fg("error", ` · ${preview(node.error, 100)}`);
	if (node.toolCount) text += theme.fg("dim", ` · ${node.toolCount} tools`);
	if (node.startedAt && node.endedAt) {
		const elapsedMs = Date.parse(node.endedAt) - Date.parse(node.startedAt);
		text += theme.fg("dim", ` · ${duration(elapsedMs)}`);
	}
	if (node.usage?.totalTokens) {
		text += theme.fg("dim", ` · ${tokenCount(node.usage.totalTokens)} tok`);
	}
	return text;
}

function isAttentionNode(node: WorkflowNodeState): boolean {
	return node.state === "running" || node.state === "failed" || node.state === "cancelled";
}

function workflowLedgerEntries(
	nodes: WorkflowNodeState[],
	expanded: boolean,
): WorkflowLedgerEntry[] {
	if (expanded || nodes.length <= COMPACT_WORKFLOW_NODE_COUNT_MAX) {
		return nodes.map((node) => ({ kind: "node", node }));
	}
	const visible = new Set<number>();
	for (let index = 0; index < COMPACT_WORKFLOW_NODE_HEAD_COUNT; index += 1) {
		if (index < nodes.length) visible.add(index);
	}
	const tailStart = Math.max(0, nodes.length - COMPACT_WORKFLOW_NODE_TAIL_COUNT);
	for (let index = tailStart; index < nodes.length; index += 1) visible.add(index);
	for (const [index, node] of nodes.entries()) {
		if (isAttentionNode(node)) visible.add(index);
	}
	const hidden = nodes.filter((_node, index) => !visible.has(index));
	const entries: WorkflowLedgerEntry[] = [];
	let omissionAdded = false;
	for (const [index, node] of nodes.entries()) {
		if (visible.has(index)) {
			entries.push({ kind: "node", node });
		} else if (!omissionAdded) {
			entries.push({ kind: "omission", nodes: hidden });
			omissionAdded = true;
		}
	}
	return entries;
}

function jobComponent(
	projection: JobProjection,
	theme: Theme,
	expanded: boolean,
): Component {
	const state = projection.state;
	const container = new Container();
	container.addChild(new Text(jobTitle(state, theme), 0, 0));
	const entries = workflowLedgerEntries(state.nodes ?? [], expanded);
	let hasOmission = false;
	for (const entry of entries) {
		if (entry.kind === "omission") {
			hasOmission = true;
			const summary = workflowNodeSummary(entry.nodes, false);
			container.addChild(new Text(theme.fg("dim", `  … ${summary}`), 0, 0));
			continue;
		}
		const node = entry.node;
		container.addChild(new Text(nodeLine(node, theme), 0, 0));
		if (expanded) {
			const task = theme.fg("dim", `    task: ${preview(node.task, 240)}`);
			container.addChild(new Text(task, 0, 0));
			if (node.error) {
				const error = theme.fg("error", `    error: ${preview(node.error, 320)}`);
				container.addChild(new Text(error, 0, 0));
			}
			const artifact = projection.nodeArtifacts.find((item) => item.nodeId === node.id);
			if (artifact) {
				container.addChild(new Text(theme.fg("dim", `    report: ${artifact.path}`), 0, 0));
			}
		}
	}
	if (hasOmission && state.nodes) {
		const hint = keyHint("app.tools.expand", `show all ${state.nodes.length} nodes`);
		container.addChild(new Text(theme.fg("dim", `  ${hint}`), 0, 0));
	}
	if (expanded && projection.resultPath) {
		container.addChild(new Text(theme.fg("dim", `  result: ${projection.resultPath}`), 0, 0));
	}
	if (expanded && state.type === "agent") {
		if (state.task) container.addChild(new Text(`  Task: ${state.task}`, 0, 0));
		container.addChild(new Text(theme.fg("dim", `  Cwd: ${state.cwd}`), 0, 0));
		if (state.state === "running" && !state.activity) {
			const hint = `  Live activity: call job_wait for ${state.id}`;
			container.addChild(new Text(theme.fg("dim", hint), 0, 0));
		}
	}
	if (expanded && state.error) {
		container.addChild(new Text(theme.fg("error", `Error: ${state.error}`), 0, 0));
	}
	return container;
}

function jobReceiptComponent(projection: JobProjection, theme: Theme): Component {
	const state = projection.state;
	let text = `${theme.fg("accent", "↗")} `;
	text += theme.fg("toolTitle", theme.bold(state.type));
	text += ` ${theme.fg("accent", shortId(state.id))}`;
	text += theme.fg("muted", ` · ${state.state}`);
	if (state.type === "agent") text += theme.fg("muted", ` · ${state.agent}`);
	return new Text(text, 0, 0);
}

function jobResultComponent(
	projection: JobProjection,
	expanded: boolean,
	theme: Theme,
): Component {
	const container = new Container();
	container.addChild(jobComponent(projection, theme, expanded));
	if (projection.result) {
		container.addChild(new Spacer(1));
		container.addChild(outputComponent(projection.result, expanded, theme));
	}
	return container;
}

function outputComponent(output: string, expanded: boolean, theme: Theme): Component {
	if (expanded) return new Markdown(output, 0, 0, getMarkdownTheme());
	const lines = output.split("\n");
	const shown = lines.slice(0, 5).join("\n");
	let text = theme.fg("toolOutput", shown);
	if (lines.length > 5) text += `\n${theme.fg("dim", `… ${lines.length - 5} more lines`)}`;
	return new Text(text, 0, 0);
}

function truncateJobOutput(text: string): string {
	return truncateUtf8Bytes(
		text,
		WORKFLOW_TOOL_OUTPUT_BYTES_MAX,
		"\n\n[job output truncated]",
	);
}

export function formatJobProjection(projection: JobProjection): string {
	const state = projection.state;
	const lines = [
		`${state.id} ${state.type}/${state.state}`,
		`agent: ${state.agent}`,
		`cwd: ${state.cwd}`,
		`created: ${state.createdAt}`,
		`deadline: ${state.deadlineAt}`,
	];
	if (state.startedAt) lines.push(`started: ${state.startedAt}`);
	if (state.endedAt) lines.push(`ended: ${state.endedAt}`);
	if (state.error) lines.push(`error: ${state.error}`);
	if (state.usage) {
		lines.push(`usage: ${state.usage.totalTokens} tokens, $${state.usage.cost.total.toFixed(6)}`);
	}
	if (projection.resultPath) lines.push(`result: ${projection.resultPath}`);
	if (state.nodes) {
		lines.push(`nodes: ${state.nodes.length}`);
		for (const node of state.nodes) {
			lines.push(`- ${node.id}: ${node.state} (${node.agent})`);
			const artifact = projection.nodeArtifacts.find((item) => item.nodeId === node.id);
			if (artifact) lines.push(`  output: ${artifact.path}`);
		}
	}
	if (projection.result) lines.push("", projection.result);
	return truncateJobOutput(lines.join("\n"));
}

function errorComponent(result: AgentToolResult<unknown>, theme: Theme): Component {
	return new Text(theme.fg("error", textContent(result) || "Tool failed"), 0, 0);
}

export function renderAgentCall(args: AgentRunArgs, theme: Theme): Component {
	const mode = args.background ? "background" : "foreground";
	let text = theme.fg("toolTitle", theme.bold("agent "));
	text += theme.fg("accent", args.agent);
	text += theme.fg("muted", ` • ${mode} • ${args.context ?? "fresh"}`);
	text += `\n  ${theme.fg("dim", preview(args.task, 120))}`;
	return new Text(text, 0, 0);
}

export function renderAgentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.isError) return errorComponent(result, theme);
	if (options.isPartial) {
		return new Text(theme.fg("warning", `… ${textContent(result) || "agent running"}`), 0, 0);
	}
	if (isJobProjection(result.details)) {
		return jobReceiptComponent(result.details, theme);
	}
	if (!isAgentResult(result.details)) {
		return outputComponent(textContent(result), options.expanded, theme);
	}
	const details = result.details;
	const container = new Container();
	let header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(details.agent))}`;
	header += theme.fg("muted", ` • ${duration(details.durationMs)}`);
	if (details.model) header += theme.fg("dim", ` • ${details.model}`);
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(outputComponent(textContent(result), options.expanded, theme));
	return container;
}

export function renderWorkflowCall(args: WorkflowStartArgs, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold("workflow "));
	text += theme.fg("accent", args.context ?? "fresh");
	text += `\n  ${theme.fg("dim", preview(args.goal, 140))}`;
	return new Text(text, 0, 0);
}

export function renderWorkflowResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.isError) return errorComponent(result, theme);
	if (isJobProjection(result.details)) {
		return jobReceiptComponent(result.details, theme);
	}
	return outputComponent(textContent(result), options.expanded, theme);
}

export function renderJobCall(
	action: "cancel" | "status" | "wait",
	args: JobIdArgs,
	theme: Theme,
): Component {
	let text = theme.fg("toolTitle", theme.bold(`job ${action}`));
	text += args.id ? ` ${theme.fg("accent", shortId(args.id))}` : theme.fg("muted", " recent");
	return new Text(text, 0, 0);
}

export function renderJobResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.isError) return errorComponent(result, theme);
	if (isJobProjection(result.details)) {
		return jobResultComponent(result.details, options.expanded, theme);
	}
	const details = result.details as { jobs?: JobProjection[] } | undefined;
	if (!details?.jobs) return outputComponent(textContent(result), options.expanded, theme);
	const args = typeof context.args === "object" && context.args !== null
		? context.args as JobIdArgs
		: undefined;
	const container = new Container();
	for (const projection of details.jobs) {
		const component = args?.id
			? jobResultComponent(projection, options.expanded, theme)
			: new Text(jobTitle(projection.state, theme), 0, 0);
		container.addChild(component);
	}
	if (details.jobs.length === 0) {
		container.addChild(new Text(theme.fg("dim", "No jobs"), 0, 0));
	}
	return container;
}
