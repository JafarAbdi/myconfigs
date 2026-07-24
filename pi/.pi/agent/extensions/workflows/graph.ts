// Bounded dynamic DAG: only the coordinator adds nodes. Ready read-only nodes fan out with bounded
// concurrency; a mutation-capable node runs alone. Success requires the final writer to carry two
// distinct passing reviews -- which reviewers, and everything else about review conduct, is the
// coordinator prompt's business, not this module's.
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorText, runAgent, truncateUtf8Bytes, type AgentRunResult, type AgentRunUpdate } from "./agent-run.ts";
import type { AgentDefinition } from "./agents.ts";
import { replaceTextAtomic, syncParentDirectory } from "./atomic-files.ts";
import {
	NODE_ID_PATTERN,
	readJobRequest,
	readJobStateAt,
	telemetryFromState,
	updateRunningJobLifecycle,
	writeJobTelemetry,
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

// Independent reviews a write must carry before its workflow may report success.
const REVIEWS_PER_WRITER_MIN = 2;

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

function writersOf(nodes: readonly WorkflowNodeState[], agents: AgentDefinition[]): WorkflowNodeState[] {
	const access = new Map(agents.map((agent) => [agent.name, agent.access]));
	return nodes.filter((node) => access.get(node.agent) === "write");
}

function prepareNodes(inputs: NodeInput[], state: JobState, agents: AgentDefinition[]): ScheduledNode[] {
	validateInputs(inputs, state, agents);
	const scheduled = inputs.map((input) => {
		const agent = agents.find((candidate) => candidate.name === input.agent);
		if (!agent) throw new Error(`unknown workflow agent: ${input.agent}`);
		return { input, agent };
	});
	const writerCount = scheduled.filter((node) => node.agent.access === "write").length;
	if (writerCount > 0 && scheduled.length !== 1) throw new Error("writer must be submitted alone");
	// A writer that succeeds cannot be published until it is reviewed, so refuse to start one
	// the graph has no room left to review.
	const reserved = (state.nodes?.length ?? 0) + scheduled.length + REVIEWS_PER_WRITER_MIN * writerCount;
	if (reserved > WORKFLOW_NODE_COUNT_MAX) throw new Error("writer requires capacity for its reviews");
	return scheduled;
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

// The one review rule kept in code, because its absence would be silent: a workflow must not
// report success on an unreviewed write. Everything else about how reviews are conducted --
// which reviewers, whether a plan precedes the write, what a FAIL report must contain -- is
// stated in the coordinator prompt, not enforced here.
//
// Only the final writer must be accepted. Earlier writers legitimately carry FAIL reviews:
// that is what a write -> FAIL -> fix -> PASS iteration looks like.
export async function assertWorkflowReviews(jobDir: string, state: JobState, agents: AgentDefinition[]): Promise<void> {
	const nodes = state.nodes ?? [];
	const writers = writersOf(nodes, agents);
	if (writers.length === 0) return;
	const unsuccessful = writers.find((writer) => writer.state !== "succeeded");
	if (unsuccessful) throw new Error(`writer ${unsuccessful.id} did not succeed`);
	const latest = writers.at(-1)!;
	const readOnly = new Set(agents.filter((agent) => agent.access === "read").map((agent) => agent.name));
	const reviews = nodes.filter(
		(node) => node.dependsOn.includes(latest.id) && readOnly.has(node.agent) && node.state === "succeeded",
	);
	// Distinct agents, so two runs of one reviewer cannot stand in for independent review.
	if (new Set(reviews.map((review) => review.agent)).size < REVIEWS_PER_WRITER_MIN) {
		throw new Error(`writer ${latest.id} needs ${REVIEWS_PER_WRITER_MIN} distinct succeeded reviews`);
	}
	for (const review of reviews) {
		if (reviewVerdict(await readNodeOutput(jobDir, review.id)) !== "PASS") {
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
			await terminateEnvironmentMarkerProcesses(WRITER_OWNER_ENV, lease.ownerId, {
				excludedProcessIds: [process.pid, process.ppid],
				ownedProcessGroup: lease.processGroupId,
			});
			await releaseWriterLease(lease);
		}
	} catch (error) {
		outcome = failedNode(node, startedAt, error, false);
	}
	return outcome;
}

function failedNode(node: ScheduledNode, startedAt: string, error: unknown, cancelled: boolean): NodeOutcome {
	return {
		state: {
			...baseNode(node),
			state: cancelled ? "cancelled" : "failed",
			startedAt,
			endedAt: new Date().toISOString(),
			error: errorText(error),
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

function completedNode(node: ScheduledNode, startedAt: string, result: AgentRunResult): WorkflowNodeState {
	return {
		...baseNode(node),
		state: "succeeded",
		startedAt,
		endedAt: new Date().toISOString(),
		usage: result.usage,
	};
}

// Upholds the "writer runs alone" invariant: a writer is always taken as its own batch of one,
// so a mutation-capable node never runs concurrently with another. prepareNodes already refuses
// a submission that mixes a writer with anything else, before any state is mutated.
function takeBatch(queue: ScheduledNode[]): ScheduledNode[] {
	const writerIndex = queue.findIndex((node) => node.agent.access === "write");
	if (writerIndex >= 0) return queue.splice(writerIndex, 1);
	return queue.splice(0, WORKFLOW_CONCURRENCY_MAX);
}

function replaceNodes(state: JobState, replacements: WorkflowNodeState[]): JobState {
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
	// Project through the merged state so concurrently-running nodes absent from this batch
	// keep the activity they last reported.
	await writeJobTelemetry(jobDir, telemetryFromState(replaceNodes(state, replacements)));
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
	let state = await readJobStateAt(jobDir);
	state = { ...state, nodes: [...(state.nodes ?? []), ...scheduled.map(baseNode)] };
	await updateRunningJobLifecycle(jobDir, state);
	const queue = [...scheduled];
	const outcomes: NodeOutcome[] = [];
	const pulseWriter = new LatestPulseWriter<NodePulses>({
		write: (pulses) => writeNodePulses(jobDir, pulses),
		merge: (pending, latest) => new Map([...pending, ...latest]),
	});
	const onActivity = (nodeId: string, update: AgentRunUpdate) => {
		pulseWriter.submit(new Map([[nodeId, update]]));
	};
	while (queue.length > 0) {
		const batch = takeBatch(queue);
		const running = batch.map((node) => ({
			...baseNode(node),
			state: "running" as const,
			startedAt: new Date().toISOString(),
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
		state = replaceNodes(
			state,
			completed.map((outcome) => outcome.state),
		);
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
			output = truncateUtf8Bytes(candidate, WORKFLOW_TOOL_OUTPUT_BYTES_MAX, "\n[workflow tool output truncated]");
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
