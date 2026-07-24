import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, watch } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiInvocation } from "./agent-run.ts";
import type { AgentDefinition } from "./agents.ts";
import {
	claimJobCancellation,
	createJobRecord,
	isTerminalJobState,
	JOB_SCHEMA_VERSION,
	jobDirectoryPath,
	projectJob,
	pruneJobRecords,
	readJobProjection,
	readJobState,
	reconcileInterruptedJobState,
	transitionJobState,
	type AgentJobRequest,
	type JobProjection,
	type JobState,
	type WorkflowJobRequest,
} from "./job-store.ts";
import {
	acquireWriterLease,
	releaseWriterLease,
	waitForWriterLeaseRelease,
	WriterLeaseBusyError,
} from "./leases.ts";
import {
	AGENT_TIMEOUT_MS,
	JOB_DIRECTORY_SCAN_COUNT_MAX,
	JOB_LAUNCH_LEASE_ATTEMPT_COUNT_MAX,
	JOB_LIVENESS_HANDSHAKE_TIMEOUT_MS,
	JOB_START_TIMEOUT_MS,
	TERMINATE_GRACE_MS,
	WORKFLOW_TIMEOUT_MS,
} from "./limits.ts";
import {
	assertJobLivenessPath,
	assertProcessGroupLeader,
	connectToJobLiveness,
	JobLivenessError,
	processIsRunning,
	processToken,
	processTokenMatches,
	type JobLivenessMonitor,
} from "./processes.ts";

const RUNNER_PATH = fileURLToPath(new URL("./background-agent.ts", import.meta.url));

export interface StartAgentJobOptions {
	jobsRoot: string;
	cwd: string;
	task: string;
	agent: AgentDefinition;
	invocation: PiInvocation;
	sessionFile?: string;
}

export interface StartWorkflowJobOptions {
	jobsRoot: string;
	cwd: string;
	goal: string;
	agents: AgentDefinition[];
	invocation: PiInvocation;
	sessionFile?: string;
	model?: string;
}

interface SpawnEvidence {
	pid?: number;
	token?: string;
	error?: Error;
	errorController: AbortController;
}

function jobDeadline(createdAt: string, executionTimeoutMs: number): string {
	const supervisionMs = JOB_START_TIMEOUT_MS + executionTimeoutMs + TERMINATE_GRACE_MS;
	return new Date(Date.parse(createdAt) + supervisionMs).toISOString();
}

async function acquireJobLaunchLease(
	root: string,
	jobsRoot: string,
	ownerId: string,
) {
	const deadlineMs = Date.now() + JOB_START_TIMEOUT_MS;
	for (let attempt = 0; attempt < JOB_LAUNCH_LEASE_ATTEMPT_COUNT_MAX; attempt += 1) {
		try {
			return await acquireWriterLease(root, jobsRoot, ownerId);
		} catch (error) {
			if (!(error instanceof WriterLeaseBusyError)) throw error;
			await waitForWriterLeaseRelease(root, jobsRoot, deadlineMs);
		}
	}
	throw new WriterLeaseBusyError("job launch lease attempt limit exceeded");
}

async function createJobRecordWithCapacity(
	jobsRoot: string,
	request: AgentJobRequest | WorkflowJobRequest,
	state: JobState,
): Promise<void> {
	await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
	const lease = await acquireJobLaunchLease(
		join(dirname(jobsRoot), "job-launch-leases"),
		jobsRoot,
		`job-launch:${request.id}`,
	);
	try {
		await pruneJobRecords(jobsRoot);
		if ((await readdir(jobsRoot)).length >= JOB_DIRECTORY_SCAN_COUNT_MAX) {
			throw new Error("job directory limit reached; remove active jobs before launching another");
		}
		await createJobRecord(jobsRoot, request, state);
	} finally {
		await releaseWriterLease(lease);
	}
}

