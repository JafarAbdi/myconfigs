/**
 * Stdio MCP server exposing pi's file/shell tools to a host-local `claude` whose built-ins are
 * stripped (see bridge.ts). Hand-rolled JSON-RPC 2.0 over stdio, newline-delimited, zero deps.
 * Only JSON-RPC frames go to stdout; diagnostics go to stderr.
 *
 * Why a dedicated server, and why stdio: pi exposes no MCP-host API to extensions, so we run our own
 * server. Transport is stdio (claude spawns this process): no port to bind, lifecycle bound to the
 * turn — and claude's MCP client has no unix-socket transport, so stdio is the clean choice.
 *
 * read/write/edit reuse pi's OWN tool implementations: the bridge resolves pi's package entry (it
 * runs inside pi, where the bare specifier resolves) and passes it as PI_CODING_AGENT_ENTRY; we
 * dynamic-import it and call createRead/Write/EditToolDefinition. So the byte-semantics that are easy
 * to get subtly wrong — BOM, CRLF preservation, fuzzy (smart-quote/whitespace) matching, image
 * detection, truncation — match pi exactly, on both local and SSH targets, instead of being
 * re-derived here. bash/ls/find/grep stay hand-rolled: they are byte-agnostic shell-outs with no such
 * semantics, and pi's bash tool is welded to a session/TUI context a bare server can't supply.
 *
 * Backend is chosen once at startup from PI_SSH_DESCRIPTOR (set by the bridge in the mcp.json env):
 *   - absent            → local execution on this host (pi tools with default ops; local shell-outs)
 *   - present + valid   → the ssh extension's remote ops (claude on host, files on the SSH remote)
 *   - present + invalid → a fail-loud backend; every tool returns an error, never local. This is the
 *     load-bearing safety property: when pi is in SSH mode we never silently touch the host.
 *
 * Reuses ../ssh/{connection,operations,descriptor,shell}.ts and ../lib/claude-stream.ts's JSON guards.
 * ssh/grep.ts is NOT reused — it imports pi-coding-agent by bare specifier, which a bare node child
 * can't resolve — so remote grep shells out to the descriptor's rg directly.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import {
	isJsonObject,
	isString,
	isStringOrNumber,
	type JsonObject,
	type JsonValue,
	optionalNumberField,
	optionalStringField,
	requiredStringField,
} from "../lib/claude-stream.ts";
import { SshConnection } from "../ssh/connection.ts";
import { applySshConnectionDescriptor, parseSshConnectionDescriptor, SSH_DESCRIPTOR_ENV } from "../ssh/descriptor.ts";
import { createRemoteBashOps, createRemoteEditOps, createRemoteReadOps, createRemoteWriteOps } from "../ssh/operations.ts";
import { shellQuote } from "../ssh/shell.ts";

const PROTOCOL_FALLBACK = "2024-11-05";
// MCP revisions we understand. On initialize we echo the client's version if it's one of these, else
// our fallback — the client then negotiates down. The tool surface is identical across them.
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const SERVER_INFO = { name: "pi", version: "0.1.0" };

type JsonRpcId = string | number | null;

/** An actionable incoming frame. Notifications carry no id; responses carry no method and are ignored. */
interface JsonRpcRequest {
	id: JsonRpcId | undefined;
	method: string;
	params: JsonValue | undefined;
}

/** Outgoing frames are a result or an error, never both. */
type JsonRpcResponse =
	| { jsonrpc: "2.0"; id: JsonRpcId; result: JsonValue }
	| { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

/** MCP tool-result content: text, or an image the client surfaces to the model as vision. */
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError: boolean };

const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], isError });

/** read/write/edit read nothing from pi's execution context, so we supply an empty one — named (not
 *  a bare `object`) to keep that "we pass no context" contract explicit. */
type PiToolContext = Record<string, never>;

/** The slice of pi's package we import at runtime. Its tool `content` blocks are already MCP-shaped. */
interface PiToolDefinition {
	execute(
		id: string,
		params: JsonObject,
		signal: undefined,
		onUpdate: undefined,
		context: PiToolContext,
	): Promise<{ content: ToolContent[]; isError?: boolean }>;
}
interface PiModule {
	createReadToolDefinition(cwd: string, options?: { operations?: ReadOperations }): PiToolDefinition;
	createWriteToolDefinition(cwd: string, options?: { operations?: WriteOperations }): PiToolDefinition;
	createEditToolDefinition(cwd: string, options?: { operations?: EditOperations }): PiToolDefinition;
}

