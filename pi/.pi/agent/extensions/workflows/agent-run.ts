// Runs one agent as an isolated Pi subprocess: streams the JSONL protocol for output and usage, and
// on timeout, abort, or a clean final result escalates SIGTERM to SIGKILL within bounds.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
	AGENT_KILL_SETTLE_MS,
	AGENT_OUTPUT_BYTES_MAX,
	AGENT_RESULT_EXIT_GRACE_MS,
	AGENT_TASK_BYTES_MAX,
	AGENT_TERMINATE_GRACE_MS,
	AGENT_TOOL_NAME_BYTES_MAX,
	AGENT_TIMEOUT_MS,
	AGENT_USAGE_COST_MAX,
	AGENT_USAGE_COUNT_MAX,
	JSONL_RECORD_BYTES_MAX,
	JSONL_RECORD_COUNT_MAX,
	STDERR_BYTES_MAX,
	WORKFLOW_TIMEOUT_MS,
	WRITER_OWNER_BYTES_MAX,
} from "./limits.ts";
import type { AgentDefinition } from "./agents.ts";
import { terminateProcessGroupMembers, WRITER_OWNER_ENV } from "./processes.ts";

const CHILD_MODE_ENV = "PI_WORKFLOWS_MODE";
const CHILD_MODE_NODE = "node";
const CHILD_JOB_DIRECTORY_ENV = "PI_WORKFLOWS_JOB_DIRECTORY";
const EXCLUDED_CHILD_TOOLS = [
	"agent_run",
	"job_cancel",
	"job_status",
	"job_wait",
	"workflow_nodes",
	"workflow_start",
];

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface AgentRunUpdate {
	agent: string;
	tool?: string;
	toolCount: number;
	usage: AgentUsage;
}

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface AgentRunResult {
	output: string;
	model?: string;
	stopReason?: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	usage: AgentUsage;
}

export interface RunAgentOptions {
	invocation: PiInvocation;
	agent: AgentDefinition;
	task: string;
	cwd: string;
	sessionFile?: string;
	signal?: AbortSignal;
	onUpdate?: (update: AgentRunUpdate) => void;
	processMode?: "coordinator" | "node";
	jobDirectory?: string;
	timeoutMs?: number;
	isolateProcessGroup?: boolean;
	writerOwnerId?: string;
	onProcessGroup?: (processGroupId: number) => Promise<void>;
}

interface CollectedOutput {
	output: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage: AgentUsage;
}

type RunningChild = ChildProcessByStdio<null, Readable, Readable>;

interface AgentProcessState {
	child: RunningChild;
	protocolController: AbortController;
	protocolError?: Error;
	spawnError?: Error;
	stderr: Buffer;
}

export class JsonlDecoder {
	readonly #onValue: (value: unknown) => void;
	#pending = Buffer.alloc(0);
	#recordCount = 0;

	constructor(onValue: (value: unknown) => void) {
		this.#onValue = onValue;
	}

