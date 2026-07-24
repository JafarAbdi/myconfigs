import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { JsonlDecoder, runAgent } from "../agent-run.ts";
import { assertWorkflowReviews, runWorkflowNodes } from "../graph.ts";
import {
	cancelJob,
	startAgentJob,
	startWorkflowJob,
	waitForJob,
} from "../job-control.ts";
import {
	claimJobCancellation,
	claimJobInterruption,
	listJobStates,
	pruneJobRecords,
	readJobProjection,
	readJobRequest,
	readJobResult,
	readJobStateAt,
	reconcileInterruptedJobState,
	resolveJobId,
	transitionJobState,
	updateRunningJobLifecycle,
	updateRunningJobTelemetry,
	writeJobResult,
	writeJobState,
	type JobState,
	type WorkflowNodeState,
} from "../job-store.ts";
import {
	acquireWriterLease,
	releaseWriterLease,
	setWriterLeaseProcessGroup,
	waitForWriterLeaseRelease,
} from "../leases.ts";
import { LatestPulseWriter } from "../pulse.ts";
import { formatActiveJobs, formatJobNotification } from "../presentation.ts";
import {
	connectToJobLiveness,
	JobLivenessError,
	listenForJobLiveness,
	processGroupId,
	processIsRunning,
	processToken,
} from "../processes.ts";
import {
	AGENT_DIRECTORY_ENTRY_COUNT_MAX,
	AGENT_OUTPUT_BYTES_MAX,
	JOB_DIRECTORY_SCAN_COUNT_MAX,
	JOB_RETENTION_COUNT_MAX,
	JOB_STATE_BYTES_MAX,
	JSONL_RECORD_BYTES_MAX,
	JSONL_RECORD_COUNT_MAX,
	STDERR_BYTES_MAX,
	TERMINATE_GRACE_MS,
} from "../limits.ts";
import {
	agentWithDefaultModel,
	discoverAgents,
	type AgentDefinition,
	type FrontmatterParser,
} from "../agents.ts";

const parseJsonFrontmatter: FrontmatterParser = (content) => JSON.parse(content);

function agentFile(frontmatter: Record<string, unknown>, body = "Agent prompt") {
	return JSON.stringify({ frontmatter, body });
}

function isProcessRunning(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch {
		return false;
	}
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-workflows-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error("test operation timed out")), timeoutMs);
		timeout.unref();
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function testAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "reviewer",
		description: "Reviews changes",
		tools: ["read", "grep"],
		access: "read",
		skills: "all",
		systemPrompt: "Review only.",
		systemPromptMode: "append",
		...overrides,
	};
}

function runningJobState(directory: string, overrides: Partial<JobState> = {}): JobState {
	const createdAt = overrides.createdAt ?? new Date().toISOString();
	return {
		version: 4,
		id: randomUUID(),
		type: "agent",
		state: "running",
		createdAt,
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		startedAt: createdAt,
		pid: process.pid,
		processToken: "test-process",
		agent: "test",
		cwd: directory,
		...overrides,
	};
}

async function createRunningWorkflow(
	directory: string,
	script: string,
	agents: AgentDefinition[],
): Promise<string> {
	const id = randomUUID();
	const jobDir = join(directory, id);
	const createdAt = new Date().toISOString();
	await mkdir(jobDir);
	await writeFile(join(jobDir, "request.json"), JSON.stringify({
		version: 4,
		id,
		type: "workflow",
		createdAt,
		cwd: directory,
		goal: "Test workflow",
		agents,
		invocation: { command: process.execPath, args: [script] },
	}));
	await writeJobState(jobDir, runningJobState(directory, {
		id,
		createdAt,
		type: "workflow",
		agent: "workflow-coordinator",
		nodes: [],
	}));
	return jobDir;
}

// Seeds a succeeded planner node so a writer can satisfy the plan gate. Returns its id.
async function seedPlan(jobDir: string): Promise<string> {
	const state = await readJobStateAt(jobDir);
	await writeJobState(jobDir, {
		...state,
		nodes: [...(state.nodes ?? []), succeededPlanNode()],
	});
	await mkdir(join(jobDir, "nodes"), { recursive: true });
	await writeFile(join(jobDir, "nodes", "plan.md"), "Plan: implement it");
	return "plan";
}

function succeededPlanNode(): WorkflowNodeState {
	return {
		id: "plan",
		agent: "planner",
		task: "plan",
		dependsOn: [],
		state: "succeeded",
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	};
}

async function createGraphWorkflow(directory: string): Promise<{
	agent: AgentDefinition;
	id: string;
	jobDir: string;
}> {
	const script = join(directory, "node-pi.mjs");
	await writeFile(
		script,
		`const text = process.argv.at(-1);
		if (text === "left result") await new Promise((resolve) => setTimeout(resolve, 30));
		if (text === "fail") { process.stderr.write("planned failure"); process.exit(2); }
		if (text === "large failure") {
			process.stderr.write("€".repeat(5000)); process.exit(2);
		}
		process.stdout.write(JSON.stringify({ type: "message_end", message: {
			role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
		} }));`,
	);
	const agent = testAgent({ skills: "none" });
	const jobDir = await createRunningWorkflow(directory, script, [agent]);
	return { agent, id: basename(jobDir), jobDir };
}

interface ReviewLoopAgents {
	implementer: AgentDefinition;
	correctness: AgentDefinition;
	contextStyle: AgentDefinition;
}

async function runRejectedInitialStage(
	jobDir: string,
	agents: ReviewLoopAgents,
): Promise<void> {
	const initial = await runWorkflowNodes(jobDir, [{
		id: "implementation-1",
		agent: agents.implementer.name,
		task: "initial implementation",
		dependsOn: ["plan"],
	}]);
	assert.equal(initial.nodes[0].state, "succeeded");
	await assert.rejects(
		assertWorkflowReviews(jobDir, await readJobStateAt(jobDir), Object.values(agents)),
		/missing PASS reviews/,
	);
	await assert.rejects(runWorkflowNodes(jobDir, [{
		id: "unrelated",
		agent: agents.correctness.name,
		task: "must wait",
	}]), /writer review slots are reserved/);
	const reviews = await runWorkflowNodes(jobDir, [
		{
			id: "correctness-1",
			agent: agents.correctness.name,
			task: "review initial correctness",
			dependsOn: ["implementation-1"],
		},
		{
			id: "context-1",
			agent: agents.contextStyle.name,
			task: "review initial rules",
			dependsOn: ["implementation-1"],
		},
	]);
	assert.match(reviews.text, /Verdict: FAIL/);
	await assert.rejects(runWorkflowNodes(jobDir, [
		{
			id: "duplicate-correctness",
			agent: agents.correctness.name,
			task: "review initial again",
			dependsOn: ["implementation-1"],
		},
		{
			id: "duplicate-context",
			agent: agents.contextStyle.name,
			task: "review initial again",
			dependsOn: ["implementation-1"],
		},
	]), /writer already has correctness-reviewer/);
	for (const dependsOn of [[], ["correctness-1"]]) {
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: `unlinked-fix-${dependsOn.length}`,
			agent: agents.implementer.name,
			task: "must not run",
			dependsOn,
		}]), /subsequent writer must depend on both reviews/);
	}
	const fix = await runWorkflowNodes(jobDir, [{
		id: "implementation-2",
		agent: agents.implementer.name,
		task: "fix implementation",
		dependsOn: ["plan", "correctness-1", "context-1"],
	}]);
	assert.equal(fix.nodes[0].state, "succeeded");
}

async function runAcceptedReviewStage(
	jobDir: string,
	agents: ReviewLoopAgents,
): Promise<void> {
	const accepted = await runWorkflowNodes(jobDir, [
		{
			id: "correctness-2",
			agent: agents.correctness.name,
			task: "review fixed correctness",
			dependsOn: ["implementation-2"],
		},
		{
			id: "context-2",
			agent: agents.contextStyle.name,
			task: "review fixed rules",
			dependsOn: ["implementation-2"],
		},
	]);
	assert.equal(accepted.nodes.length, 2);
	for (const id of ["correctness-2", "context-2"]) {
		assert.match(await readFile(join(jobDir, "nodes", `${id}.md`), "utf8"), /^Verdict: PASS/);
	}
	await assert.rejects(runWorkflowNodes(jobDir, [{
		id: "write-after-pass",
		agent: agents.implementer.name,
		task: "must not run",
		dependsOn: ["plan", "correctness-2", "context-2"],
	}]), /cannot write after accepted reviews/);
	await assert.rejects(runWorkflowNodes(jobDir, [{
		id: "late-duplicate-review",
		agent: agents.correctness.name,
		task: "must not run",
		dependsOn: ["implementation-1"],
	}]), /writer already has correctness-reviewer/);
	const state = await readJobStateAt(jobDir);
	await assertWorkflowReviews(jobDir, state, Object.values(agents));
	await writeJobResult(jobDir, "accepted", state);
	const result = await readFile(join(jobDir, "result.md"), "utf8");
	const reportIds = [
		"implementation-1", "correctness-1", "context-1",
		"implementation-2", "correctness-2", "context-2",
	];
	for (const id of reportIds) assert.match(result, new RegExp(`nodes/${id}\\.md`));
}

async function runRejectedReviewLoop(
	jobDir: string,
	agents: ReviewLoopAgents,
): Promise<void> {
	await runRejectedInitialStage(jobDir, agents);
	await runAcceptedReviewStage(jobDir, agents);
}

test("personal agent discovery requires explicit policy", async () => {
	await withTempDirectory(async (directory) => {
		await writeFile(
			join(directory, "reviewer.md"),
			agentFile({
				name: "reviewer",
				description: "Personal reviewer",
				tools: "read, grep",
				access: "read",
				skills: "none",
				systemPromptMode: "replace",
			}),
		);
		const agents = discoverAgents(directory, parseJsonFrontmatter);
		assert.equal(agents.length, 1);
		assert.equal(agents[0].description, "Personal reviewer");
		assert.equal(agents[0].access, "read");
		assert.deepEqual(agents[0].tools, ["read", "grep"]);
		assert.equal(agents[0].skills, "none");
		assert.equal(agents[0].systemPromptMode, "replace");
	});
});