// Runs one of pi's own tool definitions and maps its result to an MCP tool result. A pi tool signals
// failure by throwing (caught in handleToolCall) or, rarely, by isError on the result.
async function runPiTool(definition: PiToolDefinition, params: JsonObject): Promise<ToolResult> {
	const result = await definition.execute("mcp", params, undefined, undefined, {});
	return { content: result.content, isError: result.isError === true };
}

function readParams(filePath: string, offset?: number, limit?: number): JsonObject {
	const params: JsonObject = { path: filePath };
	if (offset !== undefined) params.offset = offset;
	if (limit !== undefined) params.limit = limit;
	return params;
}

/** One execution target. Every tool routes through exactly one of these, chosen at startup. */
interface Backend {
	bash(command: string): Promise<ToolResult>;
	read(filePath: string, offset?: number, limit?: number): Promise<ToolResult>;
	write(filePath: string, content: string): Promise<ToolResult>;
	edit(filePath: string, oldString: string, newString: string): Promise<ToolResult>;
	ls(path: string): Promise<ToolResult>;
	find(glob: string, path: string): Promise<ToolResult>;
	grep(pattern: string, path: string, include?: string): Promise<ToolResult>;
}

function log(message: string): void {
	process.stderr.write(`[pi-mcp] ${message}\n`);
}

/** Every backend failure reaches the caller as a tool error result, labelled with the operation. */
async function attempt(label: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await run();
	} catch (error) {
		return textResult(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, true);
	}
}

// Renders a finished command's output. `code === null` means the process never ran (spawn failure).
function commandText(stdout: string, stderr: string, code: number | null): string {
	const parts: string[] = [];
	if (code !== 0 && code !== null) parts.push(`[exit ${code}]`);
	if (stdout) parts.push(stdout.replace(/\n$/, ""));
	if (stderr.trim()) parts.push(`[stderr]\n${stderr.replace(/\n$/, "")}`);
	return parts.join("\n") || "(no output)";
}

// For find/ls, a non-zero exit is a genuine tool failure. (bash is different — see the backends.)
function commandResult(stdout: string, stderr: string, code: number | null): ToolResult {
	return textResult(commandText(stdout, stderr, code), code !== 0);
}

function runCommand(
	file: string,
	args: string[],
	input?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolvePromise) => {
		const child = spawn(file, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		// code null distinguishes "never ran" (spawn failure) from a real non-zero exit.
		child.on("error", (error) => resolvePromise({ stdout, stderr: `${stderr}${error.message}`, code: null }));
		child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
		if (input !== undefined && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
	});
}

function localBackend(pi: PiModule): Backend {
	const resolveLocal = (path: string): string => resolve(process.cwd(), path);
	const readDef = pi.createReadToolDefinition(process.cwd());
	const writeDef = pi.createWriteToolDefinition(process.cwd());
	const editDef = pi.createEditToolDefinition(process.cwd());
	return {
		bash: async (command) => {
			// A command that runs and exits non-zero did its job (a failing test, a grep miss); that is
			// NOT a tool failure. isError is reserved for the process failing to run at all (code null).
			const r = await runCommand("bash", ["-c", command]);
			return textResult(commandText(r.stdout, r.stderr, r.code), r.code === null);
		},
		read: (filePath, offset, limit) => runPiTool(readDef, readParams(filePath, offset, limit)),
		write: (filePath, content) => runPiTool(writeDef, { path: filePath, content }),
		edit: (filePath, oldString, newString) =>
			runPiTool(editDef, { path: filePath, edits: [{ oldText: oldString, newText: newString }] }),
		ls: (path) =>
			attempt("ls", async () => {
				const entries = readdirSync(resolveLocal(path || "."), { withFileTypes: true })
					.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
					.sort();
				return textResult(entries.join("\n") || "(empty)");
			}),
		find: async (glob, path) => {
			const r = await runCommand("find", [resolveLocal(path || "."), "-name", ".git", "-prune", "-o", "-type", "f", "-name", glob, "-print"]);
			return commandResult(r.stdout, r.stderr, r.code);
		},
		// rg (not grep) to match the remote backend exactly — same binary, same flags, same
		// .gitignore/hidden/binary semantics — so a search returns the same set on either target.
		grep: async (pattern, path, include) => {
			const args = ["-n"];
			if (include) args.push("--glob", include);
			args.push("-e", pattern, resolveLocal(path || "."));
			const r = await runCommand("rg", args);
			if (r.code === 1 && !r.stderr.trim()) return textResult("(no matches)");
			return commandResult(r.stdout, r.stderr, r.code);
		},
	};
}

