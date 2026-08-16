import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import {
	childEnvironment,
	consumeChildEvent,
	createActivityTracker,
	emptyUsage,
	type Agent,
	type ChildEvent,
	type Inherited,
	type JsonValue,
	type NativeClaudeOptions,
	type RunResult,
	selectRuntime,
	stringifyJson,
} from "./runtimes.ts";

/** Children still running. The abort signal covers a cancelled call; this covers a dead session. */
const LIVE = new Set<ReturnType<typeof spawn>>();

export interface RunAgentOptions {
	agent: Agent;
	task: string;
	cwd: string;
	inherited: Inherited;
	model: string | undefined;
	/** Task description retained for progress/details; the child still receives `task` exactly. */
	resultTask?: string;
	/** Pi-only terminating tool whose details become the normalized output; must be in `agent.tools`. */
	resultTool?: string;
	nativeClaude?: NativeClaudeOptions;
	signal?: AbortSignal;
	/** Called when the operating system confirms that the child process started. */
	onStart?: () => void;
	onProgress?: (partial: RunResult) => void;
}

/** Detached copy for a progress render: `result` keeps mutating, a rendered snapshot must not. */
function snapshot(result: RunResult, startedAtMs: number): RunResult {
	return {
		...result,
		usage: { ...result.usage, cost: { ...result.usage.cost } },
		// Copied per step, not just per array: a running step is mutated in place when it finishes,
		// and a rendered snapshot must keep showing what was true when it was taken.
		steps: result.steps.map((step) => ({ ...step })),
		durationMs: Date.now() - startedAtMs,
	};
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = once(child, "close");
	child.kill("SIGKILL");
	await closed;
}

interface ClaudeTrace {
	id: string;
	stdout: WriteStream;
	stderr: WriteStream;
	finished: Promise<void>;
}

/** Persist exactly what native Claude was asked and every byte it returned. */
function createClaudeTrace(sessionDir: string | undefined, cwd: string, invocation: {
	command: string;
	args: string[];
	input?: string;
}): ClaudeTrace {
	if (!sessionDir) throw new Error("native Claude runs require inherited.sessionDir for trace persistence");
	const id = randomUUID();
	const directory = join(sessionDir, "native-claude", id);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "request.json"),
		`${JSON.stringify({ traceId: id, cwd, command: invocation.command, args: invocation.args, input: invocation.input })}\n`,
		{ flag: "wx" },
	);
	const stdout = createWriteStream(join(directory, "stdout.jsonl"), { flags: "wx" });
	const stderr = createWriteStream(join(directory, "stderr.log"), { flags: "wx" });
	const complete = Promise.all([finished(stdout), finished(stderr)]).then(() => undefined);
	// The close handler reports a trace write failure to the caller. Mark it handled now too, so a
	// disk failure before the child exits cannot become an unrelated unhandled rejection.
	void complete.catch(() => {});
	return { id, stdout, stderr, finished: complete };
}

/** End every child owned by this extension when its parent session is gone. */
export async function shutdownAgents(): Promise<void> {
	await Promise.all([...LIVE].map(terminateChild));
}

