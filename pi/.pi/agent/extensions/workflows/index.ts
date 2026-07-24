// Pi agent workflows: run configured Pi agents directly or as bounded, dynamically coordinated
// background jobs. Personal and Linux-only, not a reusable framework.
//
// Assumptions and opinionated choices
// - Agents come only from ~/.pi/agent/agents/, parsed once per load. Edit an agent, then /reload;
//   configuration never adapts mid-run.
// - Tools and access are explicit. Skills are all or none. An omitted model inherits the active
//   parent model at launch; an explicit agent model wins.
// - A workflow snapshots resolved agent policies into immutable request.json and uses only that
//   snapshot until completion. Later agent edits and reloads never affect running work.
// - Fresh/fork context and working-directory overrides are explicit launch choices.
// - Linux-only: ownership and cancellation use process groups and /proc identity. No portability.
//
// Invariants (not obvious from the code)
// - state.json (schema v4) is the sole authoritative lifecycle. telemetry.json is disposable and
//   can never change a lifecycle outcome. Other schemas are rejected, not migrated.
// - Admission, lifecycle transitions, and graph mutation are serialized. Terminal states are
//   monotonic; cancellation intent blocks later success publication.
// - Each detached job owns one Linux process group. Cancellation proves process identity, then
//   escalates SIGTERM to SIGKILL within bounds. liveness.sock only wakes observers; persisted
//   state decides the outcome.
// - Mutation-capable work needs an exclusive writer lease on the canonical workspace. A writer
//   node runs alone and reserves one correctness plus one context-style review; workflow success
//   requires both reviews to return explicit PASS.
// - Every queue, wait, file, scan, graph, and output is bounded (see limits.ts).
// - Final answers live in result.md; per-node detail in nodes/<node-id>.md.
//
// Job layout: ~/.pi/agent/jobs/<job-id>/ holds request.json, state.json, telemetry.json,
// cancellation.json, interruption.json, liveness.sock, stderr.log, result.md, and nodes/<id>.md.
// Flow diagrams live in diagrams/*.mmd.
import { randomUUID } from "node:crypto";
import { realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	parseFrontmatter,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	currentPiInvocation,
	JOB_DIRECTORY_ENV,
	PROCESS_MODE_COORDINATOR,
	PROCESS_MODE_ENV,
	PROCESS_MODE_NODE,
	runAgent,
	type AgentRunResult,
} from "./agent-run.ts";
import { agentWithDefaultModel, discoverAgents, type AgentDefinition, type FrontmatterParser } from "./agents.ts";
import { runWorkflowNodes } from "./graph.ts";
import { cancelJob, observeJob, startAgentJob, startWorkflowJob, waitForJob } from "./job-control.ts";
import {
	listJobStates,
	projectJob,
	pruneJobRecords,
	readJobState,
	resolveJobId,
	type JobProjection,
	type JobState,
} from "./job-store.ts";
import { acquireWriterLease, releaseWriterLease, setWriterLeaseProcessGroup, type WriterLease } from "./leases.ts";
import {
	AGENT_TASK_BYTES_MAX,
	assertLimitInvariants,
	WORKFLOW_FAN_OUT_MAX,
	WORKFLOW_NODE_COUNT_MAX,
	WORKFLOW_NODE_TASK_BYTES_MAX,
} from "./limits.ts";
import { formatActiveJobs, formatJobNotification, formatJobProjection } from "./presentation.ts";
import {
	renderAgentCall,
	renderAgentResult,
	renderJobCall,
	renderJobResult,
	renderWorkflowCall,
	renderWorkflowResult,
} from "./render.ts";

const JOBS_WIDGET_ID = "workflows-active-jobs";
const jobWatchers = new Set<AbortController>();
const watchedJobs = new Map<string, JobProjection>();
const focusedJobs = new Set<string>();

const AgentRunParameters = Type.Object({
	agent: Type.String({ description: "Name of the configured agent" }),
	task: Type.String({
		description: "One bounded task for the agent",
		minLength: 1,
		maxLength: AGENT_TASK_BYTES_MAX,
	}),
	context: Type.Optional(
		StringEnum(["fresh", "fork"] as const, {
			description: "Use fresh context or a launch-time snapshot of the parent conversation.",
			default: "fresh",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Agent working directory" })),
	background: Type.Optional(Type.Boolean({ description: "Detach and return a job ID", default: false })),
});

const WorkflowNodesParameters = Type.Object({
	nodes: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64 }),
			agent: Type.String({ minLength: 1, maxLength: 64 }),
			task: Type.String({ minLength: 1, maxLength: WORKFLOW_NODE_TASK_BYTES_MAX }),
			dependsOn: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
					maxItems: WORKFLOW_NODE_COUNT_MAX,
				}),
			),
		}),
		{ minItems: 1, maxItems: WORKFLOW_FAN_OUT_MAX },
	),
});