	feed(chunk: Buffer): void {
		if (chunk.length > JSONL_RECORD_BYTES_MAX) throw new Error("JSONL chunk exceeds limit");
		let data = Buffer.concat([this.#pending, chunk]);
		let newline = data.indexOf(0x0a);
		while (newline >= 0) {
			this.#consume(data.subarray(0, newline));
			data = data.subarray(newline + 1);
			newline = data.indexOf(0x0a);
		}
		if (data.length > JSONL_RECORD_BYTES_MAX) throw new Error("JSONL record exceeds limit");
		this.#pending = Buffer.from(data);
	}

	finish(): void {
		if (this.#pending.length > 0) this.#consume(this.#pending);
		this.#pending = Buffer.alloc(0);
	}

	#consume(line: Buffer): void {
		if (line.length === 0) return;
		if (line.length > JSONL_RECORD_BYTES_MAX) throw new Error("JSONL record exceeds limit");
		this.#recordCount += 1;
		if (this.#recordCount > JSONL_RECORD_COUNT_MAX) {
			throw new Error("JSONL record count exceeds limit");
		}
		this.#onValue(JSON.parse(line.toString("utf8")));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function emptyUsage(): AgentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export const USAGE_COUNT_KEYS =
	["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
export const USAGE_OPTIONAL_KEYS = ["cacheWrite1h", "reasoning"] as const;
export const USAGE_COST_KEYS =
	["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function requireBoundedNumber(
	source: Record<string, unknown>,
	key: string,
	valueMax: number,
	integer: boolean,
): void {
	const value = source[key];
	const invalidInteger = integer && !Number.isSafeInteger(value);
	if (typeof value !== "number" || !Number.isFinite(value) || invalidInteger ||
		value < 0 || value > valueMax) {
		throw new Error(`invalid usage ${key}`);
	}
}

export interface UsageValidationLimits {
	costMax: number;
	countMax: number;
}

export function validateAgentUsage(
	value: unknown,
	limits: UsageValidationLimits = {
		costMax: AGENT_USAGE_COST_MAX,
		countMax: AGENT_USAGE_COUNT_MAX,
	},
): AgentUsage {
	if (!isRecord(value)) throw new Error("invalid agent usage");
	for (const key of USAGE_COUNT_KEYS) {
		requireBoundedNumber(value, key, limits.countMax, true);
	}
	for (const key of USAGE_OPTIONAL_KEYS) {
		if (value[key] !== undefined) {
			requireBoundedNumber(value, key, limits.countMax, true);
		}
	}
	if (!isRecord(value.cost)) throw new Error("invalid agent usage cost");
	for (const key of USAGE_COST_KEYS) {
		requireBoundedNumber(value.cost, key, limits.costMax, false);
	}
	return value as unknown as AgentUsage;
}

function addBoundedNumber(
	target: Record<string, number>,
	key: string,
	source: Record<string, unknown>,
	valueMax: number,
	integer: boolean,
): void {
	const value = source[key];
	if (value === undefined) return;
	const invalidInteger = integer && !Number.isSafeInteger(value);
	if (typeof value !== "number" || !Number.isFinite(value) || invalidInteger ||
		value < 0 || value > valueMax) {
		throw new Error(`invalid usage ${key}`);
	}
	const total = (target[key] ?? 0) + value;
	if (!Number.isFinite(total) || total > valueMax) throw new Error(`usage ${key} exceeds limit`);
	target[key] = total;
}

function collectUsage(message: Record<string, unknown>, usage: AgentUsage): void {
	if (message.usage === undefined) return;
	if (!isRecord(message.usage)) throw new Error("invalid agent usage");
	const source = message.usage;
	const target = usage as unknown as Record<string, number>;
	for (const key of USAGE_COUNT_KEYS) {
		addBoundedNumber(target, key, source, AGENT_USAGE_COUNT_MAX, true);
	}
	for (const key of USAGE_OPTIONAL_KEYS) {
		addBoundedNumber(target, key, source, AGENT_USAGE_COUNT_MAX, true);
	}
	if (source.cost === undefined) return;
	if (!isRecord(source.cost)) throw new Error("invalid agent usage cost");
	const cost = usage.cost as unknown as Record<string, number>;
	for (const key of USAGE_COST_KEYS) {
		addBoundedNumber(cost, key, source.cost, AGENT_USAGE_COST_MAX, false);
	}
}

function collectAssistantMessage(value: unknown, collected: CollectedOutput): boolean {
	if (!isRecord(value) || value.type !== "message_end") return false;
	const message = value.message;
	if (!isRecord(message) || message.role !== "assistant") return false;
	if (typeof message.model === "string") collected.model = message.model;
	if (typeof message.stopReason === "string") collected.stopReason = message.stopReason;
	if (typeof message.errorMessage === "string") collected.errorMessage = message.errorMessage;
	collectUsage(message, collected.usage);
	collected.output = "";
	if (!Array.isArray(message.content)) return true;
	const text = message.content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => part.text)
		.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
		.join("\n");
	collected.output = text;
	return true;
}

function buildAgentArgs(options: RunAgentOptions): string[] {
	const excludedTools = options.processMode === "coordinator"
		? EXCLUDED_CHILD_TOOLS.filter((tool) => tool !== "workflow_nodes")
		: EXCLUDED_CHILD_TOOLS;
	const args = [
		...options.invocation.args,
		"--mode",
		"json",
		"-p",
		...(options.sessionFile ? ["--session", options.sessionFile] : ["--no-session"]),
		"--exclude-tools",
		excludedTools.join(","),
		"--tools",
		options.agent.tools.join(","),
	];
	if (options.agent.model) args.push("--model", options.agent.model);
	if (options.agent.skills === "none") args.push("--no-skills");
	if (options.agent.systemPrompt) {
		const flag = options.agent.systemPromptMode === "replace"
			? "--system-prompt"
			: "--append-system-prompt";
		args.push(flag, options.agent.systemPrompt);
	}
	args.push(options.task);
	return args;
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
	if (chunk.length >= STDERR_BYTES_MAX) return chunk.subarray(chunk.length - STDERR_BYTES_MAX);
	const combined = Buffer.concat([current, chunk]);
	if (combined.length <= STDERR_BYTES_MAX) return combined;
	return combined.subarray(combined.length - STDERR_BYTES_MAX);
}

export function truncateUtf8Bytes(
	text: string,
	bytesMax: number,
	marker: string,
): string {
	const markerBytes = Buffer.byteLength(marker);
	if (markerBytes >= bytesMax) throw new Error("truncation marker exceeds byte limit");
	const bytes = Buffer.from(text);
	if (bytes.length <= bytesMax) return text;
	let end = bytesMax - markerBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf8") + marker;
}

function killProcess(
	child: RunningChild,
	signal: NodeJS.Signals,
	isolateProcessGroup: boolean,
): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (!child.pid) throw new Error("agent process has no process id");
	if (isolateProcessGroup) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall through when the group disappeared with the child.
		}
	}
	child.kill(signal);
}

function validateRun(options: RunAgentOptions): void {
	if (!options.task.trim()) throw new Error("agent task must not be empty");
	if (Buffer.byteLength(options.task) > AGENT_TASK_BYTES_MAX) {
		throw new Error("agent task exceeds limit");
	}
	if (options.agent.tools.length === 0) throw new Error("agent must have at least one tool");
	const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
	if (timeoutMs <= AGENT_TERMINATE_GRACE_MS || timeoutMs > WORKFLOW_TIMEOUT_MS) {
		throw new Error("agent timeout is outside the allowed range");
	}
	if (options.processMode === "coordinator" && !options.jobDirectory) {
		throw new Error("coordinator requires a job directory");
	}
	if (options.signal?.aborted) throw new Error("agent run aborted before launch");
	if (options.writerOwnerId !== undefined) {
		if (!options.writerOwnerId || options.writerOwnerId.includes("\0")) {
			throw new Error("invalid writer owner identity");
		}
		if (Buffer.byteLength(options.writerOwnerId) > WRITER_OWNER_BYTES_MAX) {
			throw new Error("writer owner identity exceeds limit");
		}
	}
}

export function currentPiInvocation(): PiInvocation {
	const currentScript = process.argv[1];
	if (!currentScript || currentScript.startsWith("/$bunfs/root/")) {
		throw new Error("workflows extension requires a direct Node Pi invocation");
	}
	return { command: process.execPath, args: [currentScript] };
}

const NONFINAL_STOP_REASONS: readonly string[] = ["aborted", "error", "length", "toolUse"];

function isNonFinalStopReason(stopReason: string | undefined): boolean {
	return NONFINAL_STOP_REASONS.includes(stopReason ?? "");
}

function completedRun(
	collected: CollectedOutput,
	stderr: Buffer,
	exitCode: number,
	durationMs: number,
): AgentRunResult {
	if (exitCode !== 0) {
		throw new Error(stderr.toString("utf8").trim() || `agent exited ${exitCode}`);
	}
	if (isNonFinalStopReason(collected.stopReason)) {
		throw new Error(collected.errorMessage ?? `agent stopped with reason: ${collected.stopReason}`);
	}
	if (!collected.output.trim()) throw new Error("agent returned no final text");
	return {
		output: truncateUtf8Bytes(
			collected.output,
			AGENT_OUTPUT_BYTES_MAX,
			"\n\n[output truncated]",
		),
		model: collected.model,
		stopReason: collected.stopReason,
		stderr: stderr.toString("utf8"),
		exitCode,
		durationMs,
		usage: collected.usage,
	};
}

function hasCleanFinalOutput(collected: CollectedOutput): boolean {
	if (!collected.output.trim()) return false;
	return !isNonFinalStopReason(collected.stopReason);
}

function createAgentDecoder(
	options: RunAgentOptions,
	collected: CollectedOutput,
	onCleanFinalOutput: () => void,
): JsonlDecoder {
	let toolCount = 0;
	const emitUpdate = (tool?: string) => options.onUpdate?.({
		agent: options.agent.name,
		tool,
		toolCount,
		usage: structuredClone(collected.usage),
	});
	return new JsonlDecoder((value) => {
		const assistantEnded = collectAssistantMessage(value, collected);
		if (isRecord(value) && value.type === "tool_execution_start") {
			if (typeof value.toolName !== "string") throw new Error("invalid tool activity");
			if (Buffer.byteLength(value.toolName) > AGENT_TOOL_NAME_BYTES_MAX) {
				throw new Error("tool activity exceeds limit");
			}
			toolCount += 1;
			emitUpdate(value.toolName);
		} else if (assistantEnded) {
			emitUpdate();
			if (hasCleanFinalOutput(collected)) onCleanFinalOutput();
		}
	});
}

async function settleExitedChildStreams(child: RunningChild): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	child.stdout.destroy();
	child.stderr.destroy();
}