test("agent discovery rejects an unbounded directory", async () => {
	await withTempDirectory(async (directory) => {
		await Promise.all(Array.from(
			{ length: AGENT_DIRECTORY_ENTRY_COUNT_MAX + 1 },
			(_, index) => writeFile(join(directory, `entry-${index}`), ""),
		));
		assert.throws(
			() => discoverAgents(directory, parseJsonFrontmatter),
			/agent directory entry limit exceeded/,
		);
	});
});

test("agent policy rejects implicit or contradictory capability", async () => {
	await withTempDirectory(async (directory) => {
		await writeFile(
			join(directory, "implicit.md"),
			agentFile({
				name: "implicit",
				description: "Missing explicit policy",
				tools: "read",
				skills: "none",
			}),
		);
		assert.throws(
			() => discoverAgents(directory, parseJsonFrontmatter),
			/access is required/,
		);
		await rm(join(directory, "implicit.md"));
		await writeFile(
			join(directory, "unsafe.md"),
			agentFile({
				name: "unsafe",
				description: "Contradictory reviewer",
				tools: "read, bash",
				access: "read",
				skills: "none",
			}),
		);
		assert.throws(
			() => discoverAgents(directory, parseJsonFrontmatter),
			/read access cannot include mutation-capable tools/,
		);
	});
});

test("read-only agents may use external research tools", async () => {
	await withTempDirectory(async (directory) => {
		await writeFile(
			join(directory, "researcher.md"),
			agentFile({
				name: "researcher",
				description: "Researches external sources",
				tools: "read, web_search, fetch_content",
				access: "read",
				skills: "none",
			}),
		);
		const agents = discoverAgents(directory, parseJsonFrontmatter);
		assert.deepEqual(agents[0].tools, ["read", "web_search", "fetch_content"]);
	});
});

test("agents inherit the active model unless explicitly configured", () => {
	const agent = testAgent();
	assert.equal(agentWithDefaultModel(agent, "openai/active").model, "openai/active");
	assert.equal(
		agentWithDefaultModel({ ...agent, model: "anthropic/configured" }, "openai/active").model,
		"anthropic/configured",
	);
});

test("pulse writer keeps one active write and one merged pending pulse", async () => {
	let releaseFirst: (() => void) | undefined;
	const firstBlocked = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const written: number[] = [];
	const writer = new LatestPulseWriter<number>({
		write: async (value) => {
			written.push(value);
			if (value === 1) await firstBlocked;
		},
	});
	writer.submit(1);
	await Promise.resolve();
	writer.submit(2);
	writer.submit(3);
	releaseFirst?.();
	await writer.flush();
	assert.deepEqual(written, [1, 3]);
});

test("pulse writer serializes synchronous reentrant submission", async () => {
	let activeWriteCount = 0;
	let activeWriteCountMax = 0;
	let writer: LatestPulseWriter<number>;
	writer = new LatestPulseWriter<number>({
		write: async (value) => {
			activeWriteCount += 1;
			activeWriteCountMax = Math.max(activeWriteCountMax, activeWriteCount);
			if (value === 1) writer.submit(2);
			await Promise.resolve();
			activeWriteCount -= 1;
		},
	});
	writer.submit(1);
	await writer.flush();
	assert.equal(activeWriteCountMax, 1);
});

test("pulse writer contains telemetry failures", async () => {
	const writer = new LatestPulseWriter<number>({
		write: async () => {
			throw new Error("telemetry unavailable");
		},
	});
	writer.submit(1);
	await writer.flush();
	writer.submit(2);
	await writer.flush();
});

test("active-job widget has a truthful row bound", () => {
	const createdAt = new Date().toISOString();
	const deadlineAt = new Date(Date.now() + 60_000).toISOString();
	const projections = Array.from({ length: 30 }, (_, index) => {
		const state: JobState = {
			version: 4,
			id: `0000000${index.toString(16)}-0000-0000-0000-000000000000`.slice(-36),
			type: "agent",
			state: "queued",
			createdAt,
			deadlineAt,
			agent: "test",
			cwd: "/tmp",
		};
		return { state, nodeArtifacts: [] };
	});
	const lines = formatActiveJobs(projections);
	assert.ok(lines);
	assert.ok(lines.length <= 20);
	assert.match(lines.at(-1) ?? "", /more jobs/);
});

test("job completion notifications stay concise and useful", () => {
	const state: JobState = {
		version: 4,
		id: "aaaaaaaa-0000-0000-0000-000000000000",
		type: "agent",
		state: "failed",
		createdAt: "2026-01-01T00:00:00.000Z",
		deadlineAt: "2026-01-01T00:10:00.000Z",
		startedAt: "2026-01-01T00:00:01.000Z",
		endedAt: "2026-01-01T00:01:01.000Z",
		error: "x".repeat(500),
		agent: "test",
		cwd: "/tmp",
	};
	const text = formatJobNotification(state);
	assert.match(text, /^Job aaaaaaaa failed · 1\.0m · /);
	assert.ok(Buffer.byteLength(text) <= 160);
});

test("writer lease permits only one owner per workspace", async () => {
	await withTempDirectory(async (directory) => {
		const root = join(directory, "leases");
		const first = await acquireWriterLease(root, directory, "first");
		await assert.rejects(
			acquireWriterLease(root, directory, "second"),
			/writer lease is held by first/,
		);
		await releaseWriterLease(first);
		const stale = await acquireWriterLease(root, directory, "stale");
		await writeFile(stale.path, JSON.stringify({
			...stale,
			processId: 2_000_000_000,
			processToken: "linux:2000000000:missing",
		}));
		const second = await acquireWriterLease(root, directory, "second");
		await releaseWriterLease(second);
	});
});

test("lease wait rechecks ownership when an owner dies silently", async () => {
	await withTempDirectory(async (directory) => {
		const root = join(directory, "leases");
		await mkdir(root);
		const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});
		assert.ok(owner.pid);
		const key = createHash("sha256").update(directory).digest("hex");
		await writeFile(join(root, `${key}.json`), JSON.stringify({
			version: 2,
			ownerId: "silent-owner",
			processId: owner.pid,
			processToken: await processToken(owner.pid),
			cwd: directory,
			createdAt: new Date().toISOString(),
			protectDescendants: false,
		}));
		const waiting = waitForWriterLeaseRelease(root, directory, Date.now() + 1000);
		setTimeout(() => owner.kill("SIGKILL"), 50).unref();
		await waiting;
		const replacement = await acquireWriterLease(root, directory, "replacement");
		await releaseWriterLease(replacement);
	});
});

test("writer lease remains held while a marked writer escapes its process group", async () => {
	await withTempDirectory(async (directory) => {
		const root = join(directory, "leases");
		await mkdir(root);
		const ownerId = randomUUID();
		const key = createHash("sha256").update(directory).digest("hex");
		const path = join(root, `${key}.json`);
		const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			env: { ...process.env, PI_WORKFLOWS_WRITER_OWNER: ownerId },
			stdio: "ignore",
		});
		assert.ok(writer.pid);
		await writeFile(path, JSON.stringify({
			version: 2,
			ownerId,
			processId: 2_000_000_000,
			processToken: "linux:2000000000:missing",
			cwd: directory,
			createdAt: new Date().toISOString(),
			protectDescendants: true,
			processGroupId: await processGroupId(),
		}));
		try {
			await assert.rejects(
				acquireWriterLease(root, directory, "next"),
				/writer lease is held by/,
			);
		} finally {
			writer.kill("SIGKILL");
			await new Promise((resolve) => writer.once("exit", resolve));
		}
		const next = await acquireWriterLease(root, directory, "next");
		await releaseWriterLease(next);
	});
});

test("writer lease release refuses active marked descendants", async () => {
	await withTempDirectory(async (directory) => {
		const root = join(directory, "leases");
		const ownerId = randomUUID();
		const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			env: { ...process.env, PI_WORKFLOWS_WRITER_OWNER: ownerId },
			stdio: "ignore",
		});
		assert.ok(writer.pid);
		let lease = await acquireWriterLease(root, directory, ownerId, {
			protectDescendants: true,
		});
		lease = await setWriterLeaseProcessGroup(lease, writer.pid);
		try {
			await assert.rejects(
				releaseWriterLease(lease),
				/refusing to release a writer lease with active descendants/,
			);
		} finally {
			writer.kill("SIGKILL");
			await new Promise((resolve) => writer.once("exit", resolve));
		}
		await releaseWriterLease(lease);
	});
});

test("writer lease reclaims a dead acquisition guard", async () => {
	await withTempDirectory(async (directory) => {
		const root = join(directory, "leases");
		await mkdir(root);
		const key = createHash("sha256").update(directory).digest("hex");
		const guardPath = join(root, `${key}.json.guard`);
		await writeFile(guardPath, JSON.stringify({
			version: 1,
			processId: 2_000_000_000,
			processToken: "linux:2000000000:missing",
		}));

		const lease = await acquireWriterLease(root, directory, "replacement");
		await assert.rejects(stat(guardPath), { code: "ENOENT" });
		await releaseWriterLease(lease);
	});
});

test("job state rejects every unsupported schema version", async () => {
	await withTempDirectory(async (directory) => {
		for (const version of [0, 1, 2, 3, 5, "4", null]) {
			const state = {
				version,
				id: randomUUID(),
				type: "agent",
				state: "queued",
				createdAt: new Date().toISOString(),
				agent: "test",
				cwd: directory,
			} as unknown as JobState;
			await assert.rejects(writeJobState(directory, state), /invalid job state header/);
		}
	});
});

test("job listing rejects an unsupported schema version", async () => {
	await withTempDirectory(async (directory) => {
		const id = randomUUID();
		const jobDirectory = join(directory, id);
		await mkdir(jobDirectory);
		await writeFile(join(jobDirectory, "state.json"), JSON.stringify({
			version: 1,
			id,
			type: "agent",
			state: "queued",
			createdAt: new Date().toISOString(),
			agent: "test",
			cwd: directory,
		}));
		await assert.rejects(
			listJobStates(directory),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(id) &&
				/invalid job state header/.test(error.message),
			"listing must name the corrupt record, not reject it anonymously",
		);
	});
});

test("failed atomic job-state replacement removes its temporary file", async () => {
	await withTempDirectory(async (directory) => {
		await mkdir(join(directory, "state.json"));
		const createdAt = new Date().toISOString();
		await assert.rejects(writeJobState(directory, {
			version: 4,
			id: randomUUID(),
			type: "agent",
			state: "queued",
			createdAt,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			agent: "test",
			cwd: directory,
		}));
		assert.deepEqual(await readdir(directory), ["state.json"]);
	});
});