function remoteBackend(pi: PiModule, descriptorJson: string): Backend {
	const descriptor = parseSshConnectionDescriptor(descriptorJson); // throws if malformed → fail-loud
	const conn = new SshConnection(descriptor.remote, process.cwd());
	applySshConnectionDescriptor(conn, descriptor);
	// Same pi tool code as local, but with the ssh extension's remote ops — so remote edits inherit
	// pi's BOM/CRLF/fuzzy semantics exactly, and remote read gets pi's image detection over ssh.
	const readDef = pi.createReadToolDefinition(conn.remoteCwd, { operations: createRemoteReadOps(conn) });
	const writeDef = pi.createWriteToolDefinition(conn.remoteCwd, { operations: createRemoteWriteOps(conn) });
	const editDef = pi.createEditToolDefinition(conn.remoteCwd, { operations: createRemoteEditOps(conn) });
	const bashOps = createRemoteBashOps(conn);

	// Run a command in the remote cwd, capturing merged output and the exit code (never throws).
	const runRemote = async (command: string): Promise<{ out: string; code: number | null }> => {
		let out = "";
		const { exitCode } = await bashOps.exec(command, ".", { onData: (chunk) => { out += chunk.toString("utf8"); } });
		return { out, code: exitCode };
	};

	return {
		bash: async (command) => {
			// Same rule as local: a real non-zero exit is not a tool failure. Over ssh, exit 255 is the
			// transport failing to run the command at all, so that is the one code we surface as isError.
			const { out, code } = await runRemote(command);
			return textResult(commandText(out, "", code), code === 255);
		},
		read: (filePath, offset, limit) => runPiTool(readDef, readParams(filePath, offset, limit)),
		write: (filePath, content) => runPiTool(writeDef, { path: filePath, content }),
		edit: (filePath, oldString, newString) =>
			runPiTool(editDef, { path: filePath, edits: [{ oldText: oldString, newText: newString }] }),
		ls: async (path) => {
			const { out, code } = await runRemote(`ls -1Ap ${shellQuote(conn.toRemotePath(path || "."))}`);
			return commandResult(out, "", code);
		},
		find: async (glob, path) => {
			const target = shellQuote(conn.toRemotePath(path || "."));
			const { out, code } = await runRemote(`find ${target} -name .git -prune -o -type f -name ${shellQuote(glob)} -print`);
			return commandResult(out, "", code);
		},
		grep: async (pattern, path, include) => {
			const rg = shellQuote(conn.requireRgPath());
			const inc = include ? ` --glob ${shellQuote(include)}` : "";
			const target = shellQuote(conn.toRemotePath(path || "."));
			const { out, code } = await runRemote(`${rg} -n${inc} -e ${shellQuote(pattern)} ${target}`);
			if (code === 1 && !out.trim()) return textResult("(no matches)");
			return commandResult(out, "", code);
		},
	};
}

function failingBackend(reason: string): Backend {
	const fail = async (): Promise<ToolResult> => textResult(`SSH remote unavailable: ${reason}`, true);
	return { bash: fail, read: fail, write: fail, edit: fail, ls: fail, find: fail, grep: fail };
}

type BackendMode = "local" | "ssh" | "ssh-broken";

interface BackendSelection {
	backend: Backend;
	mode: BackendMode;
}

