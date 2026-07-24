// Schema-v4 job state. state.json is authoritative and its lifecycle writes are atomic and synced;
// telemetry.json is a disposable activity pulse overlaid on running jobs and never decides an
// outcome. Terminal states are monotonic and one interruption claim arbitrates a dead runner.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { publishJsonExclusive, replaceJsonAtomic, replaceTextAtomic, syncParentDirectory } from "./atomic-files.ts";
import {
	CANCELLATION_ERROR,
	isRecord,
	truncateUtf8Bytes,
	validateAgentUsage,
	type AgentRunResult,
	type PiInvocation,
	type UsageValidationLimits,
} from "./agent-run.ts";
import { validateAgentDefinition, type AgentDefinition } from "./agents.ts";
import { acquireWriterLeaseWithRetry, releaseWriterLease, type WriterLease } from "./leases.ts";
import {
	AGENT_COUNT_MAX,
	AGENT_OUTPUT_BYTES_MAX,
	AGENT_TASK_BYTES_MAX,
	AGENT_TOOL_NAME_BYTES_MAX,
	JOB_DIRECTORY_SCAN_COUNT_MAX,
	JOB_LIST_COUNT_MAX,
	JOB_REQUEST_BYTES_MAX,
	JOB_RESULT_BYTES_MAX,
	JOB_RETENTION_COUNT_MAX,
	JOB_STATE_BYTES_MAX,
	JOB_TELEMETRY_BYTES_MAX,
	WORKFLOW_NODE_COUNT_MAX,
	WORKFLOW_USAGE_COST_MAX,
	WORKFLOW_USAGE_COUNT_MAX,
} from "./limits.ts";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
export const JOB_SCHEMA_VERSION = 4;
// graph.ts admits node ids; this module persists them. One pattern, or a node runs and
// then fails its lifecycle write.
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATE_TRANSITION_ATTEMPT_COUNT_MAX = 16;
const STATE_TRANSITION_WAIT_MS = 2 * 1000;

export type JobStateName = "cancelled" | "failed" | "queued" | "running" | "succeeded";
export type WorkflowNodeStateName = "cancelled" | "failed" | "pending" | "running" | "succeeded";

interface JobRequestBase {
	version: typeof JOB_SCHEMA_VERSION;
	id: string;
	createdAt: string;
	cwd: string;
	invocation: PiInvocation;
	sessionFile?: string;
}

export interface AgentJobRequest extends JobRequestBase {
	type: "agent";
	task: string;
	agent: AgentDefinition;
	writerLeaseRoot?: string;
}

export interface WorkflowJobRequest extends JobRequestBase {
	type: "workflow";
	goal: string;
	agents: AgentDefinition[];
	model?: string;
}

export type JobRequest = AgentJobRequest | WorkflowJobRequest;

export interface WorkflowNodeState {
	id: string;
	agent: string;
	task: string;
	dependsOn: string[];
	state: WorkflowNodeStateName;
	startedAt?: string;
	endedAt?: string;
	error?: string;
	activity?: string;
	toolCount?: number;
	usage?: AgentRunResult["usage"];
}

interface TelemetryFields {
	activity?: string;
	toolCount?: number;
	usage?: AgentRunResult["usage"];
}

export interface NodeTelemetry extends TelemetryFields {
	id: string;
}

export interface JobTelemetry extends TelemetryFields {
	version: typeof JOB_SCHEMA_VERSION;
	id: string;
	nodes?: NodeTelemetry[];
}

export interface JobState {
	version: typeof JOB_SCHEMA_VERSION;
	id: string;
	type: "agent" | "workflow";
	state: JobStateName;
	createdAt: string;
	deadlineAt: string;
	startedAt?: string;
	endedAt?: string;
	pid?: number;
	processToken?: string;
	agent: string;
	cwd: string;
	error?: string;
	task?: string;
	activity?: string;
	toolCount?: number;
	usage?: AgentRunResult["usage"];
	nodes?: WorkflowNodeState[];
}

export interface JobArtifact {
	nodeId: string;
	agent: string;
	path: string;
}

export interface JobProjection {
	state: JobState;
	result?: string;
	resultPath?: string;
	nodeArtifacts: JobArtifact[];
}