test("job state rejects corrupted and oversized files", async () => {
	await withTempDirectory(async (directory) => {
		const path = join(directory, "state.json");
		await writeFile(path, "{not-json");
		await assert.rejects(readJobStateAt(directory), SyntaxError);

		await writeFile(path, "x".repeat(JOB_STATE_BYTES_MAX + 1));
		await assert.rejects(readJobStateAt(directory), /job file exceeds limit/);
	});
});

test("job state rejects duplicate workflow node identities", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const node = {
			id: "duplicate",
			agent: "test",
			task: "test",
			dependsOn: [],
			state: "pending" as const,
		};
		await assert.rejects(writeJobState(directory, {
			version: 4,
			id: randomUUID(),
			type: "workflow",
			state: "running",
			createdAt,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			startedAt: createdAt,
			pid: process.pid,
			processToken: "test-process",
			agent: "workflow-coordinator",
			cwd: directory,
			nodes: [node, node],
		}), /duplicate workflow node identity/);
	});
});

test("job state rejects invalid lifecycle timestamps", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = "2026-01-01T00:00:00.000Z";
		const running: JobState = {
			version: 4,
			id: randomUUID(),
			type: "agent",
			state: "running",
			createdAt,
			deadlineAt: "2026-01-01T01:00:00.000Z",
			startedAt: createdAt,
			pid: process.pid,
			processToken: "test-process",
			agent: "test",
			cwd: directory,
		};
		await assert.rejects(
			writeJobState(directory, { ...running, deadlineAt: "invalid" }),
			/invalid job deadline/,
		);
		await assert.rejects(
			writeJobState(directory, { ...running, startedAt: "invalid" }),
			/invalid job start time/,
		);
		await assert.rejects(
			writeJobState(directory, { ...running, startedAt: "2026-01-01T00:00:00+02:00" }),
			/job start time precedes creation/,
		);
		await assert.rejects(
			writeJobState(directory, {
				...running,
				state: "failed",
				endedAt: "invalid",
				error: "failed",
			}),
			/invalid job end time/,
		);
	});
});

test("job state rejects invalid persisted usage", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = "2026-01-01T00:00:00.000Z";
		await assert.rejects(
			writeJobState(directory, {
				version: 4,
				id: randomUUID(),
				type: "agent",
				state: "running",
				createdAt,
				deadlineAt: "2026-01-01T01:00:00.000Z",
				startedAt: createdAt,
				pid: process.pid,
				processToken: "test-process",
				agent: "test",
				cwd: directory,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: -1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			/invalid usage totalTokens/,
		);
	});
});

test("successful workflow state accepts bounded aggregate usage", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const state: JobState = {
			version: 4,
			id: randomUUID(),
			type: "workflow",
			state: "succeeded",
			createdAt,
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			startedAt: createdAt,
			endedAt: createdAt,
			pid: process.pid,
			processToken: "test-process",
			agent: "workflow-coordinator",
			cwd: directory,
			usage: {
				input: 1_000_000_001,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000_000_001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		await writeJobState(directory, state);
		assert.equal((await readJobStateAt(directory)).usage?.totalTokens, 1_000_000_001);
	});
});

test("job request rejects every unsupported schema version", async () => {
	await withTempDirectory(async (directory) => {
		for (const version of [0, 1, 2, 3, 5, "4", null]) {
			await writeFile(join(directory, "request.json"), JSON.stringify({
				version,
				id: randomUUID(),
				type: "agent",
				createdAt: new Date().toISOString(),
				cwd: directory,
				invocation: { command: "pi", args: [] },
				task: "test",
				agent: testAgent(),
			}));
			await assert.rejects(readJobRequest(directory), /invalid job request/);
		}
	});
});

test("job IDs resolve from unique bounded prefixes", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const ids = [
			"aaaaaaaa-0000-0000-0000-100000000001",
			"aaaaaaaa-0000-0000-0000-200000000002",
		];
		for (const id of ids) {
			const jobDir = join(directory, id);
			await mkdir(jobDir);
			await writeJobState(jobDir, {
				version: 4,
				id,
				type: "agent",
				state: "failed",
				createdAt,
				deadlineAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
				endedAt: createdAt,
				error: "test",
				agent: "test",
				cwd: directory,
			});
		}
		assert.equal(await resolveJobId(directory, ids[0].slice(0, 25)), ids[0]);
		await assert.rejects(resolveJobId(directory, "aaaaaaaa"), /ambiguous job id prefix/);
		await assert.rejects(resolveJobId(directory, "aaaaaaa"), /invalid job id prefix/);
		await assert.rejects(resolveJobId(directory, "bbbbbbbb"), /job id prefix not found/);
	});
});

test("job retention removes only the oldest terminal records", async () => {
	await withTempDirectory(async (directory) => {
		const createdIds: string[] = [];
		for (let index = 0; index < JOB_RETENTION_COUNT_MAX + 3; index += 1) {
			const id = randomUUID();
			createdIds.push(id);
			const jobDir = join(directory, id);
			const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
			await mkdir(jobDir);
			await writeJobState(jobDir, {
				version: 4,
				id,
				type: "agent",
				state: "failed",
				createdAt,
				deadlineAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
				startedAt: createdAt,
				endedAt: createdAt,
				pid: 999_999,
				processToken: `test:${index}`,
				agent: "test",
				cwd: directory,
				error: "finished",
			});
		}
		const activeId = randomUUID();
		const activeDir = join(directory, activeId);
		const activeAt = "2025-01-01T00:00:00.000Z";
		await mkdir(activeDir);
		await writeJobState(activeDir, {
			version: 4,
			id: activeId,
			type: "agent",
			state: "running",
			createdAt: activeAt,
			deadlineAt: "2027-01-01T00:00:00.000Z",
			startedAt: activeAt,
			pid: process.pid,
			processToken: "test:active",
			agent: "test",
			cwd: directory,
		});

		const retainedCount = await pruneJobRecords(directory);
		assert.equal(retainedCount, JOB_RETENTION_COUNT_MAX + 1);
		await stat(activeDir);
		for (const id of createdIds.slice(0, 3)) {
			await assert.rejects(stat(join(directory, id)), { code: "ENOENT" });
		}
		for (const id of createdIds.slice(3)) await stat(join(directory, id));
	});
});

test("job listing fails before an unbounded directory scan", async () => {
	await withTempDirectory(async (directory) => {
		await Promise.all(Array.from(
			{ length: JOB_DIRECTORY_SCAN_COUNT_MAX + 1 },
			(_, index) => writeFile(join(directory, `entry-${index}`), ""),
		));
		await assert.rejects(listJobStates(directory), /job directory scan limit exceeded/);
	});
});

test("job launch reserves directory capacity", async () => {
	await withTempDirectory(async (directory) => {
		await Promise.all(Array.from(
			{ length: JOB_DIRECTORY_SCAN_COUNT_MAX },
			(_, index) => writeFile(join(directory, `entry-${index}`), ""),
		));
		await assert.rejects(
			startAgentJob({
				jobsRoot: directory,
				cwd: directory,
				task: "must not launch",
				agent: testAgent(),
				invocation: { command: process.execPath, args: ["missing-script"] },
			}),
			/job directory limit reached/,
		);
		assert.equal((await readdir(directory)).length, JOB_DIRECTORY_SCAN_COUNT_MAX);
	});
});

