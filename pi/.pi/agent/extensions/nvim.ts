import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

const CODE_BYTES_MAX = 48 * 1024;
const RESPONSE_BYTES_MAX = 64 * 1024;
const SERVERS_MAX = 32;
const TIMEOUT_MS = 3_000;

// Nvim lacks CLI peer discovery, so /nvim uses a transient clean instance to call
// serverlist({peer=true}). Tool activation represents attachment without changing prompt
// text, so buffer churn does not invalidate prompt-cache prefixes.
const DISCOVER_LUA = `
local self = vim.v.servername
local peers = vim.fn.serverlist({ peer = true })
local servers = {}
for _, server in ipairs(peers) do
  if server ~= self and #servers < ${SERVERS_MAX} then
    servers[#servers + 1] = server
  end
end
io.stdout:write(vim.json.encode({
  self = self,
  servers = servers,
  truncated = #peers - 1 > #servers,
}))
`;

const PROBE_LUA = `
local clients = {}
for _, client in ipairs(vim.lsp.get_clients()) do
  clients[#clients + 1] = {
    id = client.id,
    name = client.name,
    root = client.root_dir,
  }
end
return {
  buffer = vim.api.nvim_buf_get_name(0),
  cwd = vim.fn.getcwd(),
  lsp_clients = clients,
  mode = vim.fn.mode(1),
  modified = vim.bo.modified,
  pid = vim.fn.getpid(),
  server = vim.v.servername,
  ui_count = #vim.api.nvim_list_uis(),
}
`;

const LUA_WRAPPER = `
(function()
  local chunk, load_error = load(vim.base64.decode(_A), "=(pi-nvim)", "t")
  if not chunk then
    return vim.json.encode({ ok = false, error = load_error })
  end
  local ok, data = pcall(chunk)
  local response
  if ok then
    response = { ok = true, data = data }
  else
    response = { ok = false, error = tostring(data) }
  end
  local encoded = vim.json.encode(response)
  if #encoded > ${RESPONSE_BYTES_MAX} then
    return vim.json.encode({ ok = false, error = "Nvim result exceeds 64 KiB" })
  end
  return encoded
end)()
`;

type LuaResponse = { ok: true; data?: unknown } | { ok: false; error: string };
type Discovery = { self: string; servers: string[]; truncated: boolean };
type NvimState = { selectedPid: number | null; selectedServer: string | null };