export interface JobInterruptionClaim {
	version: typeof JOB_SCHEMA_VERSION;
	id: string;
	processToken: string;
	endedAt: string;
	error: string;
}

export interface JobCancellationClaim {
	version: typeof JOB_SCHEMA_VERSION;
	id: string;
	processToken: string;
	createdAt: string;
}

export function jobDirectoryPath(jobsRoot: string, id: string): string {
	if (!JOB_ID_PATTERN.test(id)) throw new Error(`invalid job id: ${id}`);
	return join(jobsRoot, id);
}

async function readJsonBounded(path: string, bytesMax = JOB_STATE_BYTES_MAX): Promise<unknown> {
	const metadata = await stat(path);
	if (metadata.size > bytesMax) throw new Error(`job file exceeds limit: ${path}`);
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path: string, value: unknown, durable: boolean): Promise<void> {
	await replaceJsonAtomic(path, value, { bytesMax: JOB_STATE_BYTES_MAX, durable });
}

function validateTelemetryFields(
	value: Record<string, unknown>,
	label: string,
	usageLimits?: UsageValidationLimits,
): void {
	if (value.activity !== undefined) {
		if (typeof value.activity !== "string" || Buffer.byteLength(value.activity) > AGENT_TOOL_NAME_BYTES_MAX) {
			throw new Error(`invalid ${label} activity`);
		}
	}
	if (value.toolCount !== undefined) {
		if (!Number.isSafeInteger(value.toolCount) || (value.toolCount as number) < 0) {
			throw new Error(`invalid ${label} tool count`);
		}
	}
	if (value.usage !== undefined) validateAgentUsage(value.usage, usageLimits);
}

function validateNodes(value: unknown): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > WORKFLOW_NODE_COUNT_MAX) {
		throw new Error("invalid workflow node state list");
	}
	const ids = new Set<string>();
	for (const node of value) {
		if (!isRecord(node) || typeof node.id !== "string" || !NODE_ID_PATTERN.test(node.id)) {
			throw new Error("invalid workflow node identity");
		}
		if (ids.has(node.id)) throw new Error("duplicate workflow node identity");
		ids.add(node.id);
		if (typeof node.agent !== "string") {
			throw new Error("invalid workflow node state");
		}
		if (!Array.isArray(node.dependsOn) || typeof node.task !== "string") {
			throw new Error("invalid workflow node payload");
		}
		const states: WorkflowNodeStateName[] = ["cancelled", "failed", "pending", "running", "succeeded"];
		if (!states.includes(node.state as WorkflowNodeStateName)) {
			throw new Error("invalid workflow node status");
		}
		if (node.state !== "pending" && typeof node.startedAt !== "string") {
			throw new Error("started workflow node is missing its start time");
		}
		if (["cancelled", "failed", "succeeded"].includes(node.state as string)) {
			if (typeof node.endedAt !== "string") throw new Error("workflow node is missing end time");
		}
		if ((node.state === "cancelled" || node.state === "failed") && !node.error) {
			throw new Error("unsuccessful workflow node is missing diagnostics");
		}
		validateTelemetryFields(node, "workflow node");
	}
}

function parseTimestamp(value: unknown, error: string): number {
	if (typeof value !== "string") throw new Error(error);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error(error);
	return timestamp;
}

function validateStartedProcess(value: Record<string, unknown>): void {
	if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 1) {
		throw new Error("invalid job process id");
	}
	parseTimestamp(value.startedAt, "invalid job start time");
	if (typeof value.processToken !== "string" || !value.processToken) {
		throw new Error("invalid job process identity");
	}
}