test("concurrent job launches serialize admission", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "launch-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop",
				content: [{ type: "text", text: "done" }]
			} }));`,
		);
		const launches = await Promise.all(Array.from({ length: 4 }, (_, index) => {
			return startAgentJob({
				jobsRoot,
				cwd: directory,
				task: `launch ${index}`,
				agent: testAgent(),
				invocation: { command: process.execPath, args: [script] },
			});
		}));
		assert.equal(new Set(launches.map(({ id }) => id)).size, 4);
		await Promise.all(launches.map(({ id }) => waitForJob(jobsRoot, id)));
	});
});

test("job state rejects a non-monotonic transition", async () => {
	await withTempDirectory(async (directory) => {
		const id = randomUUID();
		const createdAt = new Date().toISOString();
		const deadlineAt = new Date(Date.now() + 60_000).toISOString();
		await writeJobState(directory, {
			version: 4,
			id,
			type: "agent",
			state: "queued",
			createdAt,
			deadlineAt,
			agent: "test",
			cwd: directory,
		});
		const running = {
			version: 4 as const,
			id,
			type: "agent" as const,
			state: "running" as const,
			createdAt,
			deadlineAt,
			startedAt: new Date().toISOString(),
			pid: process.pid,
			agent: "test",
			cwd: directory,
			processToken: "test-process",
		};
		await transitionJobState(directory, running);
		await assert.rejects(transitionJobState(directory, running), /illegal job state transition/);
	});
});

test("telemetry updates cannot publish workflow lifecycle changes", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, {
			createdAt,
			type: "workflow",
			agent: "workflow-coordinator",
			nodes: [{
				id: "node",
				agent: "test",
				task: "test",
				dependsOn: [],
				state: "pending",
			}],
		});
		await writeJobState(directory, running);
		await assert.rejects(updateRunningJobTelemetry(directory, {
			...running,
			nodes: [{
				...running.nodes![0],
				state: "running",
				startedAt: createdAt,
			}],
		}), /telemetry update changed authoritative lifecycle/);
		assert.equal((await readJobStateAt(directory)).nodes![0].state, "pending");
	});
});

test("telemetry updates cannot mutate a succeeded node's usage", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const usage = {
			input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const running: JobState = runningJobState(directory, {
			createdAt,
			type: "workflow",
			agent: "workflow-coordinator",
			nodes: [{
				id: "node",
				agent: "test",
				task: "test",
				dependsOn: [],
				state: "succeeded",
				startedAt: createdAt,
				endedAt: createdAt,
				usage,
			}],
		});
		await writeJobState(directory, running);
		await assert.rejects(updateRunningJobTelemetry(directory, {
			...running,
			nodes: [{ ...running.nodes![0], usage: { ...usage, totalTokens: 999 } }],
		}), /telemetry update changed authoritative lifecycle/);
		assert.equal((await readJobStateAt(directory)).nodes![0].usage?.totalTokens, 18);
	});
});

test("telemetry updates preserve lifecycle while publishing activity", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, { createdAt });
		await writeJobState(directory, running);
		const authoritative = await readFile(join(directory, "state.json"), "utf8");
		await updateRunningJobTelemetry(directory, {
			...running,
			activity: "read",
			toolCount: 1,
		});
		assert.equal(await readFile(join(directory, "state.json"), "utf8"), authoritative);
		const telemetry = JSON.parse(await readFile(join(directory, "telemetry.json"), "utf8"));
		assert.equal(telemetry.activity, "read");
		const updated = await readJobStateAt(directory);
		assert.equal(updated.state, "running");
		assert.equal(updated.activity, "read");
		assert.equal(updated.toolCount, 1);
	});
});

test("corrupt telemetry cannot hide authoritative lifecycle state", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, { createdAt });
		await writeJobState(directory, running);
		await writeFile(join(directory, "telemetry.json"), "{broken");
		assert.deepEqual(await readJobStateAt(directory), running);
	});
});

test("failed lifecycle state does not promote pulse usage", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, { createdAt });
		await writeJobState(directory, running);
		await updateRunningJobTelemetry(directory, {
			...running,
			usage: {
				input: 1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const projected = await readJobStateAt(directory);
		assert.equal(projected.usage?.totalTokens, 1);
		await transitionJobState(directory, {
			...projected,
			state: "failed",
			endedAt: new Date().toISOString(),
			error: "failed",
		});
		assert.equal((await readJobStateAt(directory)).usage, undefined);
	});
});

test("workflow lifecycle updates cannot replace an existing node identity", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, {
			createdAt,
			type: "workflow",
			agent: "workflow-coordinator",
			nodes: [{ id: "first", agent: "test", task: "first", dependsOn: [], state: "pending" }],
		});
		await writeJobState(directory, running);
		await assert.rejects(updateRunningJobLifecycle(directory, {
			...running,
			nodes: [{ id: "second", agent: "test", task: "second", dependsOn: [], state: "pending" }],
		}), /workflow update removed an existing node/);
		assert.equal((await readJobStateAt(directory)).nodes![0].id, "first");
	});
});

test("running updates cannot resurrect a terminal job", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, {
			createdAt,
			type: "workflow",
			agent: "workflow-coordinator",
			nodes: [{
				id: "node",
				agent: "test",
				task: "test",
				dependsOn: [],
				state: "running",
				startedAt: createdAt,
			}],
		});
		await mkdir(join(directory, "nodes"));
		await writeFile(join(directory, "nodes", "node.md"), "done");
		await writeJobState(directory, running);
		const updated: JobState = {
			...running,
			nodes: [{
				...running.nodes![0],
				state: "succeeded",
				endedAt: createdAt,
			}],
		};
		await Promise.allSettled([
			updateRunningJobLifecycle(directory, updated),
			transitionJobState(directory, {
				...running,
				state: "failed",
				endedAt: createdAt,
				error: "runner died",
			}),
		]);
		const persisted = await readJobStateAt(directory);
		assert.equal(persisted.state, "failed");
		assert.notEqual(persisted.nodes![0].state, "running");
	});
});

test("the first interruption claim decides cancellation reconciliation", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, { createdAt });
		await writeJobState(directory, running);
		await claimJobInterruption(directory, running, "runner died");
		await claimJobCancellation(directory, running);
		const reconciled = await reconcileInterruptedJobState(directory, "fallback");
		assert.equal(reconciled.state, "failed");
		assert.equal(reconciled.error, "runner died");
	});
});

test("cancellation intent prevents success publication", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const running: JobState = runningJobState(directory, { createdAt });
		await writeJobState(directory, running);
		await writeFile(join(directory, "result.md"), "result");
		await claimJobCancellation(directory, running);
		await assert.rejects(
			transitionJobState(directory, {
				...running,
				state: "succeeded",
				endedAt: createdAt,
			}),
			/cancellation requested before success publication/,
		);
	});
});

test("job transitions serialize competing writers", async () => {
	await withTempDirectory(async (directory) => {
		for (let index = 0; index < 8; index += 1) {
			const jobDir = join(directory, String(index));
			await mkdir(jobDir);
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			const deadlineAt = new Date(Date.now() + 60_000).toISOString();
			const queued: JobState = {
				version: 4,
				id,
				type: "agent",
				state: "queued",
				createdAt,
				deadlineAt,
				agent: "test",
				cwd: directory,
			};
			await writeJobState(jobDir, queued);
			const outcomes = await Promise.allSettled([
				transitionJobState(jobDir, {
					...queued,
					state: "running",
					startedAt: createdAt,
					pid: process.pid,
					processToken: "test-process",
				}),
				transitionJobState(jobDir, {
					...queued,
					state: "failed",
					endedAt: createdAt,
					error: "startup failed",
				}),
			]);
			assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
		}
	});
});

test("job wait uses the persisted job deadline", async () => {
	await withTempDirectory(async (directory) => {
		const createdAt = new Date().toISOString();
		const id = randomUUID();
		const jobDirectory = join(directory, id);
		await mkdir(jobDirectory);
		const token = await processToken(process.pid);
		const liveness = await listenForJobLiveness(jobDirectory, token);
		try {
			await writeJobState(jobDirectory, {
				version: 4,
				id,
				type: "agent",
				state: "running",
				createdAt,
				deadlineAt: new Date(Date.now() + 50).toISOString(),
				startedAt: createdAt,
				pid: process.pid,
				processToken: token,
				agent: "test",
				cwd: directory,
			});
			const state = await readJobStateAt(jobDirectory);
			await assert.rejects(
				waitForJob(directory, state.id),
				/exceeded its persisted deadline/,
			);
		} finally {
			await liveness.close();
		}
	});
});

test("terminal job state wins either liveness event order", async () => {
	await withTempDirectory(async (directory) => {
		for (const closeImmediately of [false, true]) {
			const id = randomUUID();
			const jobDir = join(directory, id);
			const createdAt = new Date().toISOString();
			const token = await processToken(process.pid);
			await mkdir(jobDir);
			const server = await listenForJobLiveness(jobDir, token);
			await writeJobState(jobDir, {
				version: 4, id, type: "agent", state: "running", createdAt,
				deadlineAt: new Date(Date.now() + 10_000).toISOString(),
				startedAt: createdAt, pid: process.pid, processToken: token,
				agent: "test", cwd: directory,
			});
			let resolveConnected: () => void = () => {};
			const connected = new Promise<void>((resolve) => {
				resolveConnected = resolve;
			});
			const waiting = waitForJob(directory, id, undefined, resolveConnected);
			await connected;
			const running = await readJobStateAt(jobDir);
			await transitionJobState(jobDir, {
				...running,
				state: "failed",
				endedAt: new Date().toISOString(),
				error: "planned terminal state",
			});
			if (closeImmediately) await server.close();
			const failed = await withTestTimeout(waiting, 1000);
			assert.equal(failed.error, "planned terminal state");
			if (!closeImmediately) await server.close();
		}
	});
});

test("job liveness bounds observers and removes its socket", async () => {
	await withTempDirectory(async (directory) => {
		const token = await processToken(process.pid);
		const server = await listenForJobLiveness(directory, token);
		const socketPath = join(directory, "liveness.sock");
		assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
		const monitors = await Promise.all(
			Array.from({ length: 16 }, () => (
				connectToJobLiveness(directory, process.pid, token)
			)),
		);
		try {
			await assert.rejects(
				connectToJobLiveness(directory, process.pid, token),
				(error) => error instanceof JobLivenessError && error.kind === "observer-limit",
			);
		} finally {
			for (const monitor of monitors) monitor.close();
			await server.close();
		}
		await assert.rejects(stat(socketPath), { code: "ENOENT" });
	});
});

test("job liveness rejects a mismatched handshake", async () => {
	await withTempDirectory(async (directory) => {
		const server = createServer((socket) => socket.end("wrong identity\n"));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(join(directory, "liveness.sock"), resolve);
		});
		try {
			const token = await processToken(process.pid);
			await assert.rejects(
				connectToJobLiveness(directory, process.pid, token),
				(error) => error instanceof JobLivenessError && error.kind === "protocol",
			);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
		}
	});
});

test("job liveness rejects oversized and pre-existing endpoints", async () => {
	const token = await processToken(process.pid);
	await assert.rejects(
		listenForJobLiveness(`/tmp/${"x".repeat(101)}`, token),
		/socket path exceeds limit/,
	);
	await withTempDirectory(async (directory) => {
		await assert.rejects(
			listenForJobLiveness(directory, "x".repeat(300)),
			/handshake exceeds limit/,
		);
		await writeFile(join(directory, "liveness.sock"), "occupied");
		await assert.rejects(
			listenForJobLiveness(directory, token),
			/socket already exists/,
		);
	});
});

test("JSONL decoder accepts split UTF-8 and an unterminated final record", () => {
	const values: unknown[] = [];
	const decoder = new JsonlDecoder((value) => values.push(value));
	const input = Buffer.from('{"text":"héllo"}\n{"done":true}', "utf8");
	const split = input.indexOf(Buffer.from("é")) + 1;
	decoder.feed(input.subarray(0, split));
	decoder.feed(input.subarray(split));
	decoder.finish();
	assert.deepEqual(values, [{ text: "héllo" }, { done: true }]);
});

test("JSONL decoder rejects malformed records", () => {
	const decoder = new JsonlDecoder(() => undefined);
	assert.throws(() => decoder.feed(Buffer.from("{not-json}\n")), SyntaxError);
});

test("JSONL decoder rejects an oversized input chunk", () => {
	const decoder = new JsonlDecoder(() => undefined);
	assert.throws(
		() => decoder.feed(Buffer.alloc(JSONL_RECORD_BYTES_MAX + 1)),
		/JSONL chunk exceeds limit/,
	);
});

test("JSONL decoder rejects a record accumulated beyond its bound", () => {
	const decoder = new JsonlDecoder(() => undefined);
	decoder.feed(Buffer.alloc(JSONL_RECORD_BYTES_MAX, 0x20));
	assert.throws(
		() => decoder.feed(Buffer.from("x")),
		/JSONL record exceeds limit/,
	);
});

test("JSONL decoder rejects an excessive record count", () => {
	const decoder = new JsonlDecoder(() => undefined);
	assert.throws(
		() => decoder.feed(Buffer.from("{}\n".repeat(JSONL_RECORD_COUNT_MAX + 1))),
		/JSONL record count exceeds limit/,
	);
});

test("agent runner rejects an oversized JSONL record", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "oversized-jsonl-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write("x".repeat(${JSONL_RECORD_BYTES_MAX + 1}));`,
		);
		await assert.rejects(
			runAgent({
				invocation: { command: process.execPath, args: [script] },
				agent: testAgent(),
				task: "Return an oversized protocol record",
				cwd: directory,
			}),
			/JSONL record exceeds limit/,
		);
	});
});