async function createJob(
	jobsRoot: string,
	request: AgentJobRequest | WorkflowJobRequest,
	state: JobState,
): Promise<JobState> {
	const jobDir = jobDirectoryPath(jobsRoot, request.id);
	assertJobLivenessPath(jobDir);
	await createJobRecordWithCapacity(jobsRoot, request, state);
	const child = spawn(process.execPath, ["--experimental-strip-types", RUNNER_PATH, jobDir], {
		detached: true,
		shell: false,
		stdio: "ignore",
	});
	const evidence: SpawnEvidence = {
		pid: child.pid,
		errorController: new AbortController(),
	};
	child.once("error", (error) => {
		evidence.error = error;
		evidence.errorController.abort();
	});
	child.unref();
	if (child.pid) {
		try {
			evidence.token = await processToken(child.pid);
		} catch (error) {
			evidence.error = error as Error;
			evidence.errorController.abort();
		}
	}
	return waitForJobStart(jobsRoot, request.id, evidence);
}

export async function startAgentJob(options: StartAgentJobOptions): Promise<JobState> {
	const id = randomUUID();
	const createdAt = new Date().toISOString();
	const request: AgentJobRequest = {
		version: JOB_SCHEMA_VERSION,
		id,
		type: "agent",
		createdAt,
		cwd: options.cwd,
		task: options.task,
		agent: structuredClone(options.agent),
		invocation: options.invocation,
		sessionFile: options.sessionFile,
		writerLeaseRoot: options.agent.access === "write"
			? join(dirname(options.jobsRoot), "writer-leases")
			: undefined,
	};
	const state: JobState = {
		version: JOB_SCHEMA_VERSION, id, type: "agent", state: "queued", createdAt,
		deadlineAt: jobDeadline(createdAt, AGENT_TIMEOUT_MS),
		agent: options.agent.name, cwd: options.cwd, task: options.task,
	};
	return createJob(options.jobsRoot, request, state);
}

export async function startWorkflowJob(options: StartWorkflowJobOptions): Promise<JobState> {
	const id = randomUUID();
	const createdAt = new Date().toISOString();
	const request: WorkflowJobRequest = {
		version: JOB_SCHEMA_VERSION,
		id,
		type: "workflow",
		createdAt,
		cwd: options.cwd,
		goal: options.goal,
		agents: structuredClone(options.agents),
		invocation: options.invocation,
		sessionFile: options.sessionFile,
		model: options.model,
	};
	const state: JobState = {
		version: JOB_SCHEMA_VERSION, id, type: "workflow", state: "queued", createdAt,
		deadlineAt: jobDeadline(createdAt, WORKFLOW_TIMEOUT_MS),
		agent: "workflow-coordinator", cwd: options.cwd, task: options.goal, nodes: [],
	};
	return createJob(options.jobsRoot, request, state);
}