function validateState(value: unknown): JobState {
	if (!isRecord(value) || value.version !== JOB_SCHEMA_VERSION) {
		throw new Error("invalid job state header");
	}
	if (value.type !== "agent" && value.type !== "workflow") throw new Error("invalid job type");
	if (typeof value.id !== "string" || !JOB_ID_PATTERN.test(value.id)) {
		throw new Error("invalid job state id");
	}
	const states: JobStateName[] = ["cancelled", "failed", "queued", "running", "succeeded"];
	if (!states.includes(value.state as JobStateName)) throw new Error("invalid job state");
	if (typeof value.agent !== "string") throw new Error("invalid job state metadata");
	const createdAtMs = parseTimestamp(value.createdAt, "invalid job state metadata");
	const deadlineAtMs = parseTimestamp(value.deadlineAt, "invalid job deadline");
	if (deadlineAtMs <= createdAtMs) {
		throw new Error("invalid job deadline");
	}
	if (typeof value.cwd !== "string") throw new Error("invalid job cwd");
	if (value.state === "queued") {
		if (value.pid !== undefined || value.processToken !== undefined) {
			throw new Error("queued job cannot own a process yet");
		}
	} else if (value.state === "failed" && value.startedAt === undefined) {
		if (value.pid !== undefined || value.processToken !== undefined) {
			throw new Error("unstarted failed job cannot own a process");
		}
	} else {
		validateStartedProcess(value);
	}
	const startedAtMs =
		value.startedAt === undefined ? undefined : parseTimestamp(value.startedAt, "invalid job start time");
	if (startedAtMs !== undefined && startedAtMs < createdAtMs) {
		throw new Error("job start time precedes creation");
	}
	if (isTerminalJobState(value.state as JobStateName)) {
		const endedAtMs = parseTimestamp(value.endedAt, "invalid job end time");
		if (endedAtMs < (startedAtMs ?? createdAtMs)) {
			throw new Error("job end time precedes its start time");
		}
	}
	if ((value.state === "failed" || value.state === "cancelled") && !value.error) {
		throw new Error("unsuccessful job is missing diagnostics");
	}
	if (value.task !== undefined) {
		if (typeof value.task !== "string" || Buffer.byteLength(value.task) > AGENT_TASK_BYTES_MAX) {
			throw new Error("invalid job task");
		}
	}
	const usageLimits =
		value.type === "workflow" && value.state === "succeeded"
			? { costMax: WORKFLOW_USAGE_COST_MAX, countMax: WORKFLOW_USAGE_COUNT_MAX }
			: undefined;
	validateTelemetryFields(value, "job", usageLimits);
	validateNodes(value.nodes);
	return value as unknown as JobState;
}

function validateTelemetry(value: unknown): JobTelemetry {
	if (!isRecord(value) || value.version !== JOB_SCHEMA_VERSION) {
		throw new Error("invalid job telemetry header");
	}
	if (typeof value.id !== "string" || !JOB_ID_PATTERN.test(value.id)) {
		throw new Error("invalid job telemetry id");
	}
	validateTelemetryFields(value, "job telemetry");
	if (value.nodes !== undefined) {
		if (!Array.isArray(value.nodes) || value.nodes.length > WORKFLOW_NODE_COUNT_MAX) {
			throw new Error("invalid node telemetry list");
		}
		const ids = new Set<string>();
		for (const node of value.nodes) {
			if (!isRecord(node) || typeof node.id !== "string" || !NODE_ID_PATTERN.test(node.id)) {
				throw new Error("invalid node telemetry identity");
			}
			if (ids.has(node.id)) throw new Error("duplicate node telemetry identity");
			ids.add(node.id);
			validateTelemetryFields(node, "node telemetry");
		}
	}
	return value as unknown as JobTelemetry;
}

function validateAgentRequest(value: Record<string, unknown>): void {
	if (!isRecord(value.agent) || typeof value.task !== "string") {
		throw new Error("invalid agent job request payload");
	}
	if (!value.task.trim() || Buffer.byteLength(value.task) > AGENT_TASK_BYTES_MAX) {
		throw new Error("agent job task exceeds limit");
	}
	validateAgentDefinition(value.agent);
	if (value.writerLeaseRoot !== undefined && typeof value.writerLeaseRoot !== "string") {
		throw new Error("invalid writer lease root");
	}
}

function validateWorkflowRequest(value: Record<string, unknown>): void {
	if (typeof value.goal !== "string" || !Array.isArray(value.agents)) {
		throw new Error("invalid workflow job request payload");
	}
	if (!value.goal.trim() || Buffer.byteLength(value.goal) > AGENT_TASK_BYTES_MAX) {
		throw new Error("workflow goal exceeds limit");
	}
	if (value.model !== undefined && typeof value.model !== "string") {
		throw new Error("invalid workflow model");
	}
	if (value.agents.length === 0 || value.agents.length > AGENT_COUNT_MAX) {
		throw new Error("invalid workflow agent catalog");
	}
	const names = new Set<string>();
	for (const item of value.agents) {
		const agent = validateAgentDefinition(item);
		if (names.has(agent.name)) throw new Error("duplicate workflow agent");
		names.add(agent.name);
	}
}