function selectBackend(pi: PiModule): BackendSelection {
	const descriptor = process.env[SSH_DESCRIPTOR_ENV];
	if (!descriptor) return { backend: localBackend(pi), mode: "local" };
	try {
		return { backend: remoteBackend(pi, descriptor), mode: "ssh" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { backend: failingBackend(reason), mode: "ssh-broken" };
	}
}

// read/write/edit run pi's own tool code. The bridge resolves pi's package entry (it runs inside pi,
// where the bare specifier resolves) and passes it here; a bare node child can't resolve it itself.
const PI_ENTRY = process.env.PI_CODING_AGENT_ENTRY;
if (!PI_ENTRY) {
	log("fatal: PI_CODING_AGENT_ENTRY is not set; the bridge must provide pi's package entry");
	process.exit(1);
}
// SAFETY: PI_ENTRY is pi's own package entry, resolved by the bridge from inside pi; its exports
// include these tool factories. We assert only the subset we call, and a mismatch throws at first use.
const pi = (await import(PI_ENTRY)) as PiModule;

const { backend, mode: BACKEND_MODE } = selectBackend(pi);

function send(message: JsonRpcResponse): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcId | undefined, result: JsonValue): void {
	send({ jsonrpc: "2.0", id: id ?? null, result });
}

function replyError(id: JsonRpcId | undefined, code: number, message: string): void {
	send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

interface Tool {
	name: string;
	description: string;
	inputSchema: JsonObject;
	run(args: JsonObject): Promise<ToolResult>;
}

// Always the host — this MCP server runs on the host machine, even in SSH mode. Exposed only when
// SSH is active (the regular bash then targets the remote), mirroring pi's own ssh extension, which
// adds host_bash so host-local work (clipboard files, pi config) stays reachable.
async function hostBash(command: string): Promise<ToolResult> {
	const r = await runCommand("bash", ["-c", command]);
	return textResult(commandText(r.stdout, r.stderr, r.code), r.code === null);
}

const HOST_BASH_TOOL: Tool = {
	name: "host_bash",
	description:
		"Run a shell command with bash -c on the HOST machine running pi (not the SSH remote). Use for host-local files and commands — e.g. a pasted clipboard image under /tmp, or pi's own config.",
	inputSchema: {
		type: "object",
		properties: { command: { type: "string", description: "The shell command to run on the host." } },
		required: ["command"],
	},
	run: (args) => hostBash(requiredStringField(args, "command", "arguments")),
};

const TOOLS: Tool[] = [
	{
		name: "bash",
		description: "Run a shell command with bash -c in the working directory.",
		inputSchema: {
			type: "object",
			properties: { command: { type: "string", description: "The shell command to run." } },
			required: ["command"],
		},
		run: (args) => backend.bash(requiredStringField(args, "command", "arguments")),
	},
	{
		name: "read",
		description:
			"Read a file. Text files return their UTF-8 contents (optional 1-based line offset/limit); image files (jpeg/png/gif/webp) are returned as an image you can view directly.",
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Path to the file (absolute or relative to cwd)." },
				offset: { type: "number", description: "1-based first line to return." },
				limit: { type: "number", description: "Maximum number of lines to return." },
			},
			required: ["file_path"],
		},
		run: (args) =>
			backend.read(
				requiredStringField(args, "file_path", "arguments"),
				optionalNumberField(args, "offset", "arguments"),
				optionalNumberField(args, "limit", "arguments"),
			),
	},
	{
		name: "write",
		description: "Write (create or overwrite) a UTF-8 text file, creating parent directories.",
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Path to the file (absolute or relative to cwd)." },
				content: { type: "string", description: "Full file contents to write." },
			},
			required: ["file_path", "content"],
		},
		run: (args) => backend.write(requiredStringField(args, "file_path", "arguments"), requiredStringField(args, "content", "arguments")),
	},
	{
		name: "edit",
		description: "Replace an exact string in a file. old_string must match a unique region of the file.",
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Path to the file (absolute or relative to cwd)." },
				old_string: { type: "string", description: "Exact text to replace." },
				new_string: { type: "string", description: "Replacement text." },
			},
			required: ["file_path", "old_string", "new_string"],
		},
		run: (args) =>
			backend.edit(
				requiredStringField(args, "file_path", "arguments"),
				requiredStringField(args, "old_string", "arguments"),
				requiredStringField(args, "new_string", "arguments"),
			),
	},
	{
		name: "ls",
		description: "List the entries of a directory. Directories are shown with a trailing slash.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string", description: "Directory (absolute or relative to cwd). Defaults to cwd." } },
			required: [],
		},
		run: (args) => backend.ls(optionalStringField(args, "path", "arguments") ?? "."),
	},
	{
		name: "find",
		description: "Find files by name glob under a directory (excludes .git).",
		inputSchema: {
			type: "object",
			properties: {
				glob: { type: "string", description: "Name glob, e.g. *.ts" },
				path: { type: "string", description: "Directory to search. Defaults to cwd." },
			},
			required: ["glob"],
		},
		run: (args) => backend.find(requiredStringField(args, "glob", "arguments"), optionalStringField(args, "path", "arguments") ?? "."),
	},
	{
		name: "grep",
		description: "Search file contents for a pattern (recursive, with line numbers).",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Pattern to search for." },
				path: { type: "string", description: "File or directory to search. Defaults to cwd." },
				include: { type: "string", description: "Only search files matching this glob, e.g. *.ts" },
			},
			required: ["pattern"],
		},
		run: (args) =>
			backend.grep(
				requiredStringField(args, "pattern", "arguments"),
				optionalStringField(args, "path", "arguments") ?? ".",
				optionalStringField(args, "include", "arguments"),
			),
	},
	// host_bash only in SSH mode — locally the regular bash already is the host.
	...(BACKEND_MODE === "local" ? [] : [HOST_BASH_TOOL]),
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