function spawnAgentProcess(
	options: RunAgentOptions,
	decoder: JsonlDecoder,
	isolateProcessGroup: boolean,
): AgentProcessState {
	const state: AgentProcessState = {
		child: spawn(options.invocation.command, buildAgentArgs(options), {
			cwd: options.cwd,
			detached: isolateProcessGroup,
			env: {
				...process.env,
				[CHILD_MODE_ENV]: options.processMode ?? CHILD_MODE_NODE,
				[CHILD_JOB_DIRECTORY_ENV]: options.jobDirectory,
				[WRITER_OWNER_ENV]: options.writerOwnerId,
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		}),
		protocolController: new AbortController(),
		stderr: Buffer.alloc(0),
	};
	state.child.on("error", (error) => {
		state.spawnError ??= error;
	});
	state.child.stdout.on("data", (chunk: Buffer) => {
		try {
			decoder.feed(chunk);
		} catch (error) {
			state.protocolError ??= error as Error;
			state.protocolController.abort();
		}
	});
	state.child.stderr.on("data", (chunk: Buffer) => {
		state.stderr = appendTail(state.stderr, chunk);
	});
	return state;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
	validateRun(options);
	const startedAtMs = Date.now();
	const collected: CollectedOutput = { output: "", usage: emptyUsage() };
	const completionController = new AbortController();
	const decoder = createAgentDecoder(
		options,
		collected,
		() => completionController.abort(),
	);
	const isolateProcessGroup = options.isolateProcessGroup ?? true;
	const state = spawnAgentProcess(options, decoder, isolateProcessGroup);
	const child = state.child;
	const signal = options.signal
		? AbortSignal.any([options.signal, state.protocolController.signal])
		: state.protocolController.signal;
	try {
		if (options.onProcessGroup) {
			if (!isolateProcessGroup || !child.pid) {
				throw new Error("process-group callback requires an isolated child");
			}
			await options.onProcessGroup(child.pid);
		}
		let exitCode: number;
		try {
			if (state.spawnError) throw state.spawnError;
			exitCode = await waitForExit(
				child,
				signal,
				options.timeoutMs ?? AGENT_TIMEOUT_MS,
				isolateProcessGroup,
				completionController.signal,
			);
		} catch (error) {
			if (state.protocolError) throw state.protocolError;
			throw error;
		}
		if (isolateProcessGroup && child.pid) {
			await terminateProcessGroupMembers(child.pid);
		}
		await settleExitedChildStreams(child);
		if (!state.protocolError) {
			try {
				decoder.finish();
			} catch (error) {
				state.protocolError = error as Error;
			}
		}
		if (state.protocolError) throw state.protocolError;
		return completedRun(collected, state.stderr, exitCode, Date.now() - startedAtMs);
	} finally {
		if (isolateProcessGroup && child.pid) {
			await terminateProcessGroupMembers(child.pid);
		}
		child.stdout.destroy();
		child.stderr.destroy();
	}
}

function armExitSignals(
	signal: AbortSignal | undefined,
	completionSignal: AbortSignal,
	abort: () => void,
	complete: () => void,
): void {
	signal?.addEventListener("abort", abort, { once: true });
	completionSignal.addEventListener("abort", complete, { once: true });
	if (signal?.aborted) abort();
	if (completionSignal.aborted) complete();
}

function waitForExit(
	child: RunningChild, signal: AbortSignal | undefined,
	timeoutMs: number, isolateProcessGroup: boolean,
	completionSignal: AbortSignal,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let completionCleanup = false;
		let settled = false;
		let completionTimer: NodeJS.Timeout | undefined, settleTimer: NodeJS.Timeout | undefined;
		let terminationError: Error | undefined;
		let terminationMessage = "agent did not exit";
		let terminationTimer: NodeJS.Timeout | undefined;
		const requestTermination = (message: string, preserveResult: boolean) => {
			if (terminationTimer) {
				if (completionCleanup && !preserveResult) {
					completionCleanup = false;
					terminationError = new Error(message);
					terminationMessage = message;
				}
				return;
			}
			completionCleanup = preserveResult;
			terminationError = preserveResult ? undefined : new Error(message);
			terminationMessage = message;
			killProcess(child, "SIGTERM", isolateProcessGroup);
			terminationTimer = setTimeout(() => {
				killProcess(child, "SIGKILL", isolateProcessGroup);
				settleTimer = setTimeout(() => {
					fail(new Error(`${terminationMessage}; child survived SIGKILL`));
				}, AGENT_KILL_SETTLE_MS);
				settleTimer.unref();
			}, AGENT_TERMINATE_GRACE_MS);
			terminationTimer.unref();
		};
		const timeout = setTimeout(() => requestTermination("agent timed out", false), timeoutMs);
		const abort = () => requestTermination("agent run aborted", false);
		const complete = () => {
			if (completionTimer || terminationTimer) return;
			completionTimer = setTimeout(
				() => requestTermination("agent completed but did not exit", true),
				AGENT_RESULT_EXIT_GRACE_MS,
			);
			completionTimer.unref();
		};
		const cleanup = () => {
			clearTimeout(timeout);
			if (completionTimer) clearTimeout(completionTimer);
			if (settleTimer) clearTimeout(settleTimer);
			if (terminationTimer) clearTimeout(terminationTimer);
			signal?.removeEventListener("abort", abort);
			completionSignal.removeEventListener("abort", complete);
		};
		armExitSignals(signal, completionSignal, abort, complete);
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (terminationError) reject(terminationError);
			else resolve(completionCleanup ? 0 : code ?? 1);
		};
		child.once("error", fail).once("exit", finish);
		if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
	});
}