function validateRequest(value: unknown): JobRequest {
	if (!isRecord(value) || value.version !== JOB_SCHEMA_VERSION) {
		throw new Error("invalid job request");
	}
	if (value.type !== "agent" && value.type !== "workflow") throw new Error("invalid request type");
	if (typeof value.id !== "string" || !JOB_ID_PATTERN.test(value.id)) {
		throw new Error("invalid job request id");
	}
	if (!isRecord(value.invocation) || typeof value.cwd !== "string") {
		throw new Error("invalid job request process options");
	}
	if (typeof value.invocation.command !== "string" || !Array.isArray(value.invocation.args)) {
		throw new Error("invalid Pi invocation");
	}
	if (!value.invocation.args.every((arg) => typeof arg === "string")) {
		throw new Error("invalid Pi invocation arguments");
	}
	if (typeof value.createdAt !== "string") throw new Error("invalid job request time");
	if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") {
		throw new Error("invalid job session file");
	}
	if (value.type === "agent") validateAgentRequest(value);
	if (value.type === "workflow") validateWorkflowRequest(value);
	return value as unknown as JobRequest;
}

export function isTerminalJobState(state: JobStateName): boolean {
	return state === "cancelled" || state === "failed" || state === "succeeded";
}

function authoritativeState(state: JobState): JobState {
	const authoritative = structuredClone(state);
	delete authoritative.activity;
	delete authoritative.toolCount;
	if (authoritative.state !== "succeeded") delete authoritative.usage;
	for (const node of authoritative.nodes ?? []) {
		delete node.activity;
		delete node.toolCount;
		if (node.state !== "succeeded") delete node.usage;
	}
	return authoritative;
}

// Projects the pulse fields out of a state a caller already assembled. Exported for graph.ts,
// which needs the per-node merge; the single-agent path builds its JobTelemetry directly.
export function telemetryFromState(state: JobState): JobTelemetry {
	const nodes = (state.nodes ?? []).map((node) => ({
		id: node.id,
		...(node.activity !== undefined ? { activity: node.activity } : {}),
		...(node.toolCount !== undefined ? { toolCount: node.toolCount } : {}),
		...(node.usage !== undefined ? { usage: node.usage } : {}),
	}));
	return {
		version: JOB_SCHEMA_VERSION,
		id: state.id,
		...(state.activity !== undefined ? { activity: state.activity } : {}),
		...(state.toolCount !== undefined ? { toolCount: state.toolCount } : {}),
		...(state.usage !== undefined ? { usage: state.usage } : {}),
		...(nodes.length > 0 ? { nodes } : {}),
	};
}

function applyTelemetry(state: JobState, telemetry: JobTelemetry): JobState {
	if (telemetry.id !== state.id || state.state !== "running") return state;
	const byId = new Map((telemetry.nodes ?? []).map((node) => [node.id, node]));
	return {
		...state,
		...(telemetry.activity !== undefined ? { activity: telemetry.activity } : {}),
		...(telemetry.toolCount !== undefined ? { toolCount: telemetry.toolCount } : {}),
		...(telemetry.usage !== undefined ? { usage: telemetry.usage } : {}),
		nodes: state.nodes?.map((node) => {
			const pulse = byId.get(node.id);
			if (!pulse || node.state !== "running") return node;
			return {
				...node,
				...(pulse.activity !== undefined ? { activity: pulse.activity } : {}),
				...(pulse.toolCount !== undefined ? { toolCount: pulse.toolCount } : {}),
				...(pulse.usage !== undefined ? { usage: pulse.usage } : {}),
			};
		}),
	};
}

export async function readJobStateAt(jobDir: string): Promise<JobState> {
	const state = validateState(await readJsonBounded(join(jobDir, "state.json")));
	if (state.state !== "running") return state;
	try {
		const value = await readJsonBounded(join(jobDir, "telemetry.json"), JOB_TELEMETRY_BYTES_MAX);
		return applyTelemetry(state, validateTelemetry(value));
	} catch {
		return state;
	}
}

export async function readJobState(jobsRoot: string, id: string): Promise<JobState> {
	const state = await readJobStateAt(jobDirectoryPath(jobsRoot, id));
	if (state.id !== id) throw new Error("job state id does not match its directory");
	return state;
}

