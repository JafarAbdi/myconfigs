import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROTOCOL_VERSION = 1;
const RPC_DEADLINE_MS = 2_000;
const RUNTIME_DIR_NAME = "pi-peer";
const SOCKET_SUFFIX = ".sock";

interface PeerInfo {
	id: string;
	name?: string;
	cwd: string;
	idle: boolean;
}

type Request =
	| { version: 1; type: "ping" }
	| {
			version: 1;
			type: "send";
			messageId: string;
			from: PeerInfo;
			message: string;
	  };

interface Response {
	version: 1;
	ok: boolean;
	error?: string;
	messageId?: string;
	peer?: PeerInfo;
}

interface Runtime {
	active: boolean;
	claim: Server;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	server: Server;
	shutdown: AbortController;
	socketPath: string;
	sockets: Set<Socket>;
	outbound: Promise<void>;
}

class TransportError extends Error {
	constructor(message: string, readonly transmitted: boolean) {
		super(message);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String(error.code)
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePeer(value: unknown): PeerInfo | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.cwd !== "string" || typeof value.idle !== "boolean") {
		return undefined;
	}
	if (value.name !== undefined && typeof value.name !== "string") return undefined;
	return { id: value.id, name: value.name, cwd: value.cwd, idle: value.idle };
}

function parseRequest(value: unknown): Request {
	if (!isRecord(value) || value.version !== PROTOCOL_VERSION) {
		throw new Error("Unsupported peer protocol");
	}
	if (value.type === "ping") return { version: PROTOCOL_VERSION, type: "ping" };
	if (value.type !== "send") throw new Error("Unknown peer request");

	const from = parsePeer(value.from);
	if (!from || typeof value.messageId !== "string" || typeof value.message !== "string") {
		throw new Error("Malformed peer message");
	}
	const message = value.message;
	if (!message.trim()) throw new Error("Peer message is empty");
	if (Buffer.byteLength(message, "utf8") > DEFAULT_MAX_BYTES) {
		throw new Error(`Peer message exceeds Pi's ${DEFAULT_MAX_BYTES}-byte limit`);
	}
	return {
		version: PROTOCOL_VERSION,
		type: "send",
		messageId: value.messageId,
		from,
		message,
	};
}

function parseResponse(value: unknown): Response {
	if (!isRecord(value) || value.version !== PROTOCOL_VERSION || typeof value.ok !== "boolean") {
		throw new Error("Malformed peer response");
	}
	if (value.error !== undefined && typeof value.error !== "string") {
		throw new Error("Malformed peer error");
	}
	if (value.messageId !== undefined && typeof value.messageId !== "string") {
		throw new Error("Malformed peer acknowledgement");
	}
	const peer = value.peer === undefined ? undefined : parsePeer(value.peer);
	if (value.peer !== undefined && !peer) throw new Error("Malformed peer identity");
	return {
		version: PROTOCOL_VERSION,
		ok: value.ok,
		error: value.error,
		messageId: value.messageId,
		peer,
	};
}

function runtimeDirectory(): string {
	const directory = process.env.XDG_RUNTIME_DIR;
	if (!directory || !isAbsolute(directory)) {
		throw new Error("peer requires an absolute XDG_RUNTIME_DIR");
	}
	return join(directory, RUNTIME_DIR_NAME);
}

function currentPeer(runtime: Runtime): PeerInfo {
	return {
		id: runtime.ctx.sessionManager.getSessionId(),
		name: runtime.pi.getSessionName(),
		cwd: runtime.ctx.cwd,
		idle: runtime.ctx.isIdle(),
	};
}

function writeResponse(socket: Socket, response: Response): void {
	socket.end(`${JSON.stringify(response)}\n`);
}

function incomingContent(from: PeerInfo, message: string): string {
	const sender = from.name ? `“${from.name}”` : "an unnamed session";
	return [
		`Peer message from ${sender} (${from.id})`,
		`Working directory: ${from.cwd}`,
		"",
		message,
		"",
		`Act on this message if needed. Send requested results to ${from.id} using peer.`,
		"Never acknowledge receipt or discuss whether a response is needed.",
	].join("\n");
}