/** Run one configured or caller-constructed role in an isolated child process. */
export function runAgent(options: RunAgentOptions): Promise<RunResult> {
	const { agent, task, cwd, inherited, model, resultTask, resultTool, nativeClaude, signal, onStart, onProgress } = options;
	const startedAtMs = Date.now();
	const runtime = selectRuntime(model);
	if (resultTool !== undefined && runtime.name !== "pi") throw new Error("resultTool is only supported for Pi children");
	if (resultTool !== undefined && !agent.tools.includes(resultTool))
		throw new Error(`resultTool ${resultTool} is not declared in agent.tools`);
	const invocation = runtime.invoke(agent, task, inherited, model, nativeClaude);
	const trace = runtime.name === "claude" ? createClaudeTrace(inherited.sessionDir, cwd, invocation) : undefined;
	const result: RunResult = {
		agent: agent.name,
		task: resultTask ?? task,
		runId: inherited.sessionId,
		output: "",
		model: model ?? inherited.model,
		steps: [],
		turns: 0,
		usage: emptyUsage(),
		durationMs: 0,
	};
	if (trace) result.traceId = trace.id;

	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			env: childEnvironment(runtime.name, process.env, resultTool),
			shell: false,
			stdio: [invocation.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (invocation.input !== undefined && child.stdin) {
			// A child that dies before reading its prompt turns this write into an EPIPE, and an
			// unhandled `error` on a stream takes the whole session down. The close handler below
			// already reports the run as the failure it is.
			child.stdin.on("error", () => {});
			child.stdin.end(invocation.input);
		}
		// Tracked so session teardown can end it. A child outliving its session is not merely a
		// stray process: it goes on spending tokens with nothing left to read what it produces.
		LIVE.add(child);
		if (onStart) child.once("spawn", onStart);
		const stderr: Buffer[] = [];
		const activity = createActivityTracker(result);
		const expectsNativeResult = runtime.name === "claude" && nativeClaude?.jsonSchema !== undefined;
		const structuredResultLabel = resultTool ?? (expectsNativeResult ? "native Claude structured output" : undefined);
		let structuredResults = 0;
		let protocolError: string | undefined;

		const failProtocol = (message: string) => {
			if (protocolError) return;
			protocolError = `invalid child protocol: ${message}`;
			result.output = "";
			result.stopReason = "error";
			result.errorMessage = protocolError;
			void terminateChild(child);
		};
		const consume = (line: string) => {
			if (protocolError || !line.trim()) return;
			let raw: JsonValue;
			try {
				raw = JSON.parse(line);
			} catch {
				failProtocol("stdout line is not JSON");
				return;
			}
			let events: ChildEvent[];
			try {
				events = runtime.decode(raw);
			} catch (error) {
				failProtocol(error instanceof Error ? error.message : String(error));
				return;
			}
			let changed = false;
			for (const event of events) {
				if (resultTool !== undefined && structuredResults > 0 && event.kind === "pi-message") {
					failProtocol(`child continued after ${resultTool}`);
					return;
				}
				let structuredOutput: string | undefined;
				if (
					resultTool !== undefined && event.kind === "tool-end" &&
					event.tool === resultTool && !event.failed && event.details.kind === "present"
				) structuredOutput = stringifyJson(event.details.value);
				else if (
					expectsNativeResult && event.kind === "claude-result" && event.output.kind === "present"
				) structuredOutput = stringifyJson(event.output.value);
				if (structuredOutput !== undefined) {
					structuredResults += 1;
					if (structuredResults > 1) {
						failProtocol(`child returned ${structuredResultLabel} more than once`);
						return;
					}
					result.output = structuredOutput;
				}
				if (consumeChildEvent(event, result, activity)) changed = true;
				if (resultTool !== undefined && event.kind === "pi-message") result.output = "";
			}
			if (changed) onProgress?.(snapshot(result, startedAtMs));
		};

		const stdout = child.stdout;
		const stderrStream = child.stderr;
		if (!stdout || !stderrStream) throw new Error("child process stdio is unavailable");
		if (trace) {
			stdout.pipe(trace.stdout);
			stderrStream.pipe(trace.stderr);
		}
		createInterface({ input: stdout, crlfDelay: Infinity }).on("line", consume);
		stderrStream.on("data", (chunk: Buffer | Uint8Array) => stderr.push(Buffer.from(chunk)));

		const kill = () => {
			result.termination = "cancelled";
			void terminateChild(child);
		};
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });

		child.once("error", reject);
		// `close`, not `exit`: exit fires when the process ends, close when its stdio has drained.
		// The report is the last thing written, so settling on `exit` races the pipe and loses it —
		// intermittently, and only under load, which is the worst way to lose an agent's whole run.
		child.once("close", () => {
			LIVE.delete(child);
			signal?.removeEventListener("abort", kill);
			// A step still open here never finished, and keeps its running mark to say so rather
			// than reading as the last thing that succeeded.
			result.activity = undefined;
			result.durationMs = Date.now() - startedAtMs;
			const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
			if (!result.output.trim() && !result.errorMessage && diagnostic) result.errorMessage = diagnostic;
			const terminalFailure = result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length";
			if (structuredResultLabel !== undefined && !protocolError && !result.termination && !terminalFailure) {
				if (structuredResults === 1) {
					result.stopReason = "stop";
					result.errorMessage = undefined;
				} else {
					result.output = "";
					result.stopReason = "error";
					result.errorMessage = resultTool
						? `no successful ${resultTool} result`
						: "native Claude returned no structured output";
				}
			}
			if (trace) trace.finished.then(() => resolve(result), reject);
			else resolve(result);
		});
	});
}