export async function writeJobState(jobDir: string, state: JobState): Promise<void> {
	validateState(state);
	await writeJsonAtomic(join(jobDir, "state.json"), authoritativeState(state), true);
}

function validateCancellationClaim(value: unknown, state: JobState): JobCancellationClaim {
	if (!isRecord(value) || value.version !== JOB_SCHEMA_VERSION) {
		throw new Error("invalid job cancellation claim header");
	}
	if (value.id !== state.id || value.processToken !== state.processToken) {
		throw new Error("job cancellation claim identity differs");
	}
	parseTimestamp(value.createdAt, "invalid job cancellation claim time");
	return value as unknown as JobCancellationClaim;
}

async function claimJobCancellationLocked(jobDir: string, state: JobState): Promise<JobCancellationClaim> {
	const previous = await readJobStateAt(jobDir);
	assertSameJob(previous, state);
	if (previous.state !== "running" || !previous.processToken) {
		throw new Error("only a running job can claim cancellation");
	}
	const candidate: JobCancellationClaim = {
		version: JOB_SCHEMA_VERSION,
		id: previous.id,
		processToken: previous.processToken,
		createdAt: new Date().toISOString(),
	};
	const path = join(jobDir, "cancellation.json");
	if (
		await publishJsonExclusive(path, candidate, {
			bytesMax: JOB_STATE_BYTES_MAX,
			durable: true,
		})
	)
		return candidate;
	return validateCancellationClaim(await readJsonBounded(path), previous);
}

export async function claimJobCancellation(jobDir: string, state: JobState): Promise<JobCancellationClaim> {
	validateState(state);
	const lease = await acquireTransitionLease(jobDir);
	try {
		return await claimJobCancellationLocked(jobDir, state);
	} finally {
		await releaseWriterLease(lease);
	}
}