function handleConnection(runtime: Runtime, socket: Socket): void {
	runtime.sockets.add(socket);
	socket.setEncoding("utf8");
	let input = "";
	let handled = false;
	const deadline = AbortSignal.timeout(RPC_DEADLINE_MS);
	const signal = AbortSignal.any([runtime.shutdown.signal, deadline]);
	const abort = () => socket.destroy();
	signal.addEventListener("abort", abort, { once: true });

	socket.on("data", (chunk: string) => {
		if (handled) return;
		input += chunk;
		const newline = input.indexOf("\n");
		if (newline < 0) return;
		handled = true;
		signal.removeEventListener("abort", abort);

		try {
			const request = parseRequest(JSON.parse(input.slice(0, newline)));
			if (request.type === "ping") {
				writeResponse(socket, { version: PROTOCOL_VERSION, ok: true, peer: currentPeer(runtime) });
				return;
			}
			if (!runtime.active) throw new Error("Peer session is shutting down");
			if (request.from.id === currentPeer(runtime).id) throw new Error("A peer cannot message itself");

			runtime.pi.sendMessage(
				{
					customType: "peer-message",
					content: incomingContent(request.from, request.message),
					display: true,
					details: { messageId: request.messageId, from: request.from },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			writeResponse(socket, {
				version: PROTOCOL_VERSION,
				ok: true,
				messageId: request.messageId,
			});
		} catch (error) {
			writeResponse(socket, {
				version: PROTOCOL_VERSION,
				ok: false,
				error: errorMessage(error),
			});
		}
	});

	socket.on("error", () => {});
	socket.on("close", () => {
		signal.removeEventListener("abort", abort);
		runtime.sockets.delete(socket);
	});
}

function request(
	runtime: Runtime,
	socketPath: string,
	payload: Request,
	callerSignal?: AbortSignal,
): Promise<Response> {
	const deadline = AbortSignal.timeout(RPC_DEADLINE_MS);
	const signals = [runtime.shutdown.signal, deadline];
	if (callerSignal) signals.unshift(callerSignal);
	const signal = AbortSignal.any(signals);

	return new Promise((resolve, reject) => {
		let input = "";
		let settled = false;
		let transmitted = false;
		const socket = createConnection(socketPath);
		runtime.sockets.add(socket);
		socket.setEncoding("utf8");

		const finish = (error?: unknown, response?: Response) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			socket.destroy();
			if (error) reject(new TransportError(errorMessage(error), transmitted));
			else resolve(response!);
		};
		const abort = () => {
			const reason = deadline.aborted
				? "Peer RPC deadline exceeded"
				: runtime.shutdown.signal.aborted
					? "Peer session shut down"
					: "Peer request cancelled";
			finish(new Error(reason));
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			abort();
			return;
		}

		socket.on("connect", () => {
			try {
				socket.write(`${JSON.stringify(payload)}\n`);
				transmitted = true;
			} catch (error) {
				finish(error);
			}
		});
		socket.on("data", (chunk: string) => {
			input += chunk;
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			try {
				finish(undefined, parseResponse(JSON.parse(input.slice(0, newline))));
			} catch (error) {
				finish(error);
			}
		});
		socket.on("error", (error) => finish(error));
		socket.on("close", () => {
			runtime.sockets.delete(socket);
			if (!settled) finish(new Error("Peer closed the connection without acknowledging"));
		});
	});
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			server.off("error", onError);
			server.off("listening", onListening);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onListening = () => {
			cleanup();
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
	});
}

async function startRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<Runtime> {
	if (process.platform !== "linux" || !process.getuid) {
		throw new Error("peer requires Linux abstract Unix sockets");
	}
	const directory = runtimeDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const sessionId = ctx.sessionManager.getSessionId();
	const socketPath = join(directory, `${sessionId}${SOCKET_SUFFIX}`);
	let runtime: Runtime;
	// The kernel-owned abstract socket is the session claim: atomic, race-free, and removed on crash.
	const claim = createServer((socket) => socket.destroy());
	const server = createServer((socket) => handleConnection(runtime, socket));
	runtime = {
		active: true,
		claim,
		ctx,
		pi,
		server,
		shutdown: new AbortController(),
		socketPath,
		sockets: new Set(),
		outbound: Promise.resolve(),
	};

	try {
		await listen(claim, `\0pi-peer-${process.getuid()}-${sessionId}`);
		await rm(socketPath, { force: true });
		await listen(server, socketPath);
	} catch (error) {
		runtime.active = false;
		runtime.shutdown.abort();
		await Promise.all([closeServer(server), closeServer(claim)]);
		if (errorCode(error) === "EADDRINUSE") {
			throw new Error(`Peer is already active for session ${sessionId}`);
		}
		throw error;
	}
	const fail = (error: Error) => {
		if (!runtime.active) return;
		ctx.ui.notify(`Peer listener failed: ${error.message}`, "error");
		void stopRuntime(runtime).catch((cleanupError) => {
			ctx.ui.notify(`Peer cleanup failed: ${errorMessage(cleanupError)}`, "error");
		});
	};
	server.on("error", fail);
	claim.on("error", fail);
	return runtime;
}

