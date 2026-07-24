// Detached job runner: owns the job's state, liveness socket, writer lease, and process group, and
// publishes exactly one terminal outcome. A pending cancellation intent always wins over success.
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CANCELLATION_ERROR,
	errorText,
	runAgent,
	USAGE_COST_KEYS,
	USAGE_COUNT_KEYS,
	USAGE_OPTIONAL_KEYS,
	type AgentRunResult,
	type AgentRunUpdate,
	type AgentUsage,
} from "./agent-run.ts";
import type { AgentDefinition } from "./agents.ts";
import {
	isTerminalJobState,
	readJobCancellation,
	readJobRequest,
	readJobStateAt,
	transitionJobState,
	JOB_SCHEMA_VERSION,
	writeJobTelemetry,
	writeJobResult,
	type AgentJobRequest,
	type JobRequest,
	type JobState,
	type WorkflowJobRequest,
} from "./job-store.ts";
import { assertWorkflowReviews } from "./graph.ts";
import { acquireWriterLease, releaseWriterLease } from "./leases.ts";
import { LatestPulseWriter } from "./pulse.ts";
import { WORKFLOW_TIMEOUT_MS } from "./limits.ts";
import {
	listenForJobLiveness,
	processGroupId,
	processToken,
	terminateEnvironmentMarkerProcesses,
	terminateProcessGroupMembers,
	WRITER_OWNER_ENV,
	type JobLivenessServer,
} from "./processes.ts";

const COORDINATOR_PROMPT = `You coordinate a bounded dynamic workflow.
Use workflow_nodes to delegate all implementation, research, review, and synthesis work.
Node IDs must be unique. Dependencies must name already-succeeded nodes.
Submit independent nodes together for fan-out. Add successors after inspecting results.
Represent retries and loop iterations as new node IDs. Stop early when the goal is satisfied.
Choose the fewest nodes that can satisfy the goal. Before a bounded implementation, launch a scout
only when scope is unknown, its report will feed multiple successors, or independent investigation
is required. Then run one planner node that depends on any scout or researcher nodes and produces
the implementation plan; every write node must depend on that plan node. Read-only goals need no plan.
Start exactly one write node. Its task must require a pre-edit deletion test, a direct/simple design
choice, and a post-edit deletion pass. After it succeeds, submit correctness-reviewer and
context-style-reviewer together. Both must depend on that write node. Context-style-reviewer must
perform the deletion-first simplicity review. Accept only when both return explicit PASS.
For a FAIL that names a concrete defect, add one write node that depends on both reports, then run
both reviewers again with dependencies on the fix. Stop on any other non-PASS outcome. Never accept
an unreviewed write or treat a fix report as acceptance.
Finish with one self-contained final report grounded in node results. Include the conclusion,
actionable findings, concrete evidence and file references, remaining uncertainty, and next steps.
Do not create an artifact index; the runner appends verified links to successful node reports.`;

function coordinatorAgent(request: WorkflowJobRequest): AgentDefinition {
	const catalog = request.agents.map((agent) => `- ${agent.name} (${agent.access}): ${agent.description}`).join("\n");
	return {
		name: "workflow-coordinator",
		description: "Coordinates a dynamic agent workflow",
		model: request.model,
		tools: ["workflow_nodes"],
		access: "read",
		skills: "none",
		systemPrompt: `${COORDINATOR_PROMPT}\n\nAvailable agents:\n${catalog}`,
		systemPromptMode: "append",
	};
}

function aggregateUsage(result: AgentRunResult, state: JobState): AgentUsage {
	const total = structuredClone(result.usage);
	for (const node of state.nodes ?? []) {
		if (node.state !== "succeeded" || !node.usage) continue;
		for (const key of USAGE_COUNT_KEYS) {
			total[key] += node.usage[key];
		}
		for (const key of USAGE_OPTIONAL_KEYS) {
			total[key] = (total[key] ?? 0) + (node.usage[key] ?? 0);
		}
		for (const key of USAGE_COST_KEYS) {
			total.cost[key] += node.usage.cost[key];
		}
	}
	return total;
}