test("agent runner bounds the retained final response", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "large-output-pi.mjs");
		await writeFile(
			script,
			`const text = "é".repeat(${AGENT_OUTPUT_BYTES_MAX});
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));`,
		);
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Return a large response",
			cwd: directory,
		});
		assert.ok(Buffer.byteLength(result.output) <= AGENT_OUTPUT_BYTES_MAX);
		assert.match(result.output, /\[output truncated\]$/);
		assert.doesNotMatch(result.output, /�/);
	});
});

test("agent runner extracts the final assistant response", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "fake-pi.mjs");
		await writeFile(
			script,
			`const event = ${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					model: "test/model",
					stopReason: "end",
					content: [{ type: "text", text: "finished" }],
					usage: {
						input: 10,
						output: 5,
						cacheRead: 2,
						cacheWrite: 1,
						totalTokens: 18,
						cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
					},
				},
			})};\nprocess.stdout.write(JSON.stringify(event));`,
		);
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Review the change",
			cwd: directory,
		});
		assert.equal(result.output, "finished");
		assert.equal(result.model, "test/model");
		assert.equal(result.stopReason, "end");
		assert.equal(result.exitCode, 0);
		assert.equal(result.usage.totalTokens, 18);
		assert.equal(result.usage.cost.total, 10);
	});
});

test("agent runner follows multi-turn tool progress to the final response", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "multi-turn-pi.mjs");
		await writeFile(
			script,
			`const events = [
				{ type: "message_end", message: { role: "assistant", stopReason: "toolUse",
					content: [{ type: "text", text: "checking" }], usage: { totalTokens: 3 } } },
				{ type: "tool_execution_start", toolName: "read" },
				{ type: "message_end", message: { role: "assistant", stopReason: "stop",
					content: [{ type: "text", text: "finished" }], usage: { totalTokens: 5 } } },
			];
			process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n"));`,
		);
		const updates: Array<{ tool?: string; toolCount: number }> = [];
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Read then finish",
			cwd: directory,
			onUpdate: (update) => updates.push(update),
		});
		assert.equal(result.output, "finished");
		assert.equal(result.usage.totalTokens, 8);
		assert.ok(updates.some((update) => update.tool === "read" && update.toolCount === 1));
		assert.equal(updates.at(-1)?.toolCount, 1);
	});
});

test("agent runner rejects an empty final response", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "empty-response-pi.mjs");
		await writeFile(
			script,
			`const events = [
				{ type: "message_end", message: { role: "assistant", stopReason: "toolUse",
					content: [{ type: "text", text: "checking" }] } },
				{ type: "message_end", message: { role: "assistant", stopReason: "stop",
					content: [{ type: "text", text: "  " }] } },
			];
			process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n"));`,
		);
		await assert.rejects(
			runAgent({
				invocation: { command: process.execPath, args: [script] },
				agent: testAgent(),
				task: "Return no text",
				cwd: directory,
			}),
			/agent returned no final text/,
		);
	});
});

test("agent runner observes exit during process-group setup", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "fast-exit-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop",
				content: [{ type: "text", text: "done" }]
			} }));`,
		);
		let processId = 0;
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Exit during setup",
			cwd: directory,
			onProcessGroup: async (childProcessId) => {
				processId = childProcessId;
				await new Promise((resolve) => setTimeout(resolve, 100));
			},
		});
		assert.ok(processId > 1);
		assert.equal(result.output, "done");
	});
});

test("agent runner marks writer process ownership", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "writer-owner-pi.mjs");
		await writeFile(
			script,
			`const text = process.env.PI_WORKFLOWS_WRITER_OWNER ?? "missing";
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));`,
		);
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent({ access: "write", tools: ["read", "write"] }),
			task: "Check writer ownership",
			cwd: directory,
			writerOwnerId: "writer-test",
		});
		assert.equal(result.output, "writer-test");
	});
});

test("agent runner passes a forked session to the child", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "session-pi.mjs");
		await writeFile(
			script,
			`const index = process.argv.indexOf("--session");
			const text = index >= 0 ? process.argv[index + 1] : "missing";
			const event = { type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} };
			process.stdout.write(JSON.stringify(event));`,
		);
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Continue",
			cwd: directory,
			sessionFile: "/tmp/fork.jsonl",
		});
		assert.equal(result.output, "/tmp/fork.jsonl");
	});
});

test("agent runner replaces the system prompt when configured", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "prompt-pi.mjs");
		await writeFile(
			script,
			`const replace = process.argv.indexOf("--system-prompt");
			const append = process.argv.indexOf("--append-system-prompt");
			const text = replace >= 0 && append < 0 ? process.argv[replace + 1] : "wrong";
			const event = { type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} };
			process.stdout.write(JSON.stringify(event));`,
		);
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent({ systemPromptMode: "replace" }),
			task: "Review",
			cwd: directory,
		});
		assert.equal(result.output, "Review only.");
	});
});

test("agent runner distinguishes all and disabled skill modes", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "skill-mode-pi.mjs");
		await writeFile(
			script,
			`const text = JSON.stringify({ noSkills: process.argv.includes("--no-skills"),
				named: process.argv.includes("--skill") });
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));`,
		);
		const invocation = { command: process.execPath, args: [script] };
		const disabled = await runAgent({
			invocation,
			agent: testAgent({ skills: "none" }),
			task: "Check disabled skills",
			cwd: directory,
		});
		const all = await runAgent({
			invocation,
			agent: testAgent({ skills: "all" }),
			task: "Check all skills",
			cwd: directory,
		});
		assert.deepEqual(JSON.parse(disabled.output), { noSkills: true, named: false });
		assert.deepEqual(JSON.parse(all.output), { noSkills: false, named: false });
	});
});

test("agent runner rejects a provider stop reason", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "provider-error-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "error", errorMessage: "provider unavailable",
				content: []
			} }));`,
		);
		await assert.rejects(
			runAgent({
				invocation: { command: process.execPath, args: [script] },
				agent: testAgent(),
				task: "Trigger provider failure",
				cwd: directory,
			}),
			/provider unavailable/,
		);
	});
});

test("agent runner rejects a tool-use stop as incomplete", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "tool-use-stop-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "toolUse",
				content: [{ type: "text", text: "partial" }]
			} }));`,
		);
		await assert.rejects(runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Stop before tool execution",
			cwd: directory,
		}), /agent stopped with reason: toolUse/);
	});
});

test("agent runner rejects invalid usage values", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "invalid-usage-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }],
				usage: { totalTokens: -1 }
			} }));`,
		);
		await assert.rejects(
			runAgent({
				invocation: { command: process.execPath, args: [script] },
				agent: testAgent(),
				task: "Trigger invalid usage",
				cwd: directory,
			}),
			/invalid usage totalTokens/,
		);
	});
});

test("agent runner reports a child process failure", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "failing-pi.mjs");
		await writeFile(script, 'process.stderr.write("provider unavailable"); process.exit(7);');
		await assert.rejects(
			runAgent({
				invocation: { command: process.execPath, args: [script] },
				agent: testAgent(),
				task: "Review the change",
				cwd: directory,
			}),
			/provider unavailable/,
		);
	});
});

test("agent runner retains only the bounded stderr tail", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "large-stderr-pi.mjs");
		await writeFile(
			script,
			`const text = "head-marker" + "x".repeat(${STDERR_BYTES_MAX}) + "tail-marker";
			process.stderr.write(text, () => process.exit(1));`,
		);
		await assert.rejects(
			runAgent({
				invocation: { command: process.execPath, args: [script] },
				agent: testAgent(),
				task: "Fail with bounded diagnostics",
				cwd: directory,
			}),
			(error: Error) => {
				assert.ok(Buffer.byteLength(error.message) <= STDERR_BYTES_MAX);
				assert.doesNotMatch(error.message, /head-marker/);
				assert.match(error.message, /tail-marker$/);
				return true;
			},
		);
	});
});

test("background failure diagnostics remain inside their UTF-8 byte bound", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "background-error-pi.mjs");
		await mkdir(jobsRoot);
		await writeFile(
			script,
			`process.stderr.write("€".repeat(5000), () => process.exit(1));`,
		);
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Fail with large diagnostics",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		const finished = await waitForJob(jobsRoot, started.id);
		assert.equal(finished.state, "failed");
		assert.ok(finished.error);
		assert.ok(Buffer.byteLength(finished.error) <= 4096);
		assert.doesNotMatch(finished.error, /�/);
	});
});

test("background failure survives an unwritable diagnostic log", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "delayed-failure-pi.mjs");
		await writeFile(
			script,
			`setTimeout(() => {
				process.stderr.write("provider unavailable");
				process.exit(7);
			}, 200);`,
		);
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Fail after startup",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		await mkdir(join(jobsRoot, started.id, "stderr.log"));
		const failed = await waitForJob(jobsRoot, started.id);
		assert.equal(failed.state, "failed");
		assert.match(failed.error ?? "", /provider unavailable/);
	});
});