async function failQueuedStart(
	jobsRoot: string,
	id: string,
	evidence: SpawnEvidence,
	message: string,
): Promise<JobState> {
	const state = await readJobState(jobsRoot, id);
	if (state.state !== "queued") return state;
	const jobDir = jobDirectoryPath(jobsRoot, id);
	try {
		await transitionJobState(jobDir, {
			...state,
			state: "failed",
			endedAt: new Date().toISOString(),
			error: message,
		});
	} catch (error) {
		const latest = await readJobState(jobsRoot, id);
		if (latest.state !== "queued") return latest;
		throw error;
	}
	if (evidence.pid && evidence.token) {
		if (await processTokenMatches(evidence.pid, evidence.token)) {
			try {
				await signalOwnedProcessGroup(jobDir, evidence.pid, evidence.token, "SIGTERM");
			} catch (error) {
				if (await processTokenMatches(evidence.pid, evidence.token)) throw error;
			}
		}
	}
	return readJobState(jobsRoot, id);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function* observeJobStates(
	jobsRoot: string,
	id: string,
	deadlineMs: number,
	signal?: AbortSignal,
): AsyncGenerator<JobState> {
	const timeoutSignal = AbortSignal.timeout(Math.max(1, deadlineMs - Date.now()));
	const watchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const watcher = watch(jobDirectoryPath(jobsRoot, id), { signal: watchSignal });
	try {
		yield await readJobState(jobsRoot, id);
		for await (const event of watcher) {
			if (event.filename && !["state.json", "telemetry.json"].includes(event.filename)) {
				continue;
			}
			yield await readJobState(jobsRoot, id);
		}
	} catch (error) {
		if (!isAbortError(error)) throw error;
		if (signal?.aborted) throw new Error("job observation aborted");
	} finally {
		await watcher.return?.();
	}
}

async function waitForJobStart(
	jobsRoot: string,
	id: string,
	evidence: SpawnEvidence,
): Promise<JobState> {
	try {
		const deadlineMs = Date.now() + JOB_START_TIMEOUT_MS;
		for await (const state of observeJobStates(
			jobsRoot,
			id,
			deadlineMs,
			evidence.errorController.signal,
		)) {
			if (state.state !== "queued") return state;
		}
	} catch (error) {
		if (!evidence.error) throw error;
	}
	const reason = evidence.error?.message ?? "startup timed out";
	const failed = await failQueuedStart(jobsRoot, id, evidence, reason);
	if (failed.state !== "failed") return failed;
	throw new Error(`background job ${id} failed to start: ${reason}`);
}

async function jobProcessMatches(state: JobState): Promise<boolean> {
	if (!state.pid || !state.processToken) return false;
	return processTokenMatches(state.pid, state.processToken);
}

async function reconcileInterruptedJob(
	jobsRoot: string,
	id: string,
): Promise<JobState> {
	const state = await readJobState(jobsRoot, id);
	if (isTerminalJobState(state.state)) return state;
	if (state.state !== "running") throw new Error(`job ${id} has no running process`);
	if (await jobProcessMatches(state)) {
		throw new Error(`job ${id} liveness channel closed while its process is running`);
	}
	return reconcileInterruptedJobState(
		jobDirectoryPath(jobsRoot, id),
		"job runner exited without a terminal state",
	);
}

export async function observeJob(
	jobsRoot: string,
	state: JobState,
	includeResult: boolean,
): Promise<JobProjection> {
	const observed = state.state === "running" && !(await jobProcessMatches(state))
		? await reconcileInterruptedJob(jobsRoot, state.id)
		: state;
	return includeResult
		? readJobProjection(jobsRoot, observed.id, true)
		: projectJob(jobsRoot, observed);
}

async function connectWaitMonitor(
	jobsRoot: string,
	state: JobState,
	deadlineMs: number,
	signal?: AbortSignal,
): Promise<JobLivenessMonitor> {
	if (state.state !== "running" || !state.pid || !state.processToken) {
		throw new Error(`job ${state.id} has no running process`);
	}
	const handshakeDeadlineMs = Math.min(
		deadlineMs,
		Date.now() + JOB_LIVENESS_HANDSHAKE_TIMEOUT_MS,
	);
	const timeoutSignal = AbortSignal.timeout(Math.max(1, handshakeDeadlineMs - Date.now()));
	const connectSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		return await connectToJobLiveness(
			jobDirectoryPath(jobsRoot, state.id),
			state.pid,
			state.processToken,
			connectSignal,
		);
	} catch (error) {
		if (signal?.aborted) throw new Error("job wait aborted");
		if (timeoutSignal.aborted) {
			throw new JobLivenessError(
				"channel-unavailable",
				`job ${state.id} liveness handshake timed out`,
			);
		}
		throw error;
	}
}

async function waitForJobUntil(
	jobsRoot: string,
	id: string,
	deadlineMs: number,
	signal?: AbortSignal,
	onStateChange?: (state: JobState) => void,
): Promise<JobState> {
	let state = await readJobState(jobsRoot, id);
	if (isTerminalJobState(state.state)) return state;
	if (Date.now() >= deadlineMs) return state;
	let monitor: JobLivenessMonitor;
	try {
		monitor = await connectWaitMonitor(jobsRoot, state, deadlineMs, signal);
	} catch (error) {
		state = await readJobState(jobsRoot, id);
		if (isTerminalJobState(state.state)) return state;
		if (Date.now() >= deadlineMs) return state;
		if (error instanceof JobLivenessError && error.kind === "process-missing") {
			return reconcileInterruptedJob(jobsRoot, id);
		}
		throw error;
	}
	const watchSignal = signal ? AbortSignal.any([signal, monitor.signal]) : monitor.signal;
	try {
		for await (const observed of observeJobStates(jobsRoot, id, deadlineMs, watchSignal)) {
			state = observed;
			onStateChange?.(state);
			if (isTerminalJobState(state.state)) return state;
		}
	} catch (error) {
		if (signal?.aborted) throw new Error("job wait aborted");
		state = await readJobState(jobsRoot, id);
		if (isTerminalJobState(state.state)) return state;
		if (monitor.signal.aborted) return reconcileInterruptedJob(jobsRoot, id);
		throw error;
	} finally {
		monitor.close();
	}
	state = await readJobState(jobsRoot, id);
	if (isTerminalJobState(state.state)) return state;
	if (!(await jobProcessMatches(state))) return reconcileInterruptedJob(jobsRoot, id);
	return state;
}