async function handleToolCall(id: JsonRpcId | undefined, params: JsonValue | undefined): Promise<void> {
	const name = isJsonObject(params) ? params.name : undefined;
	if (!isString(name)) {
		replyError(id, -32602, "tools/call requires a string 'name'");
		return;
	}
	const tool = TOOL_BY_NAME.get(name);
	if (!tool) {
		replyError(id, -32602, `unknown tool ${JSON.stringify(name)}`);
		return;
	}
	const rawArguments = isJsonObject(params) ? params.arguments : undefined;
	const args = isJsonObject(rawArguments) ? rawArguments : {};
	log(`${tool.name} ${JSON.stringify(args).slice(0, 200)}`);
	try {
		const result = await tool.run(args);
		reply(id, { content: result.content, isError: result.isError });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		reply(id, { content: [{ type: "text", text: `${tool.name} failed: ${reason}` }], isError: true });
	}
}

async function handle(request: JsonRpcRequest): Promise<void> {
	const { id, method, params } = request;
	switch (method) {
		case "initialize": {
			const requested = isJsonObject(params) ? params.protocolVersion : undefined;
			reply(id, {
				protocolVersion: isString(requested) && SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_FALLBACK,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
			});
			return;
		}
		case "notifications/initialized":
			return;
		case "ping":
			reply(id, {});
			return;
		case "tools/list":
			reply(id, {
				tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
			});
			return;
		case "tools/call":
			await handleToolCall(id, params);
			return;
		default:
			if (id !== undefined && id !== null) replyError(id, -32601, `method not found: ${method}`);
			return;
	}
}

/** Requests and notifications carry a method; anything else (a response to us, junk) is not ours. */
function parseRequest(frame: JsonValue): JsonRpcRequest | undefined {
	if (!isJsonObject(frame)) return undefined;
	const method = frame.method;
	if (!isString(method)) return undefined;
	const id = frame.id;
	return { id: isStringOrNumber(id) || id === null ? id : undefined, method, params: frame.params };
}

function main(): void {
	log(`started (backend: ${BACKEND_MODE})`);
	const pending = new Set<Promise<void>>();
	const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let frame: JsonValue;
		try {
			frame = JSON.parse(trimmed);
		} catch {
			log(`non-JSON line ignored: ${trimmed.slice(0, 200)}`);
			return;
		}
		const request = parseRequest(frame);
		if (request === undefined) {
			log(`frame without a method ignored: ${trimmed.slice(0, 200)}`);
			return;
		}
		const task = handle(request).catch((error) => {
			log(`handler error: ${error instanceof Error ? error.message : String(error)}`);
		});
		pending.add(task);
		void task.finally(() => pending.delete(task));
	});
	rl.on("close", () => {
		log(`stdin closed, draining ${pending.size} in-flight`);
		void Promise.allSettled([...pending]).then(() => {
			log("exiting");
			process.exit(0);
		});
	});
}

main();
