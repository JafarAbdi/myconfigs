// Bounded dynamic DAG: only the coordinator adds nodes. Ready read-only nodes fan out with bounded
// concurrency; a writer runs alone and reserves one correctness plus one context-style review, and
// workflow success requires the latest review pair to return explicit PASS.
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	runAgent,
	truncateUtf8Bytes,
	type AgentRunResult,
	type AgentRunUpdate,
} from "./agent-run.ts";
import type { AgentDefinition } from "./agents.ts";
import { replaceTextAtomic, syncParentDirectory } from "./atomic-files.ts";
import {
	readJobRequest,
	readJobStateAt,
	updateRunningJobLifecycle,
	updateRunningJobTelemetry,
	type JobState,
	type WorkflowJobRequest,
	type WorkflowNodeState,
} from "./job-store.ts";
import { acquireWriterLease, releaseWriterLease } from "./leases.ts";
import { LatestPulseWriter } from "./pulse.ts";
import {
	processGroupId,
	terminateEnvironmentMarkerProcesses,
	terminateProcessGroupMembers,
	WRITER_OWNER_ENV,
} from "./processes.ts";
import {
	AGENT_OUTPUT_BYTES_MAX,
	DEPENDENCY_OUTPUT_BYTES_MAX,
	WORKFLOW_CONCURRENCY_MAX,
	WORKFLOW_NODE_COUNT_MAX,
	WORKFLOW_NODE_TASK_BYTES_MAX,
	WORKFLOW_TOOL_OUTPUT_BYTES_MAX,
} from "./limits.ts";

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NODE_ERROR_BYTES_MAX = 4096;

export type NodeInput = {
	id: string;
	agent: string;
	task: string;
	dependsOn?: string[];
};

interface ScheduledNode {
	input: NodeInput;
	agent: AgentDefinition;
}

interface NodeOutcome {
	state: WorkflowNodeState;
	output?: string;
}

function failureText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return truncateUtf8Bytes(text, NODE_ERROR_BYTES_MAX, " [truncated]");
}

function validateInputs(inputs: NodeInput[], state: JobState, agents: AgentDefinition[]): void {
	const existing = new Map((state.nodes ?? []).map((node) => [node.id, node]));
	const submitted = new Set<string>();
	if (existing.size + inputs.length > WORKFLOW_NODE_COUNT_MAX) {
		throw new Error("workflow node limit exceeded");
	}
	for (const input of inputs) {
		if (!NODE_ID_PATTERN.test(input.id)) throw new Error(`invalid workflow node id: ${input.id}`);
		if (existing.has(input.id) || submitted.has(input.id)) {
			throw new Error(`duplicate workflow node id: ${input.id}`);
		}
		submitted.add(input.id);
		if (!input.task.trim() || Buffer.byteLength(input.task) > WORKFLOW_NODE_TASK_BYTES_MAX) {
			throw new Error(`workflow node task exceeds limit: ${input.id}`);
		}
		if (!agents.some((agent) => agent.name === input.agent)) {
			throw new Error(`unknown workflow agent: ${input.agent}`);
		}
		const dependencies = input.dependsOn ?? [];
		if (new Set(dependencies).size !== dependencies.length) {
			throw new Error(`duplicate workflow dependency: ${input.id}`);
		}
		for (const dependency of dependencies) {
			if (existing.get(dependency)?.state !== "succeeded") {
				throw new Error(`dependency is not already succeeded: ${dependency}`);
			}
		}
	}
}

function succeededPlanNodes(
	nodes: readonly WorkflowNodeState[],
	dependsOn: readonly string[],
): WorkflowNodeState[] {
	const deps = new Set(dependsOn);
	return nodes.filter(
		(node) => deps.has(node.id) && node.agent === "planner" && node.state === "succeeded",
	);
}

function directReviewerNodes(nodes: WorkflowNodeState[], writerId: string): {
	contextStyle: WorkflowNodeState[];
	correctness: WorkflowNodeState[];
} {
	const direct = nodes.filter((node) => node.dependsOn.includes(writerId));
	return {
		contextStyle: direct.filter((node) => node.agent === "context-style-reviewer"),
		correctness: direct.filter((node) => node.agent === "correctness-reviewer"),
	};
}

function writersOf(
	nodes: readonly WorkflowNodeState[],
	agents: AgentDefinition[],
): WorkflowNodeState[] {
	const access = new Map(agents.map((agent) => [agent.name, agent.access]));
	return nodes.filter((node) => access.get(node.agent) === "write");
}