const WorkflowStartParameters = Type.Object({
	goal: Type.String({
		description: "Goal for the dynamic workflow",
		minLength: 1,
		maxLength: AGENT_TASK_BYTES_MAX,
	}),
	context: Type.Optional(
		StringEnum(["fresh", "fork"] as const, {
			description: "Use fresh context or a launch-time parent snapshot.",
			default: "fresh",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Workflow working directory" })),
});

const JobStatusParameters = Type.Object({
	id: Type.Optional(
		Type.String({
			description: "Full job ID or unique prefix; omit to list recent jobs",
			minLength: 8,
			maxLength: 36,
		}),
	),
});

const JobWaitParameters = Type.Object({
	id: Type.String({ description: "Full job ID or unique prefix", minLength: 8, maxLength: 36 }),
});

const JobCancelParameters = Type.Object({
	id: Type.String({ description: "Full job ID or unique prefix", minLength: 8, maxLength: 36 }),
});

async function resolveWorkingDirectory(parentCwd: string, requested?: string): Promise<string> {
	const candidate = requested ? (isAbsolute(requested) ? requested : resolve(parentCwd, requested)) : parentCwd;
	const canonical = await realpath(candidate);
	const metadata = await stat(canonical);
	if (!metadata.isDirectory()) throw new Error(`agent cwd is not a directory: ${requested}`);
	return canonical;
}

function createForkedSession(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("fork context requires a persistent parent session");
	const leaf = ctx.sessionManager.getLeafEntry();
	if (!leaf) throw new Error("fork context requires a parent session entry");
	const isLaunchingAssistant = leaf.type === "message" && leaf.message.role === "assistant";
	const snapshotLeafId = isLaunchingAssistant ? leaf.parentId : leaf.id;
	if (!snapshotLeafId) throw new Error("fork context has no safe snapshot point");
	const forkedSession = SessionManager.open(sessionFile).createBranchedSession(snapshotLeafId);
	if (!forkedSession) throw new Error("failed to create forked context snapshot");
	return forkedSession;
}

async function removeForkedSession(sessionFile: string): Promise<void> {
	try {
		await unlink(sessionFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function activeModelSpecifier(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

interface PreparedAgentRun {
	agent: AgentDefinition;
	cwd: string;
	sessionFile?: string;
}

async function prepareAgentRun(
	ctx: ExtensionContext,
	agents: AgentDefinition[],
	input: { agent: string; context?: "fresh" | "fork"; cwd?: string },
): Promise<PreparedAgentRun> {
	const configuredAgent = agents.find((candidate) => candidate.name === input.agent);
	if (!configuredAgent) {
		const available = agents.map((candidate) => candidate.name).join(", ") || "none";
		throw new Error(`unknown agent ${input.agent}; available agents: ${available}`);
	}
	const agent = agentWithDefaultModel(configuredAgent, activeModelSpecifier(ctx));
	const cwd = await resolveWorkingDirectory(ctx.cwd, input.cwd);
	const sessionFile = input.context === "fork" ? createForkedSession(ctx) : undefined;
	return { agent, cwd, sessionFile };
}

async function runForegroundAgent(
	prepared: PreparedAgentRun,
	task: string,
	signal: AbortSignal | undefined,
	onActivity: (activity: string) => void,
): Promise<AgentRunResult> {
	let lease: WriterLease | undefined;
	try {
		if (prepared.agent.access === "write") {
			lease = await acquireWriterLease(
				join(getAgentDir(), "writer-leases"),
				prepared.cwd,
				`foreground:${randomUUID()}`,
				{ protectDescendants: true },
			);
		}
		return await runAgent({
			invocation: currentPiInvocation(),
			agent: prepared.agent,
			task,
			cwd: prepared.cwd,
			sessionFile: prepared.sessionFile,
			signal,
			writerOwnerId: lease?.ownerId,
			onProcessGroup: lease
				? async (processGroupId) => {
						lease = await setWriterLeaseProcessGroup(lease!, processGroupId);
					}
				: undefined,
			onUpdate: (update) => {
				const activity = update.tool ? `${prepared.agent.name}: ${update.tool}` : prepared.agent.name;
				onActivity(activity);
			},
		});
	} finally {
		try {
			if (lease) await releaseWriterLease(lease);
		} finally {
			if (prepared.sessionFile) await removeForkedSession(prepared.sessionFile);
		}
	}
}

async function startBackgroundAgent(prepared: PreparedAgentRun, task: string): Promise<JobState> {
	try {
		return await startAgentJob({
			jobsRoot: join(getAgentDir(), "jobs"),
			cwd: prepared.cwd,
			task,
			agent: prepared.agent,
			invocation: currentPiInvocation(),
			sessionFile: prepared.sessionFile,
		});
	} catch (error) {
		if (prepared.sessionFile) await removeForkedSession(prepared.sessionFile);
		throw error;
	}
}

async function startBackgroundWorkflow(
	ctx: ExtensionContext,
	catalog: AgentDefinition[],
	input: { goal: string; context?: "fresh" | "fork"; cwd?: string },
): Promise<JobState> {
	const cwd = await resolveWorkingDirectory(ctx.cwd, input.cwd);
	const model = activeModelSpecifier(ctx);
	const agents = catalog.map((agent) => agentWithDefaultModel(agent, model));
	if (agents.length === 0) throw new Error("workflow requires at least one configured agent");
	const sessionFile = input.context === "fork" ? createForkedSession(ctx) : undefined;
	try {
		return await startWorkflowJob({
			jobsRoot: join(getAgentDir(), "jobs"),
			cwd,
			goal: input.goal,
			agents,
			invocation: currentPiInvocation(),
			sessionFile,
			model,
		});
	} catch (error) {
		if (sessionFile) await removeForkedSession(sessionFile);
		throw error;
	}
}

function refreshJobsWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const visible = [...watchedJobs.values()].filter(({ state }) => !focusedJobs.has(state.id));
	ctx.ui.setWidget(JOBS_WIDGET_ID, formatActiveJobs(visible));
}

function beginJobFocus(id: string, ctx: ExtensionContext): void {
	focusedJobs.add(id);
	refreshJobsWidget(ctx);
}

function endJobFocus(id: string, ctx: ExtensionContext): void {
	if (!focusedJobs.delete(id)) return;
	refreshJobsWidget(ctx);
}

function watchJob(id: string, ctx: ExtensionContext): void {
	const jobsRoot = join(getAgentDir(), "jobs");
	const controller = new AbortController();
	jobWatchers.add(controller);
	void waitForJob(jobsRoot, id, controller.signal, (state) => {
		watchedJobs.set(id, projectJob(jobsRoot, state));
		refreshJobsWidget(ctx);
	})
		.then(async (state) => {
			const level = state.state === "succeeded" ? "info" : "warning";
			ctx.ui.notify(formatJobNotification(state), level);
			try {
				await pruneJobRecords(jobsRoot);
			} catch (error) {
				ctx.ui.notify(`Cannot prune old jobs: ${String(error)}`, "warning");
			}
		})
		.catch((error: unknown) => {
			if (!controller.signal.aborted) {
				ctx.ui.notify(`Cannot watch job ${id}: ${String(error)}`, "warning");
			}
		})
		.finally(() => {
			jobWatchers.delete(controller);
			watchedJobs.delete(id);
			refreshJobsWidget(ctx);
		});
}

function registerAgentTool(pi: ExtensionAPI, agents: AgentDefinition[]): void {
	pi.registerTool({
		name: "agent_run",
		label: "Agent",
		description: "Run one configured agent in an isolated Pi process, foreground or background.",
		promptSnippet: "Run one focused configured agent with isolated conversation context",
		promptGuidelines: [
			"Use agent_run for focused delegation, independent review, research, or implementation.",
			"Multiple independent agent_run calls may be emitted together for parallel execution.",
		],
		parameters: AgentRunParameters,
		renderCall: renderAgentCall,
		renderResult: renderAgentResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const prepared = await prepareAgentRun(ctx, agents, params);
			if (params.background) {
				const state = await startBackgroundAgent(prepared, params.task);
				watchJob(state.id, ctx);
				return {
					content: [{ type: "text", text: `Started agent job ${state.id}` }],
					details: projectJob(join(getAgentDir(), "jobs"), state),
				};
			}
			const result = await runForegroundAgent(prepared, params.task, signal, (activity) => {
				onUpdate?.({
					content: [{ type: "text", text: activity }],
					details: { agent: prepared.agent.name, activity },
				});
			});
			return {
				content: [{ type: "text", text: result.output }],
				usage: result.usage,
				details: {
					agent: prepared.agent.name,
					access: prepared.agent.access,
					cwd: prepared.cwd,
					durationMs: result.durationMs,
					model: result.model,
					stopReason: result.stopReason,
				},
			};
		},
	});
}

function registerWorkflowNodesTool(pi: ExtensionAPI, jobDir: string): void {
	pi.registerTool({
		name: "workflow_nodes",
		label: "Workflow Nodes",
		description: "Run ready workflow nodes with explicit succeeded dependencies.",
		parameters: WorkflowNodesParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const result = await runWorkflowNodes(jobDir, params.nodes, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: { nodes: result.nodes },
			};
		},
	});
}

function registerWorkflowStartTool(pi: ExtensionAPI, agents: AgentDefinition[]): void {
	pi.registerTool({
		name: "workflow_start",
		label: "Workflow",
		description: "Start a detached coordinator that builds a bounded dynamic workflow.",
		promptSnippet: "Start a background multi-agent workflow for a complex goal",
		promptGuidelines: [
			"A workflow runs detached and cannot ask questions once started; resolve blocking scope, product, and ambiguity questions with the user first.",
			"Fold the user's answers and any fixed constraints into the goal before launching.",
		],
		parameters: WorkflowStartParameters,
		renderCall: renderWorkflowCall,
		renderResult: renderWorkflowResult,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await startBackgroundWorkflow(ctx, agents, params);
			watchJob(state.id, ctx);
			return {
				content: [{ type: "text", text: `Started workflow job ${state.id}` }],
				details: projectJob(join(getAgentDir(), "jobs"), state),
			};
		},
	});
}

function registerJobStatusTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "job_status",
		label: "Job Status",
		description: "Inspect one background job or list recent jobs.",
		parameters: JobStatusParameters,
		renderCall: (args, theme) => renderJobCall("status", args, theme),
		renderResult: renderJobResult,
		async execute(_toolCallId, params) {
			const jobsRoot = join(getAgentDir(), "jobs");
			if (params.id) {
				const id = await resolveJobId(jobsRoot, params.id);
				const state = await readJobState(jobsRoot, id);
				const projection = await observeJob(jobsRoot, state, true);
				return {
					content: [{ type: "text", text: formatJobProjection(projection) }],
					details: { jobs: [projection] },
				};
			}
			const states = await listJobStates(jobsRoot);
			const projections = await Promise.all(states.map((state) => observeJob(jobsRoot, state, false)));
			const summaries = projections.map(formatJobProjection);
			const text = summaries.length ? summaries.join("\n\n") : "No background jobs.";
			return { content: [{ type: "text", text }], details: { jobs: projections } };
		},
	});
}

function registerJobWaitTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "job_wait",
		label: "Wait for Job",
		description: "Wait until one bounded background job reaches a terminal state.",
		parameters: JobWaitParameters,
		renderCall: (args, theme) => renderJobCall("wait", args, theme),
		renderResult: renderJobResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const jobsRoot = join(getAgentDir(), "jobs");
			const id = await resolveJobId(jobsRoot, params.id);
			beginJobFocus(id, ctx);
			try {
				const state = await waitForJob(jobsRoot, id, signal, (update) => {
					onUpdate?.({
						content: [{ type: "text", text: `Waiting for job ${id}` }],
						details: projectJob(jobsRoot, update),
					});
				});
				if (watchedJobs.has(id)) {
					watchedJobs.set(id, projectJob(jobsRoot, state));
				}
				const projection = await observeJob(jobsRoot, state, true);
				return {
					content: [{ type: "text", text: formatJobProjection(projection) }],
					details: projection,
				};
			} finally {
				endJobFocus(id, ctx);
			}
		},
	});
}

function registerJobCancelTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "job_cancel",
		label: "Cancel Job",
		description: "Cancel one owned background job.",
		parameters: JobCancelParameters,
		renderCall: (args, theme) => renderJobCall("cancel", args, theme),
		renderResult: renderJobResult,
		async execute(_toolCallId, params) {
			const jobsRoot = join(getAgentDir(), "jobs");
			const id = await resolveJobId(jobsRoot, params.id);
			const state = await cancelJob(jobsRoot, id);
			const projection = await observeJob(jobsRoot, state, false);
			return {
				content: [{ type: "text", text: formatJobProjection(projection) }],
				details: projection,
			};
		},
	});
}

export default function workflowsExtension(pi: ExtensionAPI): void {
	assertLimitInvariants();
	const mode = process.env[PROCESS_MODE_ENV];
	if (mode === PROCESS_MODE_NODE) return;
	if (mode === PROCESS_MODE_COORDINATOR) {
		const jobDir = process.env[JOB_DIRECTORY_ENV];
		if (!jobDir) throw new Error("coordinator mode requires a job directory");
		registerWorkflowNodesTool(pi, jobDir);
		return;
	}
	if (mode) throw new Error(`unknown workflows process mode: ${mode}`);
	const agents = discoverAgents(join(getAgentDir(), "agents"), parseFrontmatter as FrontmatterParser);
	registerAgentTool(pi, agents);
	registerWorkflowStartTool(pi, agents);
	registerJobStatusTool(pi);
	registerJobWaitTool(pi);
	registerJobCancelTool(pi);
	pi.on("session_shutdown", (_event, ctx) => {
		for (const controller of jobWatchers) controller.abort();
		jobWatchers.clear();
		watchedJobs.clear();
		focusedJobs.clear();
		if (ctx.hasUI) ctx.ui.setWidget(JOBS_WIDGET_ID, undefined);
	});
}