export async function waitForJob(
	jobsRoot: string,
	id: string,
	signal?: AbortSignal,
	onStateChange?: (state: JobState) => void,
): Promise<JobState> {
	const initial = await readJobState(jobsRoot, id);
	const state = await waitForJobUntil(
		jobsRoot,
		id,
		Date.parse(initial.deadlineAt),
		signal,
		onStateChange,
	);
	if (isTerminalJobState(state.state)) return state;
	throw new Error(`job ${id} exceeded its persisted deadline`);
}

async function resolveOwnedProcessRace(
	jobsRoot: string,
	id: string,
	error: unknown,
): Promise<JobState> {
	const latest = await readJobState(jobsRoot, id);
	if (isTerminalJobState(latest.state)) return latest;
	if (!latest.pid || !(await processIsRunning(latest.pid))) {
		return reconcileInterruptedJob(jobsRoot, id);
	}
	throw error;
}

export async function cancelJob(jobsRoot: string, id: string): Promise<JobState> {
	const state = await readJobState(jobsRoot, id);
	if (isTerminalJobState(state.state)) return state;
	if (!state.pid || !state.processToken) throw new Error(`job ${id} has no owned process`);
	const jobDir = jobDirectoryPath(jobsRoot, id);
	try {
		await assertOwnedProcessGroup(jobDir, state.pid, state.processToken);
	} catch (error) {
		return resolveOwnedProcessRace(jobsRoot, id, error);
	}
	try {
		await claimJobCancellation(jobDir, state);
	} catch (error) {
		const latest = await readJobState(jobsRoot, id);
		if (isTerminalJobState(latest.state)) return latest;
		throw error;
	}
	try {
		await signalOwnedProcessGroup(jobDir, state.pid, state.processToken, "SIGTERM");
	} catch (error) {
		return resolveOwnedProcessRace(jobsRoot, id, error);
	}
	try {
		const waited = await waitForJobUntil(
			jobsRoot,
			id,
			Date.now() + TERMINATE_GRACE_MS,
		);
		if (isTerminalJobState(waited.state)) return waited;
	} catch (error) {
		return resolveOwnedProcessRace(jobsRoot, id, error);
	}
	try {
		await signalOwnedProcessGroup(jobDir, state.pid, state.processToken, "SIGKILL");
	} catch (error) {
		return resolveOwnedProcessRace(jobsRoot, id, error);
	}
	try {
		const waited = await waitForJobUntil(
			jobsRoot,
			id,
			Date.now() + JOB_LIVENESS_HANDSHAKE_TIMEOUT_MS,
		);
		if (isTerminalJobState(waited.state)) return waited;
	} catch (error) {
		return resolveOwnedProcessRace(jobsRoot, id, error);
	}
	throw new Error(`job ${id} survived SIGKILL`);
}

async function assertOwnedProcessGroup(
	jobDir: string,
	processId: number,
	token: string,
): Promise<void> {
	if (!(await processTokenMatches(processId, token))) {
		throw new Error("job process is not running");
	}
	await assertProcessGroupLeader(processId);
	const command = (await readFile(`/proc/${processId}/cmdline`)).toString("utf8");
	const runnerIdentity = command.includes(RUNNER_PATH) && command.includes(jobDir);
	const titleIdentity = command.includes(`pi-agent-job:${basename(jobDir)}`);
	if (!runnerIdentity && !titleIdentity) {
		throw new Error("job process identity does not match persisted state");
	}
	if (!(await processTokenMatches(processId, token))) {
		throw new Error("job process identity changed before signaling");
	}
	await assertProcessGroupLeader(processId);
}

async function signalOwnedProcessGroup(
	jobDir: string,
	processId: number,
	token: string,
	signal: NodeJS.Signals,
): Promise<void> {
	await assertOwnedProcessGroup(jobDir, processId, token);
	process.kill(-processId, signal);
}