test("background agent job persists its result", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "background-pi.mjs");
		await mkdir(jobsRoot);
		await writeFile(
			script,
			`const tool = { type: "tool_execution_start", toolName: "read" };
			process.stdout.write(JSON.stringify(tool) + "\\n");
			setTimeout(() => {
				const event = { type: "message_end", message: {
					role: "assistant", stopReason: "stop",
					content: [{ type: "text", text: "background result" }]
				} };
				process.stdout.write(JSON.stringify(event));
			}, 300);`,
		);
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Run in background",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		const observed: JobState[] = [];
		const finished = await waitForJob(
			jobsRoot,
			started.id,
			undefined,
			(state) => observed.push(state),
		);
		assert.equal(finished.state, "succeeded");
		assert.ok(observed.some((state) => state.activity === "read"));
		assert.ok(observed.some((state) => state.toolCount === 1));
		assert.equal(finished.activity, undefined);
		assert.equal(finished.toolCount, undefined);
		const persisted = JSON.parse(await readFile(
			join(jobsRoot, started.id, "state.json"),
			"utf8",
		));
		assert.equal(persisted.activity, undefined);
		assert.equal(persisted.toolCount, undefined);
		assert.equal(await readJobResult(jobsRoot, started.id), "background result");
	});
});

test("background agent job survives its launching process", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "delayed-pi.mjs");
		const launcher = join(directory, "launcher.ts");
		const idFile = join(directory, "job-id");
		await mkdir(jobsRoot);
		await writeFile(
			script,
			`setTimeout(() => process.stdout.write(JSON.stringify({
				type: "message_end", message: { role: "assistant", stopReason: "stop",
				content: [{ type: "text", text: "survived" }] }
			})), 300);`,
		);
		const jobsModule = new URL("../job-control.ts", import.meta.url).pathname;
		await writeFile(
			launcher,
			`import { writeFile } from "node:fs/promises";
			import { startAgentJob } from ${JSON.stringify(jobsModule)};
			const state = await startAgentJob(${JSON.stringify({
				jobsRoot,
				cwd: directory,
				task: "Survive",
				agent: testAgent(),
				invocation: { command: process.execPath, args: [script] },
			})});
			await writeFile(${JSON.stringify(idFile)}, state.id);`,
		);
		const child = spawn(process.execPath, ["--experimental-strip-types", launcher], {
			stdio: "ignore",
		});
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
		});
		const id = await readFile(idFile, "utf8");
		const observed: string[] = [];
		const finished = await waitForJob(
			jobsRoot,
			id,
			undefined,
			(state) => observed.push(state.state),
		);
		assert.equal(finished.state, "succeeded");
		assert.equal(observed[0], "running");
		assert.equal(observed.at(-1), "succeeded");
		assert.equal(await readJobResult(jobsRoot, id), "survived");
	});
});

test("job wait observes SIGKILL through runner liveness", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "killed-pi.mjs");
		await mkdir(jobsRoot);
		await writeFile(script, "setInterval(() => undefined, 1000);");
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Wait for SIGKILL",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		let connectedResolve: () => void = () => {};
		const connected = new Promise<void>((resolve) => {
			connectedResolve = resolve;
		});
		const waiting = waitForJob(jobsRoot, started.id, undefined, connectedResolve);
		await connected;
		assert.ok(started.pid);
		process.kill(-started.pid, "SIGKILL");
		const failed = await withTestTimeout(waiting, 1000);
		assert.equal(failed.state, "failed");
		assert.equal(failed.error, "job runner exited without a terminal state");
	});
});

test("runner death with cancellation intent becomes cancelled", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "cancelled-kill-pi.mjs");
		await writeFile(script, "setInterval(() => undefined, 1000);");
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Wait for forced cancellation",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		const jobDir = join(jobsRoot, started.id);
		await claimJobCancellation(jobDir, started);
		assert.ok(started.pid);
		process.kill(-started.pid, "SIGKILL");
		const cancelled = await withTestTimeout(waitForJob(jobsRoot, started.id), 1000);
		assert.equal(cancelled.state, "cancelled");
		assert.equal(cancelled.error, "agent run aborted");
	});
});

test("concurrent waiters reconcile one runner failure", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "concurrent-wait-pi.mjs");
		await mkdir(jobsRoot);
		await writeFile(script, "setInterval(() => undefined, 1000);");
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Wait concurrently",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		const connected: Array<Promise<void>> = [];
		const waiters = Array.from({ length: 2 }, () => {
			let resolveConnected: () => void = () => {};
			connected.push(new Promise<void>((resolve) => {
				resolveConnected = resolve;
			}));
			return waitForJob(jobsRoot, started.id, undefined, resolveConnected);
		});
		await Promise.all(connected);
		assert.ok(started.pid);
		process.kill(-started.pid, "SIGKILL");
		const results = await withTestTimeout(Promise.all(waiters), 1000);
		assert.deepEqual(results.map((state) => state.state), ["failed", "failed"]);
		assert.equal(results[0].endedAt, results[1].endedAt);
		const persisted = await readJobStateAt(join(jobsRoot, started.id));
		assert.equal(persisted.state, "failed");
		assert.equal(persisted.endedAt, results[0].endedAt);
		const claim = JSON.parse(
			await readFile(join(jobsRoot, started.id, "interruption.json"), "utf8"),
		);
		assert.equal(claim.endedAt, persisted.endedAt);
	});
});

test("job wait connects after runner SIGKILL", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "killed-before-wait-pi.mjs");
		await mkdir(jobsRoot);
		await writeFile(script, "setInterval(() => undefined, 1000);");
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Die before wait",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		assert.ok(started.pid);
		process.kill(-started.pid, "SIGKILL");
		const failed = await withTestTimeout(waitForJob(jobsRoot, started.id), 1000);
		assert.equal(failed.state, "failed");
		assert.equal(failed.error, "job runner exited without a terminal state");
	});
});

test("workflow supports rejected implementation, fix, and re-review", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "review-loop-pi.mjs");
		const markerDir = join(directory, "review-markers");
		await mkdir(markerDir);
		await writeFile(script, `
			import { readdirSync, writeFileSync } from "node:fs";
			import { join } from "node:path";
			const task = process.argv.at(-1);
			const phase = task.startsWith("review initial") ? "initial" :
				task.startsWith("review fixed") ? "fixed" : undefined;
			if (phase) {
				writeFileSync(join(${JSON.stringify(markerDir)}, phase + "-" + process.pid), "");
				const count = () => readdirSync(${JSON.stringify(markerDir)})
					.filter((entry) => entry.startsWith(phase)).length;
				const deadline = Date.now() + 1000;
				while (count() < 2 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				if (count() < 2) process.exit(2);
			}
			let text = "implemented";
			if (task.startsWith("review initial")) text = [
				"Verdict: FAIL", "Findings:", "- Severity: blocking",
				"  File: fixture.ts:1", "  Evidence: concrete failure",
				"  Failure scenario: input produces wrong output", "  Smallest fix: correct it"
			].join("\\n");
			if (task.startsWith("fix implementation")) text = "fixed";
			if (task.startsWith("review fixed")) text = "Verdict: PASS\\nFindings: none";
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));
		`);
		const implementer = testAgent({
			name: "implementer",
			access: "write",
			tools: ["read", "write"],
		});
		const correctness = testAgent({ name: "correctness-reviewer" });
		const contextStyle = testAgent({ name: "context-style-reviewer" });
		const planner = testAgent({ name: "planner" });
		const jobDir = await createRunningWorkflow(
			directory,
			script,
			[implementer, correctness, contextStyle, planner],
		);
		await seedPlan(jobDir);
		await runRejectedReviewLoop(jobDir, { implementer, correctness, contextStyle });
	});
});

test("workflow rejects a fix after malformed review verdicts", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "malformed-review-pi.mjs");
		await writeFile(script, `process.stdout.write(JSON.stringify({
			type: "message_end", message: { role: "assistant", stopReason: "stop",
			content: [{ type: "text", text: "not a verdict" }] }
		}));`);
		const implementer = testAgent({
			name: "implementer",
			access: "write",
			tools: ["read", "write"],
		});
		const correctness = testAgent({ name: "correctness-reviewer" });
		const contextStyle = testAgent({ name: "context-style-reviewer" });
		const planner = testAgent({ name: "planner" });
		const jobDir = await createRunningWorkflow(
			directory,
			script,
			[implementer, correctness, contextStyle, planner],
		);
		await seedPlan(jobDir);
		await runWorkflowNodes(jobDir, [{
			id: "writer",
			agent: implementer.name,
			task: "implement",
			dependsOn: ["plan"],
		}]);
		await runWorkflowNodes(jobDir, [
			{ id: "correctness", agent: correctness.name, task: "review", dependsOn: ["writer"] },
			{ id: "context", agent: contextStyle.name, task: "review", dependsOn: ["writer"] },
		]);
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: "unrelated",
			agent: correctness.name,
			task: "must not run",
		}]), /review verdict must be PASS or FAIL/);
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: "fix",
			agent: implementer.name,
			task: "must not run",
			dependsOn: ["plan", "correctness", "context"],
		}]), /review verdict must be PASS or FAIL/);
	});
});

test("workflow rejects a fix after a non-actionable FAIL", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "bare-fail-review-pi.mjs");
		await writeFile(script, `
			const task = process.argv.at(-1);
			let text = "implemented";
			if (task.startsWith("correctness")) text = [
				"Verdict: FAIL", "- Severity: blocking", "  File: fixture.ts:1",
				"  Evidence: concrete failure", "  Failure scenario: wrong result",
				"  Smallest fix: correct it"
			].join("\\n");
			if (task.startsWith("context")) text = [
				"Verdict: FAIL", "- Severity: blocking", "  File: fixture.ts:1",
				"  Evidence: concrete failure", "  Violated rule: exact rule",
				"  Smallest fix: correct it", "- Severity: blocking", "  File: T B D",
				"  Evidence: N / A", "  Violated rule: placeholder.", "  Smallest fix: TODO!"
			].join("\\n");
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));
		`);
		const implementer = testAgent({
			name: "implementer",
			access: "write",
			tools: ["read", "write"],
		});
		const correctness = testAgent({ name: "correctness-reviewer" });
		const contextStyle = testAgent({ name: "context-style-reviewer" });
		const planner = testAgent({ name: "planner" });
		const jobDir = await createRunningWorkflow(
			directory,
			script,
			[implementer, correctness, contextStyle, planner],
		);
		await seedPlan(jobDir);
		await runWorkflowNodes(jobDir, [
			{ id: "writer", agent: implementer.name, task: "implement", dependsOn: ["plan"] },
		]);
		await runWorkflowNodes(jobDir, [
			{
				id: "correctness",
				agent: correctness.name,
				task: "correctness review",
				dependsOn: ["writer"],
			},
			{
				id: "context",
				agent: contextStyle.name,
				task: "context review",
				dependsOn: ["writer"],
			},
		]);
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: "fix",
			agent: implementer.name,
			task: "must not run",
			dependsOn: ["plan", "correctness", "context"],
		}]), /FAIL review is not actionable/);
	});
});