async function stopRuntime(runtime: Runtime): Promise<void> {
	if (!runtime.active) return;
	runtime.active = false;
	runtime.shutdown.abort(new Error("Peer session shut down"));
	for (const socket of runtime.sockets) socket.destroy();
	// Keep the abstract claim until the public socket has closed and its pathname is gone.
	await closeServer(runtime.server);
	await closeServer(runtime.claim);
}

async function discoverPeers(runtime: Runtime, signal?: AbortSignal): Promise<PeerInfo[]> {
	if (!runtime.active) throw new Error("Peer is not active in this session");
	const local = currentPeer(runtime);
	const directory = runtimeDirectory();
	const entries = await readdir(directory, { withFileTypes: true });
	const discovered = await Promise.all(entries
		.filter((entry) => entry.name.endsWith(SOCKET_SUFFIX))
		.map(async (entry): Promise<PeerInfo | undefined> => {
			const socketPath = join(directory, entry.name);
			if (socketPath === runtime.socketPath) return local;
			try {
				const response = await request(
					runtime,
					socketPath,
					{ version: PROTOCOL_VERSION, type: "ping" },
					signal,
				);
				return response.ok ? response.peer : undefined;
			} catch (error) {
				if (signal?.aborted || runtime.shutdown.signal.aborted) throw error;
				return undefined;
			}
		}));
	const peers = [...new Map(discovered
		.filter((peer): peer is PeerInfo => peer !== undefined)
		.map((peer) => [peer.id, peer])).values()];
	return peers.sort((left, right) => {
		if (left.id === local.id) return -1;
		if (right.id === local.id) return 1;
		return (left.name ?? left.id).localeCompare(right.name ?? right.id);
	});
}

function peerLabel(peer: PeerInfo): string {
	return `${peer.name ?? "(unnamed)"} (${peer.id})`;
}

function formatPeers(peers: PeerInfo[], selfId: string): string {
	return peers.map((peer) => {
		const flags = [peer.id === selfId ? "self" : undefined, peer.idle ? "idle" : "busy"]
			.filter(Boolean)
			.join(", ");
		return `${peerLabel(peer)} — ${peer.cwd} [${flags}]`;
	}).join("\n");
}

function resolveTarget(peers: PeerInfo[], selfId: string, target: string): PeerInfo {
	let matches = peers.filter((peer) => peer.id === target);
	if (matches.length === 0 && target.length >= 8) {
		matches = peers.filter((peer) => peer.id.startsWith(target));
	}
	if (matches.length === 0) {
		matches = peers.filter((peer) => peer.name === target);
	}
	if (matches.length === 0) throw new Error(`No live peer matches “${target}”`);
	if (matches.length > 1) {
		throw new Error(`Ambiguous peer “${target}”: ${matches.map(peerLabel).join(", ")}`);
	}
	if (matches[0].id === selfId) throw new Error("A peer cannot message itself");
	return matches[0];
}

async function serialize<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
	const result = runtime.outbound.then(operation);
	runtime.outbound = result.then(() => undefined, () => undefined);
	return result;
}

async function sendPeer(
	runtime: Runtime,
	targetText: string,
	messageText: string,
	signal?: AbortSignal,
): Promise<{ messageId: string; target: PeerInfo }> {
	const message = messageText;
	if (!message.trim()) throw new Error("Peer message is empty");
	if (Buffer.byteLength(message, "utf8") > DEFAULT_MAX_BYTES) {
		throw new Error(`Peer message exceeds Pi's ${DEFAULT_MAX_BYTES}-byte limit`);
	}

	return serialize(runtime, async () => {
		if (!runtime.active) throw new Error("Peer is not active in this session");
		const self = currentPeer(runtime);
		const target = resolveTarget(await discoverPeers(runtime, signal), self.id, targetText);
		const messageId = randomUUID();
		let response: Response;
		try {
			response = await request(
				runtime,
				join(runtimeDirectory(), `${target.id}${SOCKET_SUFFIX}`),
				{
					version: PROTOCOL_VERSION,
					type: "send",
					messageId,
					from: self,
					message,
				},
				signal,
			);
		} catch (error) {
			if (error instanceof TransportError && error.transmitted) {
				throw new Error(`Delivery unknown for ${messageId}: ${error.message}`);
			}
			throw error;
		}
		if (!response.ok) throw new Error(`Peer rejected ${messageId}: ${response.error ?? "unknown error"}`);
		if (response.messageId !== messageId) {
			throw new Error(`Delivery unknown for ${messageId}: peer returned a mismatched acknowledgement`);
		}
		return { messageId, target };
	});
}