function assertReservedReviews(
	inputs: NodeInput[],
	state: JobState,
	agents: AgentDefinition[],
): void {
	const access = new Map(agents.map((agent) => [agent.name, agent.access]));
	const nodes = state.nodes ?? [];
	const writers = writersOf(nodes, agents);
	const unsuccessful = writers.find((node) => node.state !== "succeeded");
	if (unsuccessful) throw new Error(`writer ${unsuccessful.id} did not succeed`);
	const writerIds = new Set(writers.map((writer) => writer.id));
	for (const input of inputs) {
		const reviewer = input.agent === "correctness-reviewer" ||
			input.agent === "context-style-reviewer";
		if (!reviewer) continue;
		for (const dependency of input.dependsOn ?? []) {
			if (!writerIds.has(dependency)) continue;
			const reviews = directReviewerNodes(nodes, dependency);
			const existing = input.agent === "correctness-reviewer"
				? reviews.correctness
				: reviews.contextStyle;
			if (existing.length > 0) throw new Error(`writer already has ${input.agent}`);
		}
	}
	const unpaired = writers.filter((writer) => {
		const reviews = directReviewerNodes(nodes, writer.id);
		return reviews.correctness.length === 0 || reviews.contextStyle.length === 0;
	});
	if (unpaired.length > 0) {
		if (unpaired.length > 1 || inputs.length !== 2) {
			throw new Error("writer review slots are reserved");
		}
		const writerId = unpaired[0].id;
		const names = new Set(inputs.map((input) => input.agent));
		const pair = names.size === 2 && names.has("correctness-reviewer") &&
			names.has("context-style-reviewer");
		const dependencies = inputs.every((input) => input.dependsOn?.includes(writerId));
		if (!pair || !dependencies) throw new Error("writer review slots are reserved");
		return;
	}
	const submittedWriters = inputs.filter((input) => access.get(input.agent) === "write");
	if (submittedWriters.length > 1) throw new Error("submit exactly one writer node");
	if (writers.length === 0) return;
	const latestWriter = writers.at(-1)!;
	const reviews = directReviewerNodes(nodes, latestWriter.id);
	const duplicateReview = inputs.some((input) => {
		const reviewer = input.agent === "correctness-reviewer" ||
			input.agent === "context-style-reviewer";
		return reviewer && input.dependsOn?.includes(latestWriter.id);
	});
	if (duplicateReview) throw new Error("writer already has reserved reviews");
	if (submittedWriters.length === 0) return;
	const correctness = reviews.correctness[0];
	const contextStyle = reviews.contextStyle[0];
	if (!correctness || !contextStyle) throw new Error("writer review slots are reserved");
	const dependencies = submittedWriters[0].dependsOn ?? [];
	if (!dependencies.includes(correctness.id) || !dependencies.includes(contextStyle.id)) {
		throw new Error("subsequent writer must depend on both reviews");
	}
}

function prepareNodes(
	inputs: NodeInput[],
	state: JobState,
	agents: AgentDefinition[],
): ScheduledNode[] {
	validateInputs(inputs, state, agents);
	assertReservedReviews(inputs, state, agents);
	const writerCount = inputs.filter((input) =>
		agents.find((agent) => agent.name === input.agent)?.access === "write"
	).length;
	if (writerCount > 0 && (writerCount !== 1 || inputs.length !== 1)) {
		throw new Error("writer must be submitted alone");
	}
	if (writerCount > 0) {
		for (const name of ["correctness-reviewer", "context-style-reviewer"]) {
			const reviewer = agents.find((agent) => agent.name === name);
			if (!reviewer || reviewer.access !== "read") {
				throw new Error(`writer requires read-only ${name}`);
			}
		}
		const planner = agents.find((agent) => agent.name === "planner");
		if (!planner || planner.access !== "read") throw new Error("writer requires read-only planner");
		if (succeededPlanNodes(state.nodes ?? [], inputs[0].dependsOn ?? []).length === 0) {
			throw new Error("writer must depend on a succeeded plan");
		}
	}
	const reservedNodeCount = (state.nodes?.length ?? 0) + inputs.length + 2 * writerCount;
	if (reservedNodeCount > WORKFLOW_NODE_COUNT_MAX) {
		throw new Error("writer requires capacity for two review nodes");
	}
	return inputs.map((input) => {
		const agent = agents.find((candidate) => candidate.name === input.agent);
		if (!agent) throw new Error(`unknown workflow agent: ${input.agent}`);
		return { input, agent };
	});
}