async function removeSessionFile(path?: string): Promise<void> {
	if (!path) return;
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function writeAgentProgress(jobDir: string, update: AgentRunUpdate): Promise<void> {
	const state = await readJobStateAt(jobDir);
	if (state.state !== "running") return;
	// A single-agent job has no nodes, so the pulse is built directly rather than projected
	// out of a whole state.
	await writeJobTelemetry(jobDir, {
		version: JOB_SCHEMA_VERSION,
		id: state.id,
		activity: update.tool ?? "thinking",
		toolCount: update.toolCount,
		usage: update.usage,
	});
}

async function drainRunnerProcessGroup(): Promise<void> {
	await terminateProcessGroupMembers(await processGroupId(), [process.pid]);
}

async function runDirectAgent(request: AgentJobRequest, jobDir: string, signal: AbortSignal): Promise<AgentRunResult> {
	const lease = request.writerLeaseRoot
		? await acquireWriterLease(request.writerLeaseRoot, request.cwd, request.id, {
				protectDescendants: true,
				processGroupId: await processGroupId(),
			})
		: undefined;
	const pulseWriter = new LatestPulseWriter<AgentRunUpdate>({
		write: (update) => writeAgentProgress(jobDir, update),
	});
	try {
		return await runAgent({
			invocation: request.invocation,
			agent: request.agent,
			task: request.task,
			cwd: request.cwd,
			sessionFile: request.sessionFile,
			signal,
			isolateProcessGroup: false,
			writerOwnerId: lease?.ownerId,
			onUpdate: (update) => pulseWriter.submit(update),
		});
	} finally {
		await pulseWriter.flush();
		await drainRunnerProcessGroup();
		if (lease) {
			await terminateEnvironmentMarkerProcesses(WRITER_OWNER_ENV, lease.ownerId, {
				excludedProcessIds: [process.pid, process.ppid],
				ownedProcessGroup: lease.processGroupId,
			});
			await releaseWriterLease(lease);
		}
	}
}

async function runWorkflow(request: WorkflowJobRequest, jobDir: string, signal: AbortSignal): Promise<AgentRunResult> {
	try {
		return await runAgent({
			invocation: request.invocation,
			agent: coordinatorAgent(request),
			task: request.goal,
			cwd: request.cwd,
			sessionFile: request.sessionFile,
			signal,
			processMode: "coordinator",
			jobDirectory: jobDir,
			timeoutMs: WORKFLOW_TIMEOUT_MS,
			isolateProcessGroup: false,
		});
	} finally {
		await drainRunnerProcessGroup();
	}
}

function executeJob(request: JobRequest, jobDir: string, signal: AbortSignal): Promise<AgentRunResult> {
	return request.type === "agent" ? runDirectAgent(request, jobDir, signal) : runWorkflow(request, jobDir, signal);
}

async function recordFailure(jobDir: string, error: unknown, cancelled: boolean, sessionFile?: string): Promise<void> {
	let message = errorText(error);
	try {
		await writeFile(join(jobDir, "stderr.log"), message, { encoding: "utf8", mode: 0o600 });
	} catch (diagnosticError) {
		message = errorText(`${message}; diagnostic log failed: ${errorText(diagnosticError)}`);
	}
	try {
		await removeSessionFile(sessionFile);
	} catch (cleanupError) {
		message = `${message}; cleanup failed: ${errorText(cleanupError)}`;
		cancelled = false;
	}
	const latest = await readJobStateAt(jobDir);
	cancelled ||= Boolean(await readJobCancellation(jobDir, latest));
	await transitionJobState(jobDir, {
		...latest,
		state: cancelled ? "cancelled" : "failed",
		endedAt: new Date().toISOString(),
		error: message,
	});
	if (!cancelled) process.exitCode = 1;
}

async function recordSuccess(request: JobRequest, jobDir: string, result: AgentRunResult): Promise<void> {
	const latest = await readJobStateAt(jobDir);
	if (await readJobCancellation(jobDir, latest)) {
		await removeSessionFile(request.sessionFile);
		await transitionJobState(jobDir, {
			...latest,
			state: "cancelled",
			endedAt: new Date().toISOString(),
			error: CANCELLATION_ERROR,
		});
		return;
	}
	if (request.type === "workflow") {
		await assertWorkflowReviews(jobDir, latest, request.agents);
	}
	await writeJobResult(jobDir, result.output, latest);
	await removeSessionFile(request.sessionFile);
	await transitionJobState(jobDir, {
		...latest,
		state: "succeeded",
		endedAt: new Date().toISOString(),
		usage: request.type === "workflow" ? aggregateUsage(result, latest) : result.usage,
	});
}

async function runBackgroundJob(jobDir: string): Promise<void> {
	const request = await readJobRequest(jobDir);
	process.title = `pi-agent-job:${request.id}`;
	const controller = new AbortController();
	let cancelled = false;
	let liveness: JobLivenessServer | undefined;
	const cancel = () => {
		cancelled = true;
		controller.abort();
	};
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const token = await processToken(process.pid);
		liveness = await listenForJobLiveness(jobDir, token);
		const queued = await readJobStateAt(jobDir);
		await transitionJobState(jobDir, {
			...queued,
			state: "running",
			startedAt: new Date().toISOString(),
			pid: process.pid,
			processToken: token,
		});
		const signal = AbortSignal.any([controller.signal, liveness.signal]);
		const result = await executeJob(request, jobDir, signal);
		await recordSuccess(request, jobDir, result);
	} catch (error) {
		const latest = await readJobStateAt(jobDir);
		if (isTerminalJobState(latest.state)) throw error;
		const livenessFailed = liveness?.signal.aborted ?? false;
		const failure = livenessFailed ? liveness?.signal.reason : error;
		await recordFailure(jobDir, failure, cancelled && !livenessFailed, request.sessionFile);
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
		if (liveness) await liveness.close();
	}
}

const jobDir = process.argv[2];
if (!jobDir) throw new Error("background job requires a job directory");
await runBackgroundJob(jobDir);