const PARAMETERS = Type.Object({
	action: StringEnum(["list", "send"] as const, {
		description: "List live peers or send one a message",
	}),
	to: Type.Optional(Type.String({ description: "Exact session name, UUID, or unique UUID prefix" })),
	message: Type.Optional(Type.String({ description: "Plain-text message for the peer" })),
}, { additionalProperties: false });

export default function (pi: ExtensionAPI) {
	let runtime: Runtime | undefined;
	let toolRegistered = false;
	let completionCache: { expiresAt: number; value: Promise<PeerInfo[]> } | undefined;

	const completePeer = async (prefix: string) => {
		if (/\s/u.test(prefix)) return null;
		const active = runtime;
		if (!active?.active) return null;
		const now = Date.now();
		if (!completionCache || completionCache.expiresAt <= now) {
			completionCache = { expiresAt: now + 1_000, value: discoverPeers(active) };
		}
		let peers: PeerInfo[];
		try {
			peers = await completionCache.value;
		} catch {
			completionCache = undefined;
			return null;
		}
		const names = new Map<string, number>();
		for (const peer of peers) {
			if (peer.name) names.set(peer.name, (names.get(peer.name) ?? 0) + 1);
		}
		const query = prefix.toLowerCase();
		const items = peers
			.filter((peer) => peer.id !== currentPeer(active).id)
			.filter((peer) => peer.id.startsWith(query) || peer.name?.toLowerCase().startsWith(query))
			.map((peer) => ({
				value: peer.name && !/\s/u.test(peer.name) && names.get(peer.name) === 1 ? peer.name : peer.id,
				label: peer.name ?? peer.id,
				description: `${peer.id} · ${peer.idle ? "idle" : "busy"} · ${peer.cwd}`,
			}));
		return items.length > 0 ? items : null;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			runtime = await startRuntime(pi, ctx);
			completionCache = undefined;
			if (!toolRegistered) {
				toolRegistered = true;
				pi.registerTool<typeof PARAMETERS, {
					peers?: PeerInfo[];
					messageId?: string;
					target?: PeerInfo;
				}>({
					name: "peer",
					label: "Peer",
					description: "List or message live local Pi TUI sessions. Send only when explicitly requested by the user or an inbound peer; never send acknowledgements or social replies.",
					promptSnippet: "List or explicitly message live local Pi peers",
					promptGuidelines: [
						"Use peer only when the user explicitly requests peer coordination or an inbound peer asks for a substantive reply.",
					],
					parameters: PARAMETERS,
					async execute(_toolCallId, params, signal) {
						const active = runtime;
						if (!active?.active) throw new Error("Peer is unavailable in this session");
						if (params.action === "list") {
							const peers = await discoverPeers(active, signal);
							return {
								content: [{ type: "text", text: formatPeers(peers, currentPeer(active).id) }],
								details: { peers },
							};
						}
						if (!params.to || !params.message) {
							throw new Error("peer send requires both to and message");
						}
						const sent = await sendPeer(active, params.to, params.message, signal);
						return {
							content: [{
								type: "text",
								text: `Peer ${peerLabel(sent.target)} accepted message ${sent.messageId}`,
							}],
							details: sent,
						};
					},
				});
			}
		} catch (error) {
			runtime = undefined;
			ctx.ui.notify(`Peer unavailable: ${errorMessage(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		const active = runtime;
		runtime = undefined;
		completionCache = undefined;
		if (active) await stopRuntime(active);
	});

	pi.registerCommand("peer", {
		description: "List peers or send with /peer <name-or-id> <message>",
		getArgumentCompletions: completePeer,
		handler: async (args, ctx) => {
			const active = runtime;
			if (!active?.active) {
				ctx.ui.notify("Peer is unavailable in this session", "error");
				return;
			}
			const input = args.trim();
			if (!input) {
				try {
					const peers = await discoverPeers(active);
					ctx.ui.notify(formatPeers(peers, currentPeer(active).id), "info");
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}
			const separator = input.search(/\s/u);
			if (separator < 0) {
				ctx.ui.notify("Usage: /peer <name-or-id> <message>", "warning");
				return;
			}
			try {
				const sent = await sendPeer(
					active,
					input.slice(0, separator),
					input.slice(separator).trim(),
				);
				ctx.ui.notify(`Peer ${peerLabel(sent.target)} accepted message ${sent.messageId}`, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}