test("workflow refuses a writer without both reviewer roles", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "missing-reviewers-pi.mjs");
		await writeFile(script, "process.exit(0);");
		const implementer = testAgent({
			name: "implementer",
			access: "write",
			tools: ["read", "write"],
		});
		const jobDir = await createRunningWorkflow(directory, script, [implementer]);
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: "writer",
			agent: implementer.name,
			task: "must not start",
		}]), /writer requires read-only correctness-reviewer/);
	});
});

test("workflow gates a writer behind a succeeded plan", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "plan-gate-pi.mjs");
		await writeFile(script, "process.exit(0);");
		const implementer = testAgent({ name: "implementer", access: "write", tools: ["read", "write"] });
		const correctness = testAgent({ name: "correctness-reviewer" });
		const contextStyle = testAgent({ name: "context-style-reviewer" });
		const withoutPlanner = await createRunningWorkflow(directory, script, [
			implementer, correctness, contextStyle,
		]);
		await assert.rejects(runWorkflowNodes(withoutPlanner, [{
			id: "writer",
			agent: implementer.name,
			task: "must not start",
		}]), /writer requires read-only planner/);
		const planner = testAgent({ name: "planner" });
		const jobDir = await createRunningWorkflow(directory, script, [
			implementer, correctness, contextStyle, planner,
		]);
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: "writer",
			agent: implementer.name,
			task: "must not start",
		}]), /writer must depend on a succeeded plan/);
	});
});

test("workflow review gate rejects an unsuccessful writer", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "failed-writer-pi.mjs");
		await writeFile(script, "process.stderr.write('failed'); process.exit(2);");
		const implementer = testAgent({
			name: "implementer",
			access: "write",
			tools: ["read", "write"],
		});
		const correctness = testAgent({ name: "correctness-reviewer" });
		const contextStyle = testAgent({ name: "context-style-reviewer" });
		const planner = testAgent({ name: "planner" });
		const agents = [implementer, correctness, contextStyle, planner];
		const jobDir = await createRunningWorkflow(directory, script, agents);
		await seedPlan(jobDir);
		const result = await runWorkflowNodes(jobDir, [{
			id: "failed-writer",
			agent: implementer.name,
			task: "fail",
			dependsOn: ["plan"],
		}]);
		assert.equal(result.nodes[0].state, "failed");
		await assert.rejects(
			assertWorkflowReviews(jobDir, await readJobStateAt(jobDir), agents),
			/writer failed-writer did not succeed/,
		);
	});
});

test("workflow refuses a writer without capacity for two reviews", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "capacity-pi.mjs");
		await writeFile(script, "process.exit(0);");
		const implementer = testAgent({
			name: "implementer",
			access: "write",
			tools: ["read", "write"],
		});
		const scout = testAgent({ name: "scout" });
		const correctness = testAgent({ name: "correctness-reviewer" });
		const contextStyle = testAgent({ name: "context-style-reviewer" });
		const planner = testAgent({ name: "planner" });
		const agents = [implementer, scout, correctness, contextStyle, planner];
		const jobDir = await createRunningWorkflow(directory, script, agents);
		const state = await readJobStateAt(jobDir);
		await writeJobState(jobDir, {
			...state,
			nodes: [
				succeededPlanNode(),
				...Array.from({ length: 61 }, (_, index) => ({
					id: `existing-${index}`,
					agent: "scout",
					task: "existing",
					dependsOn: [],
					state: "pending" as const,
				})),
			],
		});
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: "unsafe-writer",
			agent: implementer.name,
			task: "must not start",
			dependsOn: ["plan"],
		}]), /writer requires capacity for two review nodes/);
	});
});

test("workflow runs five independent read-only nodes concurrently", async () => {
	await withTempDirectory(async (directory) => {
		const id = randomUUID();
		const jobDir = join(directory, id);
		const markerDir = join(directory, "markers");
		const script = join(directory, "five-node-pi.mjs");
		const createdAt = new Date().toISOString();
		await mkdir(jobDir);
		await mkdir(markerDir);
		await writeFile(script, `
			import { readdirSync, writeFileSync } from "node:fs";
			import { join } from "node:path";
			const markerDir = ${JSON.stringify(markerDir)};
			writeFileSync(join(markerDir, String(process.pid)), "");
			const deadline = Date.now() + 1000;
			while (readdirSync(markerDir).length < 5 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (readdirSync(markerDir).length < 5) process.exit(2);
			const text = process.argv.at(-1);
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));
		`);
		const agent = testAgent({ skills: "none" });
		await writeFile(join(jobDir, "request.json"), JSON.stringify({
			version: 4,
			id,
			type: "workflow",
			createdAt,
			cwd: directory,
			goal: "Test five-node concurrency",
			agents: [agent],
			invocation: { command: process.execPath, args: [script] },
		}));
		await writeJobState(jobDir, runningJobState(directory, {
			id,
			createdAt,
			type: "workflow",
			agent: "workflow-coordinator",
			nodes: [],
		}));
		const result = await runWorkflowNodes(jobDir, Array.from({ length: 5 }, (_, index) => ({
			id: `scout-${index}`,
			agent: agent.name,
			task: `perspective-${index}`,
		})));
		assert.equal(result.nodes.length, 5);
		assert(result.nodes.every((node) => node.state === "succeeded"));
		const synthesis = await runWorkflowNodes(jobDir, [{
			id: "synthesis",
			agent: agent.name,
			task: "combine all perspectives",
			dependsOn: result.nodes.map((node) => node.id),
		}]);
		assert.equal(synthesis.nodes[0].state, "succeeded");
		assert.match(synthesis.text, /perspective-0/);
		assert.match(synthesis.text, /perspective-4/);
	});
});

test("workflow nodes serialize graph mutation", async () => {
	await withTempDirectory(async (directory) => {
		const { agent, jobDir } = await createGraphWorkflow(directory);
		const guarded = runWorkflowNodes(
			jobDir,
			[{ id: "serial-guard", agent: agent.name, task: "left result" }],
		);
		await assert.rejects(
			runWorkflowNodes(
				jobDir,
				[{ id: "intruder", agent: agent.name, task: "must not run" }],
			),
			/workflow graph mutation is already active/,
		);
		await guarded;
	});
});

test("workflow nodes support fan-out and dependency fan-in", async () => {
	await withTempDirectory(async (directory) => {
		const { agent, id, jobDir } = await createGraphWorkflow(directory);
		const fanOut = await runWorkflowNodes(jobDir, [
			{ id: "left", agent: agent.name, task: "left result" },
			{ id: "right", agent: agent.name, task: "right result" },
		]);
		assert.deepEqual(fanOut.nodes.map((node) => node.id), ["left", "right"]);
		assert(fanOut.nodes.every((node) => node.state === "succeeded"));
		const fanIn = await runWorkflowNodes(jobDir, [{
			id: "synthesis",
			agent: agent.name,
			task: "combine",
			dependsOn: ["left", "right"],
		}]);
		assert.match(fanIn.text, /left result/);
		assert.match(fanIn.text, /right result/);
		const state = await readJobStateAt(jobDir);
		await writeJobResult(jobDir, "Self-contained answer.", state);
		await transitionJobState(jobDir, {
			...state,
			state: "succeeded",
			endedAt: new Date().toISOString(),
		});
		const report = await readJobResult(directory, id);
		const projection = await readJobProjection(directory, id, true);
		assert.equal(projection.resultPath, join(jobDir, "result.md"));
		assert.deepEqual(
			projection.nodeArtifacts.map((artifact) => artifact.nodeId),
			["left", "right", "synthesis"],
		);
		assert.match(report, /\[left — reviewer\]\(nodes\/left\.md\)/);
	});
});

test("workflow nodes support failure, retry, and cancellation", async () => {
	await withTempDirectory(async (directory) => {
		const { agent, jobDir } = await createGraphWorkflow(directory);
		const failed = await runWorkflowNodes(
			jobDir,
			[{ id: "attempt-1", agent: agent.name, task: "fail" }],
		);
		assert.equal(failed.nodes[0].state, "failed");
		const largeFailure = await runWorkflowNodes(
			jobDir,
			[{ id: "large-failure", agent: agent.name, task: "large failure" }],
		);
		assert.equal(largeFailure.nodes[0].state, "failed");
		assert.ok(Buffer.byteLength(largeFailure.nodes[0].error ?? "") <= 4096);
		assert.doesNotMatch(largeFailure.nodes[0].error ?? "", /�/);
		await assert.rejects(runWorkflowNodes(jobDir, [{
			id: "invalid-successor",
			agent: agent.name,
			task: "must not run",
			dependsOn: ["attempt-1"],
		}]), /dependency is not already succeeded/);
		const retry = await runWorkflowNodes(
			jobDir,
			[{ id: "attempt-2", agent: agent.name, task: "retry result" }],
		);
		assert.equal(retry.nodes[0].state, "succeeded");
		const controller = new AbortController();
		controller.abort();
		const cancelled = await runWorkflowNodes(
			jobDir,
			[{ id: "cancelled", agent: agent.name, task: "must not run" }],
			controller.signal,
		);
		assert.equal(cancelled.nodes[0].state, "cancelled");
	});
});