async function readNodeOutput(jobDir: string, id: string): Promise<string> {
	const path = join(jobDir, "nodes", `${id}.md`);
	const metadata = await stat(path);
	if (!metadata.isFile() || metadata.size > AGENT_OUTPUT_BYTES_MAX + 64) {
		throw new Error(`invalid dependency output: ${id}`);
	}
	return readFile(path, "utf8");
}

function reviewVerdict(text: string): "FAIL" | "PASS" | undefined {
	const line = text.trimStart().split(/\r?\n/, 1)[0]?.trim();
	if (line === "Verdict: PASS") return "PASS";
	if (line === "Verdict: FAIL") return "FAIL";
	return undefined;
}

function actionableField(block: string, name: string): boolean {
	const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S[^\\r\\n]*)$`, "m").exec(block);
	if (!match) return false;
	const value = match[1].trim();
	if (!/[\p{L}\p{N}]/u.test(value)) return false;
	const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	return !["na", "none", "placeholder", "tbd", "todo", "unknown"].includes(normalized);
}

function isActionableFail(text: string): boolean {
	if (reviewVerdict(text) !== "FAIL") return false;
	const blocks = text.split(/\n(?=\s*-\s*Severity:)/)
		.filter((block) => /^\s*-\s*Severity:\s*blocking\s*$/m.test(block));
	if (blocks.length === 0) return false;
	return blocks.every((block) => {
		const context = actionableField(block, "Failure scenario") ||
			actionableField(block, "Violated rule");
		return actionableField(block, "File") && actionableField(block, "Evidence") &&
			context && actionableField(block, "Smallest fix");
	});
}

async function assertReviewOutcome(
	jobDir: string,
	scheduled: ScheduledNode[],
	state: JobState,
	agents: AgentDefinition[],
): Promise<void> {
	const writers = writersOf(state.nodes ?? [], agents);
	if (writers.length === 0) return;
	const reviews = directReviewerNodes(state.nodes ?? [], writers.at(-1)!.id);
	const correctness = reviews.correctness[0];
	const contextStyle = reviews.contextStyle[0];
	if (!correctness || !contextStyle) return;
	const reports = await Promise.all([
		readNodeOutput(jobDir, correctness.id),
		readNodeOutput(jobDir, contextStyle.id),
	]);
	const verdicts = reports.map(reviewVerdict);
	if (verdicts.some((verdict) => verdict === undefined)) {
		throw new Error("review verdict must be PASS or FAIL");
	}
	if (verdicts.every((verdict) => verdict === "PASS")) {
		throw new Error("cannot write after accepted reviews");
	}
	const invalidFail = reports.some((report) =>
		reviewVerdict(report) === "FAIL" && !isActionableFail(report)
	);
	if (invalidFail) throw new Error("FAIL review is not actionable");
	if (scheduled.length !== 1 || scheduled[0].agent.access !== "write") {
		throw new Error("review failure requires one fix writer");
	}
}

export async function assertWorkflowReviews(
	jobDir: string,
	state: JobState,
	agents: AgentDefinition[],
): Promise<void> {
	const nodes = state.nodes ?? [];
	const writers = writersOf(nodes, agents);
	if (writers.length === 0) return;
	for (const writer of writers) {
		if (writer.state !== "succeeded") {
			throw new Error(`writer ${writer.id} did not succeed`);
		}
		if (succeededPlanNodes(nodes, writer.dependsOn).length === 0) {
			throw new Error(`writer ${writer.id} is missing a plan`);
		}
	}
	for (let index = 1; index < writers.length; index += 1) {
		const previousReviews = directReviewerNodes(nodes, writers[index - 1].id);
		if (previousReviews.correctness.length !== 1 || previousReviews.contextStyle.length !== 1) {
			throw new Error(`writer ${writers[index - 1].id} has invalid reviews`);
		}
		const dependencies = writers[index].dependsOn;
		if (!dependencies.includes(previousReviews.correctness[0].id) ||
			!dependencies.includes(previousReviews.contextStyle[0].id)) {
			throw new Error(`writer ${writers[index].id} is not linked to prior reviews`);
		}
	}
	const latest = writers.at(-1)!;
	const reviews = directReviewerNodes(nodes, latest.id);
	if (reviews.correctness.length !== 1 || reviews.contextStyle.length !== 1) {
		throw new Error(`writer ${latest.id} is missing PASS reviews`);
	}
	for (const review of [reviews.correctness[0], reviews.contextStyle[0]]) {
		if (review.state !== "succeeded" ||
			reviewVerdict(await readNodeOutput(jobDir, review.id)) !== "PASS") {
			throw new Error(`writer ${latest.id} is missing PASS reviews`);
		}
	}
}

async function buildNodeTask(jobDir: string, node: ScheduledNode): Promise<string> {
	const dependencies = node.input.dependsOn ?? [];
	if (dependencies.length === 0) return node.input.task;
	const sections = [node.input.task, "\n\nDependency outputs:"];
	for (const id of dependencies) {
		sections.push(`\n\n## ${id}\n${await readNodeOutput(jobDir, id)}`);
	}
	const task = sections.join("");
	if (Buffer.byteLength(task) > DEPENDENCY_OUTPUT_BYTES_MAX) {
		throw new Error(`dependency outputs exceed prompt limit: ${node.input.id}`);
	}
	return task;
}