class NvimUnavailableError extends Error {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function validateServer(server: string): void {
	if (!server.startsWith("/")) {
		throw new Error("Only absolute Unix socket addresses are supported");
	}
}

async function runNvim(
	pi: ExtensionAPI,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<string> {
	const result = await pi.exec("nvim", args, { signal, timeout: TIMEOUT_MS });
	if (result.killed) {
		const reason = signal?.aborted ? "was aborted" : "timed out";
		throw new Error(
			`Nvim command ${reason}; inspect the target before retrying`,
		);
	}
	if (result.code !== 0) {
		const reason =
			result.stderr.trim() ||
			result.stdout.trim() ||
			`exit code ${result.code}`;
		const message = `Nvim command failed: ${reason}`;
		if (args[0] === "--server") throw new NvimUnavailableError(message);
		throw new Error(message);
	}
	return result.stdout.trim();
}

async function callLua(
	pi: ExtensionAPI,
	server: string,
	code: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	validateServer(server);
	if (Buffer.byteLength(code, "utf8") > CODE_BYTES_MAX) {
		throw new Error("Nvim Lua code exceeds 48 KiB");
	}
	const encoded = Buffer.from(code, "utf8").toString("base64");
	const expression = `luaeval(${JSON.stringify(LUA_WRAPPER)}, ${JSON.stringify(encoded)})`;
	const output = await runNvim(
		pi,
		["--server", server, "--remote-expr", expression],
		signal,
	);

	let response: LuaResponse;
	try {
		response = JSON.parse(output) as LuaResponse;
	} catch {
		throw new Error(`Nvim returned invalid JSON: ${output.slice(0, 500)}`);
	}
	if (!response.ok) throw new Error(response.error);
	return response.data;
}

async function probeServer(
	pi: ExtensionAPI,
	server: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	const data = await callLua(pi, server, PROBE_LUA, signal);
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("Nvim probe returned an invalid object");
	}
	return { address: server, ...(data as Record<string, unknown>) };
}

async function discoverServers(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
): Promise<{ servers: string[]; truncated: boolean }> {
	const output = await runNvim(
		pi,
		["--clean", "--headless", "-c", `lua ${DISCOVER_LUA}`, "-c", "qa!"],
		signal,
	);
	let discovery: Discovery;
	try {
		discovery = JSON.parse(output) as Discovery;
	} catch {
		throw new Error(
			`Nvim discovery returned invalid JSON: ${output.slice(0, 500)}`,
		);
	}
	if (!Array.isArray(discovery.servers))
		throw new Error("Nvim discovery returned no server list");

	const candidates = new Set<string>();
	if (process.env.NVIM) candidates.add(process.env.NVIM);
	for (const server of discovery.servers) {
		if (typeof server === "string" && server !== discovery.self)
			candidates.add(server);
	}
	const servers = [...candidates].slice(0, SERVERS_MAX);
	return {
		servers,
		truncated: discovery.truncated || candidates.size > servers.length,
	};
}

function formatResult(data: unknown): string {
	const text = JSON.stringify(data ?? null, null, 2);
	const truncation = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Output truncated from ${formatSize(truncation.outputBytes)}.]`;
}

function serverLabel(server: Record<string, unknown>): string {
	const buffer =
		typeof server.buffer === "string" && server.buffer
			? server.buffer
			: "[No Name]";
	const dirty = server.modified ? " [+]" : "";
	const clients = Array.isArray(server.lsp_clients)
		? server.lsp_clients
				.map((client) =>
					typeof client === "object" && client && "name" in client
						? String(client.name)
						: "",
				)
				.filter(Boolean)
				.join(",")
		: "";
	return `${server.pid} | ${buffer}${dirty} | ${server.cwd} | LSP: ${clients || "none"}`;
}

function clearSelectedServer(
	pi: ExtensionAPI,
	state: NvimState,
	ctx: ExtensionContext,
): void {
	state.selectedPid = null;
	state.selectedServer = null;
	const activeTools = pi.getActiveTools();
	if (activeTools.includes("nvim")) {
		pi.setActiveTools(activeTools.filter((name) => name !== "nvim"));
	}
	ctx.ui.setStatus("nvim", undefined);
}

function selectServer(
	pi: ExtensionAPI,
	state: NvimState,
	ctx: ExtensionCommandContext,
	server: Record<string, unknown>,
): void {
	state.selectedPid = typeof server.pid === "number" ? server.pid : null;
	state.selectedServer = String(server.address);
	const activeTools = pi.getActiveTools();
	if (!activeTools.includes("nvim")) {
		pi.setActiveTools([...activeTools, "nvim"]);
	}

	const buffer =
		typeof server.buffer === "string" && server.buffer
			? server.buffer
			: "[No Name]";
	const name = buffer.split("/").pop() || buffer;
	ctx.ui.setStatus("nvim", `nvim:${server.pid} ${name}`);
	const message = [
		`Connected to Nvim ${server.pid}`,
		String(server.address),
		buffer,
		String(server.cwd),
	].join("\n");
	ctx.ui.notify(message, "info");
}

function createNvimTool(pi: ExtensionAPI, state: NvimState) {
	return defineTool({
		name: "nvim",
		label: "Nvim",
		description:
			"Execute arbitrary Lua in the live Nvim selected by the user with /nvim. " +
			"Use vim.api for current buffers, windows, edits, diagnostics, and existing LSP clients. " +
			"Editor state is live: query it before acting and return JSON-encodable data.",
		parameters: Type.Object({
			code: Type.String({
				description: "Lua chunk; return JSON-encodable data",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!state.selectedServer) throw new Error("No Nvim selected; run /nvim");
			const server = state.selectedServer;
			try {
				const data = await callLua(pi, server, params.code, signal);
				return {
					content: [{ type: "text", text: formatResult(data) }],
					details: { server },
				};
			} catch (error) {
				if (!(error instanceof NvimUnavailableError)) throw error;
				clearSelectedServer(pi, state, ctx);
				throw new Error(`${error.message}\nNvim disconnected; run /nvim.`);
			}
		},
	});
}

export default function (pi: ExtensionAPI) {
	const state: NvimState = {
		selectedPid: null,
		selectedServer: process.env.NVIM || null,
	};
	pi.registerTool(createNvimTool(pi, state));
	pi.on("session_start", async (_event, ctx) => {
		if (!state.selectedServer) {
			clearSelectedServer(pi, state, ctx);
			return;
		}
		try {
			const server = await probeServer(pi, state.selectedServer, undefined);
			state.selectedPid = typeof server.pid === "number" ? server.pid : null;
		} catch {
			clearSelectedServer(pi, state, ctx);
		}
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (state.selectedPid === null || processIsAlive(state.selectedPid)) return;
		clearSelectedServer(pi, state, ctx);
	});
	pi.registerCommand("nvim", {
		description: "Select a live Unix Nvim instance",
		handler: async (args, ctx) => {
			try {
				const address = args.trim();
				if (address) {
					const server = await probeServer(pi, address, undefined);
					selectServer(pi, state, ctx, server);
					return;
				}

				const discovery = await discoverServers(pi, undefined);
				const probes = await Promise.all(
					discovery.servers.map(async (address) => {
						try {
							return await probeServer(pi, address, undefined);
						} catch {
							return null;
						}
					}),
				);
				const servers = probes.filter((server) => server !== null);
				if (servers.length === 0) {
					ctx.ui.notify("No active Nvim instances found", "warning");
					return;
				}
				const labels = servers.map(serverLabel);
				const choice = await ctx.ui.select("Connect to Nvim", labels);
				if (!choice) return;
				const server = servers[labels.indexOf(choice)];
				selectServer(pi, state, ctx, server);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}