test("workflow writers run alone and drain descendants before release", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "writer-isolation-pi.mjs");
		const activePath = join(directory, "writer-active");
		const descendantPidPath = join(directory, "writer-descendant.pid");
		await writeFile(
			script,
			`import { spawn } from "node:child_process";
			import { access, rm, writeFile } from "node:fs/promises";
			const task = process.argv.at(-1);
			let text = task;
			if (task.startsWith("writer")) {
				const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
					detached: true,
					stdio: "ignore"
				});
				child.unref();
				await writeFile(${JSON.stringify(descendantPidPath)}, String(child.pid));
				await writeFile(${JSON.stringify(activePath)}, "active");
				await new Promise((resolve) => setTimeout(resolve, 200));
				await rm(${JSON.stringify(activePath)});
			}
			if (task.startsWith("reader")) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				try { await access(${JSON.stringify(activePath)}); text = "overlap"; }
				catch { text = "separate"; }
			}
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));`,
		);
		const reader = testAgent({ name: "reader" });
		const writer = testAgent({ name: "writer", access: "write", tools: ["read", "write"] });
		const correctness = testAgent({ name: "correctness-reviewer" });
		const contextStyle = testAgent({ name: "context-style-reviewer" });
		const planner = testAgent({ name: "planner" });
		const agents = [reader, writer, correctness, contextStyle, planner];
		const jobDir = await createRunningWorkflow(directory, script, agents);
		await seedPlan(jobDir);
		await assert.rejects(runWorkflowNodes(jobDir, [
			{ id: "mixed-writer", agent: writer.name, task: "writer" },
			{ id: "mixed-reader", agent: reader.name, task: "reader" },
		]), /writer must be submitted alone/);
		await runWorkflowNodes(jobDir, [
			{ id: "writer", agent: writer.name, task: "writer", dependsOn: ["plan"] },
		]);
		const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
		assert.ok(descendantPid > 1);
		assert.equal(await processIsRunning(descendantPid), false);
	});
});

test("background workflow launches in coordinator mode", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "coordinator-pi.mjs");
		await writeFile(
			script,
			`const excluded = process.argv[process.argv.indexOf("--exclude-tools") + 1];
			const tools = process.argv[process.argv.indexOf("--tools") + 1];
			const prompt = process.argv[process.argv.indexOf("--append-system-prompt") + 1];
			const model = process.argv[process.argv.indexOf("--model") + 1];
			const normalizedPrompt = prompt.replace(/\\s+/g, " ");
			// Anchor the coordinator POLICY, not its prose: each keyword marks a distinct directive
			// (node economy, scout-when-needed, single write node, the two required reviewers, and
			// the explicit-PASS gate) that disappears if that directive is removed, but survives
			// rewording. See COORDINATOR_PROMPT in background-agent.ts.
			const policy =
				normalizedPrompt.includes("fewest nodes") &&
				normalizedPrompt.includes("scout") &&
				normalizedPrompt.includes("exactly one write node") &&
				normalizedPrompt.includes("correctness-reviewer") &&
				normalizedPrompt.includes("context-style-reviewer") &&
				normalizedPrompt.includes("explicit PASS");
			const enabled = tools === "workflow_nodes" && !excluded.includes("workflow_nodes") &&
				prompt.includes("test (read): Test") && policy && model === "openai/active";
			const text = process.env.PI_WORKFLOWS_MODE + ":" +
				(process.env.PI_WORKFLOWS_JOB_DIRECTORY ? "job" : "missing") +
				(enabled ? ":tool" : ":no-tool");
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text }]
			} }));`,
		);
		const agent = testAgent({ name: "test", description: "Test", skills: "none" });
		const launching = startWorkflowJob({
			jobsRoot,
			cwd: directory,
			goal: "Coordinate",
			agents: [agent],
			invocation: { command: process.execPath, args: [script] },
			model: "openai/active",
		});
		agent.systemPrompt = "mutated after launch";
		const started = await launching;
		const request = await readJobRequest(join(jobsRoot, started.id));
		assert.equal(request.type === "workflow" ? request.model : undefined, "openai/active");
		assert.equal(request.type === "workflow" ? request.agents[0].systemPrompt : "", "Review only.");
		const finished = await waitForJob(jobsRoot, started.id);
		assert.equal(finished.type, "workflow");
		assert.deepEqual(finished.nodes, []);
		assert.equal(await readJobResult(jobsRoot, started.id), "coordinator:job:tool");
	});
});

test("background agent job can be cancelled", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "background-waiting-pi.mjs");
		const descendantPidFile = join(directory, "descendant.pid");
		await mkdir(jobsRoot);
		await writeFile(
			script,
			`import { spawn } from "node:child_process";
			import { writeFileSync } from "node:fs";
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				stdio: "ignore"
			});
			writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));
			setInterval(() => undefined, 1000);`,
		);
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Wait in background",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		assert.match(started.processToken ?? "", /^linux:/);
		let descendantPid = 0;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				descendantPid = Number(await readFile(descendantPidFile, "utf8"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		assert.ok(descendantPid > 1);
		const original = await readJobStateAt(join(jobsRoot, started.id));
		await writeJobState(join(jobsRoot, started.id), {
			...original,
			processToken: "linux:forged:identity",
		});
		await assert.rejects(cancelJob(jobsRoot, started.id), /job process is not running/);
		await writeJobState(join(jobsRoot, started.id), original);
		const cancelled = await cancelJob(jobsRoot, started.id);
		assert.equal(cancelled.state, "cancelled");
		for (let attempt = 0; attempt < 100 && isProcessRunning(descendantPid); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(isProcessRunning(descendantPid), false);
	});
});

test("forced cancellation persists cancelled and kills stubborn descendants", async () => {
	await withTempDirectory(async (directory) => {
		const jobsRoot = join(directory, "jobs");
		const script = join(directory, "stubborn-pi.mjs");
		const descendantPidFile = join(directory, "stubborn-descendant.pid");
		await writeFile(
			script,
			`import { spawn } from "node:child_process";
			import { writeFileSync } from "node:fs";
			process.on("SIGTERM", () => undefined);
			const child = spawn(process.execPath, ["-e",
				"process.on('SIGTERM', () => undefined); setInterval(() => {}, 1000)"], {
				stdio: "ignore"
			});
			writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));
			setInterval(() => undefined, 1000);`,
		);
		const started = await startAgentJob({
			jobsRoot,
			cwd: directory,
			task: "Require forced cancellation",
			agent: testAgent(),
			invocation: { command: process.execPath, args: [script] },
		});
		let descendantPid = 0;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				descendantPid = Number(await readFile(descendantPidFile, "utf8"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		assert.ok(descendantPid > 1);
		const cancelled = await cancelJob(jobsRoot, started.id);
		assert.equal(cancelled.state, "cancelled");
		for (let attempt = 0; attempt < 100 && isProcessRunning(descendantPid); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(isProcessRunning(descendantPid), false);
	});
});

test("successful agent run terminates leaked descendants", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "successful-descendant-pi.mjs");
		const pidFile = join(directory, "descendant.pid");
		await writeFile(
			script,
			`import { spawn } from "node:child_process";
			import { writeFileSync } from "node:fs";
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				stdio: ["ignore", "inherit", "inherit"]
			});
			child.unref();
			writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
			process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }]
			} }));`,
		);
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Complete without leaking descendants",
			cwd: directory,
		});
		assert.equal(result.output, "done");
		const descendantPid = Number(await readFile(pidFile, "utf8"));
		for (let attempt = 0; attempt < 100 && isProcessRunning(descendantPid); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(isProcessRunning(descendantPid), false);
	});
});

test("protocol finalization failure still terminates descendants", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "malformed-descendant-pi.mjs");
		const pidFile = join(directory, "malformed-descendant.pid");
		await writeFile(
			script,
			`import { spawn } from "node:child_process";
			import { writeFileSync } from "node:fs";
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				stdio: ["ignore", "inherit", "inherit"]
			});
			child.unref();
			writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
			process.stdout.write('{"type"');`,
		);
		await assert.rejects(
			runAgent({
				invocation: { command: process.execPath, args: [script] },
				agent: testAgent(),
				task: "Fail protocol finalization",
				cwd: directory,
			}),
			SyntaxError,
		);
		const descendantPid = Number(await readFile(pidFile, "utf8"));
		for (let attempt = 0; attempt < 100 && isProcessRunning(descendantPid); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(isProcessRunning(descendantPid), false);
	});
});

test("clean final output survives bounded hung-child cleanup", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "clean-hang-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop",
				content: [{ type: "text", text: "complete" }]
			} }) + "\\n");
			setInterval(() => {}, 1000);`,
		);
		const result = await runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Complete then hang",
			cwd: directory,
			timeoutMs: 5100,
		});
		assert.equal(result.output, "complete");
	});
});

test("cancellation overrides clean final-output cleanup", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "cancel-after-final-pi.mjs");
		await writeFile(
			script,
			`process.stdout.write(JSON.stringify({ type: "message_end", message: {
				role: "assistant", stopReason: "stop",
				content: [{ type: "text", text: "complete" }]
			} }) + "\\n");
			setInterval(() => {}, 1000);`,
		);
		const controller = new AbortController();
		const running = runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Cancel after completion",
			cwd: directory,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100).unref();
		await assert.rejects(running, /agent run aborted/);
	});
});

test("agent timeout terminates model-output and tool process groups", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "timeout-pi.mjs");
		await writeFile(
			script,
			`import { spawn } from "node:child_process";
			import { writeFileSync } from "node:fs";
			const mode = process.argv[2];
			const pidFile = process.argv[3];
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				stdio: "ignore"
			});
			writeFileSync(pidFile, String(child.pid));
			if (mode === "model") process.stdout.write('{"type":"message_end"');
			else process.stdout.write(JSON.stringify({
				type: "tool_execution_start", toolName: "read"
			}) + "\\n");
			setInterval(() => {}, 1000);`,
		);
		const modes = ["model", "tool"] as const;
		const runs = modes.map((mode) => runAgent({
			invocation: {
				command: process.execPath,
				args: [script, mode, join(directory, `${mode}.pid`)],
			},
			agent: testAgent(),
			task: `Timeout during ${mode}`,
			cwd: directory,
			timeoutMs: TERMINATE_GRACE_MS + 50,
		}));
		const outcomes = await Promise.allSettled(runs);
		for (const outcome of outcomes) {
			assert.equal(outcome.status, "rejected");
			assert.match(String(outcome.status === "rejected" && outcome.reason), /agent timed out/);
		}
		for (const mode of modes) {
			const processId = Number(await readFile(join(directory, `${mode}.pid`), "utf8"));
			for (let attempt = 0; attempt < 100 && isProcessRunning(processId); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(isProcessRunning(processId), false);
		}
	});
});

test("agent runner terminates when its parent signal aborts", async () => {
	await withTempDirectory(async (directory) => {
		const script = join(directory, "waiting-pi.mjs");
		await writeFile(script, "setInterval(() => undefined, 1000);");
		const controller = new AbortController();
		const run = runAgent({
			invocation: { command: process.execPath, args: [script] },
			agent: testAgent(),
			task: "Wait",
			cwd: directory,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(run, /agent run aborted/);
	});
});