async function runNode(
	jobDir: string,
	request: WorkflowJobRequest,
	node: ScheduledNode,
	startedAt: string,
	signal: AbortSignal | undefined,
	onActivity: (nodeId: string, update: AgentRunUpdate) => void,
): Promise<NodeOutcome> {
	let lease;
	let outcome: NodeOutcome;
	try {
		if (node.agent.access === "write") {
			lease = await acquireWriterLease(
				join(jobDir, "..", "..", "writer-leases"),
				request.cwd,
				`${request.id}:${node.input.id}`,
				{
					protectDescendants: true,
					processGroupId: await processGroupId(),
				},
			);
		}
		const result = await runAgent({
			invocation: request.invocation,
			agent: node.agent,
			task: await buildNodeTask(jobDir, node),
			cwd: request.cwd,
			signal,
			isolateProcessGroup: false,
			writerOwnerId: lease?.ownerId,
			onUpdate: (update) => onActivity(node.input.id, update),
		});
		await replaceTextAtomic(join(jobDir, "nodes", `${node.input.id}.md`), result.output, {
			bytesMax: AGENT_OUTPUT_BYTES_MAX,
			durable: true,
		});
		outcome = { state: completedNode(node, startedAt, result), output: result.output };
	} catch (error) {
		outcome = failedNode(node, startedAt, error, signal?.aborted ?? false);
	}
	try {
		if (lease) {
			await drainNodeProcessGroup();
			await terminateEnvironmentMarkerProcesses(
				WRITER_OWNER_ENV,
				lease.ownerId,
				{
					excludedProcessIds: [process.pid, process.ppid],
					ownedProcessGroup: lease.processGroupId,
				},
			);
			await releaseWriterLease(lease);
		}
	} catch (error) {
		outcome = failedNode(node, startedAt, error, false);
	}
	return outcome;
}

function failedNode(
	node: ScheduledNode,
	startedAt: string,
	error: unknown,
	cancelled: boolean,
): NodeOutcome {
	return {
		state: {
			...baseNode(node),
			state: cancelled ? "cancelled" : "failed",
			startedAt,
			endedAt: new Date().toISOString(),
			error: failureText(error),
		},
	};
}

function baseNode(node: ScheduledNode): WorkflowNodeState {
	return {
		id: node.input.id,
		agent: node.agent.name,
		task: node.input.task,
		dependsOn: node.input.dependsOn ?? [],
		state: "pending",
	};
}

function completedNode(
	node: ScheduledNode,
	startedAt: string,
	result: AgentRunResult,
): WorkflowNodeState {
	return {
		...baseNode(node),
		state: "succeeded",
		startedAt,
		endedAt: new Date().toISOString(),
		usage: result.usage,
	};
}

// Upholds the "writer runs alone" invariant: a writer is always taken as its own
// batch of one, so a mutation-capable node never runs concurrently with another node.
// prepareNodes enforces that a writer is submitted alone; executeScheduled asserts it.
function takeBatch(queue: ScheduledNode[]): ScheduledNode[] {
	const writerIndex = queue.findIndex((node) => node.agent.access === "write");
	if (writerIndex >= 0) return queue.splice(writerIndex, 1);
	return queue.splice(0, WORKFLOW_CONCURRENCY_MAX);
}

function replaceNodes(
	state: JobState,
	replacements: WorkflowNodeState[],
): JobState {
	const byId = new Map(replacements.map((node) => [node.id, node]));
	return {
		...state,
		nodes: (state.nodes ?? []).map((node) => byId.get(node.id) ?? node),
	};
}

type NodePulses = Map<string, AgentRunUpdate>;