export async function readJobCancellation(jobDir: string, state: JobState): Promise<JobCancellationClaim | undefined> {
	try {
		return validateCancellationClaim(await readJsonBounded(join(jobDir, "cancellation.json")), state);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function validateInterruptionClaim(value: unknown, state: JobState): JobInterruptionClaim {
	if (!isRecord(value) || value.version !== JOB_SCHEMA_VERSION) {
		throw new Error("invalid job interruption claim header");
	}
	if (value.id !== state.id || value.processToken !== state.processToken) {
		throw new Error("job interruption claim identity differs");
	}
	parseTimestamp(value.endedAt, "invalid job interruption claim time");
	if (typeof value.error !== "string" || !value.error) {
		throw new Error("invalid job interruption claim error");
	}
	return value as unknown as JobInterruptionClaim;
}

export async function claimJobInterruption(
	jobDir: string,
	state: JobState,
	error: string,
): Promise<JobInterruptionClaim> {
	validateState(state);
	if (state.state !== "running" || !state.startedAt || !state.processToken) {
		throw new Error("only a running job can claim interruption");
	}
	if (!error) throw new Error("interruption error must be non-empty");
	const endedAtMs = Math.max(Date.now(), Date.parse(state.startedAt));
	const candidate: JobInterruptionClaim = {
		version: JOB_SCHEMA_VERSION,
		id: state.id,
		processToken: state.processToken,
		endedAt: new Date(endedAtMs).toISOString(),
		error,
	};
	const path = join(jobDir, "interruption.json");
	if (
		await publishJsonExclusive(path, candidate, {
			bytesMax: JOB_STATE_BYTES_MAX,
			durable: true,
		})
	)
		return candidate;
	return validateInterruptionClaim(await readJsonBounded(path), state);
}

function assertSameJob(previous: JobState, next: JobState): void {
	if (
		previous.id !== next.id ||
		previous.type !== next.type ||
		previous.createdAt !== next.createdAt ||
		previous.deadlineAt !== next.deadlineAt
	) {
		throw new Error("job update changed immutable identity");
	}
	if (previous.startedAt && previous.startedAt !== next.startedAt) {
		throw new Error("job update changed its start time");
	}
	if (previous.processToken && previous.processToken !== next.processToken) {
		throw new Error("job update changed its process identity");
	}
}

function terminalStateFrom(previous: JobState, next: JobState): JobState {
	const state: JobState = {
		...previous,
		state: next.state,
		endedAt: next.endedAt,
		...(next.error !== undefined ? { error: next.error } : {}),
		...(next.usage !== undefined ? { usage: next.usage } : {}),
	};
	if (next.state === "succeeded") {
		if ((previous.nodes ?? []).some((node) => node.state === "running")) {
			throw new Error("successful job has a running workflow node");
		}
		return state;
	}
	state.nodes = previous.nodes?.map((node) =>
		node.state === "running"
			? {
					...node,
					state: next.state === "cancelled" ? "cancelled" : "failed",
					endedAt: next.endedAt,
					error: next.error,
				}
			: node,
	);
	return state;
}

async function transitionJobStateLocked(jobDir: string, next: JobState): Promise<void> {
	validateState(next);
	const previous = await readJobStateAt(jobDir);
	assertSameJob(previous, next);
	const fromQueued = previous.state === "queued" && (next.state === "running" || next.state === "failed");
	const fromRunning = previous.state === "running" && isTerminalJobState(next.state);
	if (!fromQueued && !fromRunning) {
		throw new Error(`illegal job state transition: ${previous.state} -> ${next.state}`);
	}
	if (fromRunning) next = terminalStateFrom(previous, next);
	validateState(next);
	if (next.state === "succeeded") {
		if (await readJobCancellation(jobDir, previous)) {
			throw new Error("job cancellation requested before success publication");
		}
		if (!(await stat(join(jobDir, "result.md"))).isFile()) {
			throw new Error("successful job result is not a file");
		}
	}
	await writeJsonAtomic(join(jobDir, "state.json"), authoritativeState(next), true);
}

function acquireTransitionLease(jobDir: string): Promise<WriterLease> {
	return acquireWriterLeaseWithRetry(
		join(jobDir, "transition-locks"),
		jobDir,
		`state-transition:${process.pid}:${randomUUID()}`,
		{
			attemptsMax: STATE_TRANSITION_ATTEMPT_COUNT_MAX,
			waitMs: STATE_TRANSITION_WAIT_MS,
			exhausted: "job state transition remained busy",
		},
	);
}

export async function transitionJobState(jobDir: string, next: JobState): Promise<void> {
	const lease = await acquireTransitionLease(jobDir);
	try {
		await transitionJobStateLocked(jobDir, next);
	} finally {
		await releaseWriterLease(lease);
	}
}

export async function reconcileInterruptedJobState(jobDir: string, fallbackError: string): Promise<JobState> {
	const lease = await acquireTransitionLease(jobDir);
	try {
		const state = await readJobStateAt(jobDir);
		if (isTerminalJobState(state.state)) return state;
		if (state.state !== "running") throw new Error(`job ${state.id} has no running process`);
		const cancellation = await readJobCancellation(jobDir, state);
		const requestedError = cancellation ? CANCELLATION_ERROR : fallbackError;
		const claim = await claimJobInterruption(jobDir, state, requestedError);
		await transitionJobStateLocked(jobDir, {
			...state,
			state: claim.error === CANCELLATION_ERROR ? "cancelled" : "failed",
			endedAt: claim.endedAt,
			error: claim.error,
		});
		return readJobStateAt(jobDir);
	} finally {
		await releaseWriterLease(lease);
	}
}

function assertNodeUpdates(previous: JobState, next: JobState): void {
	const oldNodes = new Map((previous.nodes ?? []).map((node) => [node.id, node]));
	const newNodes = new Map((next.nodes ?? []).map((node) => [node.id, node]));
	if (newNodes.size !== (next.nodes ?? []).length || newNodes.size < oldNodes.size) {
		throw new Error("workflow update removed or duplicated nodes");
	}
	for (const id of oldNodes.keys()) {
		if (!newNodes.has(id)) throw new Error("workflow update removed an existing node");
	}
	for (const [id, node] of newNodes) {
		const old = oldNodes.get(id);
		if (!old) {
			if (node.state !== "pending") throw new Error("new workflow node must be pending");
			continue;
		}
		if (old.agent !== node.agent || old.task !== node.task) {
			throw new Error("workflow update changed immutable node fields");
		}
		if (old.startedAt && old.startedAt !== node.startedAt) {
			throw new Error("workflow update changed node start time");
		}
		if (old.dependsOn.join("\0") !== node.dependsOn.join("\0")) {
			throw new Error("workflow update changed node dependencies");
		}
		const starts = old.state === "pending" && node.state === "running";
		const finishes = old.state === "running" && ["cancelled", "failed", "succeeded"].includes(node.state);
		if (old.state !== node.state && !starts && !finishes) {
			throw new Error(`illegal workflow node transition: ${old.state} -> ${node.state}`);
		}
	}
}

async function updateRunningJobLifecycleLocked(jobDir: string, next: JobState): Promise<void> {
	validateState(next);
	const previous = await readJobStateAt(jobDir);
	assertSameJob(previous, next);
	if (previous.state !== "running" || next.state !== "running") {
		throw new Error("job graph updates require a running job");
	}
	assertNodeUpdates(previous, next);
	const oldNodes = new Map((previous.nodes ?? []).map((node) => [node.id, node]));
	for (const node of next.nodes ?? []) {
		if (node.state !== "succeeded" || oldNodes.get(node.id)?.state === "succeeded") continue;
		const output = await stat(join(jobDir, "nodes", `${node.id}.md`));
		if (!output.isFile() || output.size > AGENT_OUTPUT_BYTES_MAX + 64) {
			throw new Error(`invalid workflow node output: ${node.id}`);
		}
	}
	await writeJsonAtomic(join(jobDir, "state.json"), authoritativeState(next), true);
}

export async function updateRunningJobLifecycle(jobDir: string, next: JobState): Promise<void> {
	const lease = await acquireTransitionLease(jobDir);
	try {
		await updateRunningJobLifecycleLocked(jobDir, next);
	} finally {
		await releaseWriterLease(lease);
	}
}

// Takes JobTelemetry, not JobState: a lifecycle field is unrepresentable here, so there is
// nothing to guard against. No transition lease either — telemetry.json is disposable, the
// write is atomic, and applyTelemetry discards it on read unless the job and node are still
// running, so a stale or late pulse cannot reach an outcome.
export async function writeJobTelemetry(jobDir: string, telemetry: JobTelemetry): Promise<void> {
	validateTelemetry(telemetry);
	await replaceJsonAtomic(join(jobDir, "telemetry.json"), telemetry, {
		bytesMax: JOB_TELEMETRY_BYTES_MAX,
		durable: false,
	});
}

export async function readJobRequest(jobDir: string): Promise<JobRequest> {
	return validateRequest(await readJsonBounded(join(jobDir, "request.json"), JOB_REQUEST_BYTES_MAX));
}

function workflowArtifactIndex(state: JobState): string {
	if (state.type !== "workflow") return "";
	const nodes = (state.nodes ?? []).filter((node) => node.state === "succeeded");
	if (nodes.length === 0) return "";
	const links = nodes.map((node) => `- [${node.id} — ${node.agent}](nodes/${node.id}.md)`);
	return `## Detailed reports\n\n${links.join("\n")}`;
}

function boundedJobResult(output: string, artifactIndex: string): string {
	const suffix = artifactIndex ? `\n\n${artifactIndex}` : "";
	const suffixBytes = Buffer.byteLength(suffix);
	if (suffixBytes >= JOB_RESULT_BYTES_MAX) throw new Error("job artifact index exceeds limit");
	const trimmed = output.trim();
	const outputBytesMax = JOB_RESULT_BYTES_MAX - suffixBytes;
	if (Buffer.byteLength(trimmed) <= outputBytesMax) return trimmed + suffix;
	const marker = "\n\n[final report truncated; use detailed reports below]";
	if (outputBytesMax <= Buffer.byteLength(marker)) {
		throw new Error("job artifact index leaves no room for the final report");
	}
	return truncateUtf8Bytes(trimmed, outputBytesMax, marker) + suffix;
}

export async function writeJobResult(jobDir: string, output: string, state: JobState): Promise<void> {
	validateState(state);
	const result = boundedJobResult(output, workflowArtifactIndex(state));
	if (Buffer.byteLength(result) > JOB_RESULT_BYTES_MAX) {
		throw new Error("job result exceeds limit before write");
	}
	await replaceTextAtomic(join(jobDir, "result.md"), result, {
		bytesMax: JOB_RESULT_BYTES_MAX,
		durable: true,
	});
}

export async function readJobResult(jobsRoot: string, id: string): Promise<string> {
	const path = join(jobDirectoryPath(jobsRoot, id), "result.md");
	const metadata = await stat(path);
	if (metadata.size > JOB_RESULT_BYTES_MAX) {
		throw new Error(`job result exceeds limit: ${id}`);
	}
	return readFile(path, "utf8");
}

export async function createJobRecord(jobsRoot: string, request: JobRequest, state: JobState): Promise<string> {
	validateRequest(request);
	validateState(state);
	if (request.id !== state.id || request.type !== state.type) {
		throw new Error("job request and state identity differ");
	}
	if (request.createdAt !== state.createdAt || request.cwd !== state.cwd) {
		throw new Error("job request and state metadata differ");
	}
	await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
	await syncParentDirectory(jobsRoot);
	const jobDir = jobDirectoryPath(jobsRoot, request.id);
	await mkdir(jobDir, { recursive: false, mode: 0o700 });
	await syncParentDirectory(jobDir);
	const requestPublished = await publishJsonExclusive(join(jobDir, "request.json"), request, {
		bytesMax: JOB_REQUEST_BYTES_MAX,
		durable: true,
	});
	if (!requestPublished) throw new Error("job request already exists");
	await writeJobState(jobDir, state);
	return jobDir;
}

async function readJobDirectoryEntries(jobsRoot: string) {
	try {
		const entries = await readdir(jobsRoot, { withFileTypes: true });
		if (entries.length > JOB_DIRECTORY_SCAN_COUNT_MAX) {
			throw new Error("job directory scan limit exceeded; remove old job records");
		}
		return entries;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function resolveJobId(jobsRoot: string, prefix: string): Promise<string> {
	if (!/^[0-9a-f-]{8,36}$/.test(prefix)) throw new Error("invalid job id prefix");
	const matches = (await readJobDirectoryEntries(jobsRoot))
		.filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
		.map((entry) => entry.name)
		.filter((id) => id.startsWith(prefix));
	if (matches.length === 0) throw new Error(`job id prefix not found: ${prefix}`);
	if (matches.length > 1) throw new Error(`ambiguous job id prefix: ${prefix}`);
	return matches[0];
}

async function readStoredJobStates(jobsRoot: string): Promise<JobState[]> {
	const entries = await readJobDirectoryEntries(jobsRoot);
	const states: JobState[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
		try {
			states.push(await readJobState(jobsRoot, entry.name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`cannot read job record ${entry.name}: ${message}`, { cause: error });
		}
	}
	states.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	return states;
}

export async function pruneJobRecords(jobsRoot: string): Promise<number> {
	const states = await readStoredJobStates(jobsRoot);
	const expired = states.filter((state) => isTerminalJobState(state.state)).slice(JOB_RETENTION_COUNT_MAX);
	for (const state of expired) {
		await rm(jobDirectoryPath(jobsRoot, state.id), { recursive: true, force: true });
	}
	return states.length - expired.length;
}

export async function listJobStates(jobsRoot: string): Promise<JobState[]> {
	return (await readStoredJobStates(jobsRoot)).slice(0, JOB_LIST_COUNT_MAX);
}

// Pure projection: no disk access, and every caller passes state that came from a validated
// read or a validated write. jobDirectoryPath still guards the id it interpolates into a path.
export function projectJob(jobsRoot: string, state: JobState, result?: string): JobProjection {
	if (result !== undefined && state.state !== "succeeded") {
		throw new Error("only a successful job can project a final result");
	}
	const jobDir = jobDirectoryPath(jobsRoot, state.id);
	const nodeArtifacts = (state.nodes ?? [])
		.filter((node) => node.state === "succeeded")
		.map((node) => ({
			nodeId: node.id,
			agent: node.agent,
			path: join(jobDir, "nodes", `${node.id}.md`),
		}));
	return {
		state,
		result,
		resultPath: state.state === "succeeded" ? join(jobDir, "result.md") : undefined,
		nodeArtifacts,
	};
}

export async function readJobProjection(jobsRoot: string, id: string, includeResult: boolean): Promise<JobProjection> {
	const state = await readJobState(jobsRoot, id);
	const result = includeResult && state.state === "succeeded" ? await readJobResult(jobsRoot, id) : undefined;
	return projectJob(jobsRoot, state, result);
}
