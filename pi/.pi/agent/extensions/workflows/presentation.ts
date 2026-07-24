// Plain-text job formatting. This module must not import @earendil-works/pi-coding-agent or
// pi-tui: render.ts owns everything that needs a Theme or a Component, and keeping this side
// dependency-free is what lets tests and any non-TUI caller import these formatters directly.
import { truncateUtf8Bytes } from "./agent-run.ts";
import type { JobProjection, JobState, WorkflowNodeState } from "./job-store.ts";
import {
	JOB_NOTIFICATION_BYTES_MAX,
	JOB_WIDGET_LINE_COUNT_MAX,
	JOB_WIDGET_NODE_COUNT_MAX,
	WORKFLOW_TOOL_OUTPUT_BYTES_MAX,
} from "./limits.ts";

export function shortId(id: string): string {
	return id.slice(0, 8);
}

export function duration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	return `${(durationMs / 60_000).toFixed(1)}m`;
}

export function tokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

export function workflowNodeSummary(nodes: readonly WorkflowNodeState[], includeKnown: boolean): string {
	const counts = { succeeded: 0, running: 0, pending: 0, failed: 0, cancelled: 0 };
	for (const node of nodes) counts[node.state] += 1;
	const parts: string[] = [];
	if (includeKnown) parts.push(`${nodes.length} known`);
	if (counts.succeeded > 0) parts.push(`${counts.succeeded} done`);
	if (counts.running > 0) parts.push(`${counts.running} active`);
	if (counts.pending > 0) parts.push(`${counts.pending} pending`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
	return parts.join(" · ");
}

function activeNodeLine(node: WorkflowNodeState): string {
	const parts = [`  ● ${node.id}`, node.agent];
	if (node.activity) parts.push(node.activity);
	if (node.toolCount) parts.push(`${node.toolCount} tools`);
	if (node.usage?.totalTokens) parts.push(`${tokenCount(node.usage.totalTokens)} tok`);
	return parts.join(" · ");
}

function activeJobLines(projection: JobProjection): string[] {
	const state = projection.state;
	const mark = state.state === "running" ? "●" : "○";
	if (state.type === "workflow") {
		const nodes = state.nodes ?? [];
		const running = nodes.filter((node) => node.state === "running");
		const header = [`${mark} ${shortId(state.id)} workflow`, workflowNodeSummary(nodes, true)]
			.filter(Boolean)
			.join(" · ");
		const visible = running.slice(0, JOB_WIDGET_NODE_COUNT_MAX).map(activeNodeLine);
		if (running.length > visible.length) {
			visible.push(`  … ${running.length - visible.length} more active nodes`);
		}
		return [header, ...visible];
	}
	const parts = [`${mark} ${shortId(state.id)} ${state.agent}`];
	if (state.activity) parts.push(state.activity);
	if (state.toolCount) parts.push(`${state.toolCount} tools`);
	if (state.usage?.totalTokens) parts.push(`${tokenCount(state.usage.totalTokens)} tok`);
	return [parts.join(" · ")];
}

export function formatActiveJobs(projections: readonly JobProjection[]): string[] | undefined {
	const active = projections
		.filter(({ state }) => state.state === "queued" || state.state === "running")
		.sort((left, right) => left.state.createdAt.localeCompare(right.state.createdAt));
	if (active.length === 0) return undefined;
	const lines = [`Background jobs (${active.length})`];
	let renderedCount = 0;
	for (const projection of active) {
		const jobLines = activeJobLines(projection);
		const reserve = renderedCount + 1 < active.length ? 1 : 0;
		if (lines.length + jobLines.length + reserve > JOB_WIDGET_LINE_COUNT_MAX) break;
		lines.push(...jobLines);
		renderedCount += 1;
	}
	if (renderedCount < active.length) {
		lines.push(`… ${active.length - renderedCount} more jobs`);
	}
	return lines;
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
	return truncateUtf8Bytes(lines.join("\n"), WORKFLOW_TOOL_OUTPUT_BYTES_MAX, "\n\n[job output truncated]");
}

export function formatJobNotification(state: JobState): string {
	const parts = [`Job ${shortId(state.id)} ${state.state}`];
	if (state.startedAt && state.endedAt) {
		parts.push(duration(Date.parse(state.endedAt) - Date.parse(state.startedAt)));
	}
	if (state.usage) parts.push(`$${state.usage.cost.total.toFixed(3)}`);
	if (state.error) parts.push(state.error.replace(/\s+/g, " ").trim());
	return truncateUtf8Bytes(parts.join(" · "), JOB_NOTIFICATION_BYTES_MAX, "…");
}