async function writeNodePulses(jobDir: string, pulses: NodePulses): Promise<void> {
	const state = await readJobStateAt(jobDir);
	const replacements: WorkflowNodeState[] = [];
	for (const node of state.nodes ?? []) {
		const update = pulses.get(node.id);
		if (!update || node.state !== "running") continue;
		replacements.push({
			...node,
			activity: update.tool ?? "thinking",
			toolCount: update.toolCount,
			usage: update.usage,
		});
	}
	if (replacements.length === 0) return;
	await updateRunningJobTelemetry(jobDir, replaceNodes(state, replacements));
}

function mergeNodePulses(pending: NodePulses, latest: NodePulses): NodePulses {
	return new Map([...pending, ...latest]);
}

async function drainNodeProcessGroup(): Promise<void> {
	const excludedProcessIds = [process.pid];
	if (process.ppid > 1) excludedProcessIds.push(process.ppid);
	await terminateProcessGroupMembers(await processGroupId(), excludedProcessIds);
}

async function executeScheduled(
	jobDir: string,
	request: WorkflowJobRequest,
	scheduled: ScheduledNode[],
	signal?: AbortSignal,
): Promise<NodeOutcome[]> {
	const writerCount = scheduled.filter((node) => node.agent.access === "write").length;
	if (writerCount > 0 && scheduled.length !== 1) {
		throw new Error("writer must be scheduled alone");
	}
	let state = await readJobStateAt(jobDir);
	state = { ...state, nodes: [...(state.nodes ?? []), ...scheduled.map(baseNode)] };
	await updateRunningJobLifecycle(jobDir, state);
	const queue = [...scheduled];
	const outcomes: NodeOutcome[] = [];
	const pulseWriter = new LatestPulseWriter<NodePulses>({
		write: (pulses) => writeNodePulses(jobDir, pulses),
		merge: mergeNodePulses,
	});
	const onActivity = (nodeId: string, update: AgentRunUpdate) => {
		pulseWriter.submit(new Map([[nodeId, update]]));
	};
	while (queue.length > 0) {
		const batch = takeBatch(queue);
		const running = batch.map((node) => ({
			...baseNode(node), state: "running" as const, startedAt: new Date().toISOString(),
		}));
		state = replaceNodes(state, running);
		await updateRunningJobLifecycle(jobDir, state);
		const completed = await Promise.all(
			batch.map((node, index) => {
				const startedAt = running[index].startedAt;
				if (!startedAt) throw new Error("running node is missing its start time");
				return runNode(jobDir, request, node, startedAt, signal, onActivity);
			}),
		);
		await pulseWriter.flush();
		await drainNodeProcessGroup();
		outcomes.push(...completed);
		state = replaceNodes(state, completed.map((outcome) => outcome.state));
		await updateRunningJobLifecycle(jobDir, state);
	}
	return outcomes;
}

function formatOutcomes(outcomes: NodeOutcome[]): string {
	let output = "";
	for (const outcome of outcomes) {
		const body = outcome.output ?? outcome.state.error ?? "no output";
		const section = `## ${outcome.state.id} — ${outcome.state.state}\n${body}\n\n`;
		const candidate = output + section;
		if (Buffer.byteLength(candidate) > WORKFLOW_TOOL_OUTPUT_BYTES_MAX) {
			output = truncateUtf8Bytes(
				candidate,
				WORKFLOW_TOOL_OUTPUT_BYTES_MAX,
				"\n[workflow tool output truncated]",
			);
			break;
		}
		output = candidate;
	}
	return output.trim();
}

let graphMutationActive = false;

export async function runWorkflowNodes(
	jobDir: string,
	inputs: NodeInput[],
	signal?: AbortSignal,
): Promise<{ text: string; nodes: WorkflowNodeState[] }> {
	if (graphMutationActive) throw new Error("workflow graph mutation is already active");
	graphMutationActive = true;
	try {
		const request = await readJobRequest(jobDir);
		if (request.type !== "workflow") throw new Error("job is not a workflow");
		const state = await readJobStateAt(jobDir);
		if (state.state !== "running") throw new Error("workflow job is not running");
		const scheduled = prepareNodes(inputs, state, request.agents);
		await assertReviewOutcome(jobDir, scheduled, state, request.agents);
		const nodesDirectory = join(jobDir, "nodes");
		await mkdir(nodesDirectory, { recursive: true, mode: 0o700 });
		await syncParentDirectory(nodesDirectory);
		const outcomes = await executeScheduled(jobDir, request, scheduled, signal);
		return {
			text: formatOutcomes(outcomes),
			nodes: outcomes.map((outcome) => outcome.state),
		};
	} finally {
		graphMutationActive = false;
	}
}
