// Linux process identity, process-group membership, and Unix-socket liveness. A process token is a
// start-time-derived identity (from /proc) that detects PID reuse before signaling or reclaiming.
import { chmod, lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	JOB_LIVENESS_HANDSHAKE_BYTES_MAX,
	JOB_LIVENESS_OBSERVER_COUNT_MAX,
	JOB_LIVENESS_SOCKET_PATH_BYTES_MAX,
	PROCESS_DIRECTORY_ENTRY_COUNT_MAX,
	PROCESS_GROUP_DRAIN_PASS_COUNT_MAX,
	PROCESS_METADATA_BYTES_MAX,
} from "./limits.ts";

if (process.platform !== "linux") throw new Error("workflows extension requires Linux");

const LIVENESS_SOCKET_NAME = "liveness.sock";
const LIVENESS_PROTOCOL = "pi-workflows-liveness-v1";
const LIVENESS_BUSY = "busy\n";
export const WRITER_OWNER_ENV = "PI_WORKFLOWS_WRITER_OWNER";

export type JobLivenessErrorKind =
	| "channel-closed"
	| "channel-unavailable"
	| "observer-limit"
	| "process-missing"
	| "protocol";

export class JobLivenessError extends Error {
	readonly kind: JobLivenessErrorKind;

	constructor(kind: JobLivenessErrorKind, message: string) {
		super(message);
		this.name = "JobLivenessError";
		this.kind = kind;
	}
}

export interface JobLivenessServer {
	signal: AbortSignal;
	close(): Promise<void>;
}

export interface JobLivenessMonitor {
	signal: AbortSignal;
	close(): void;
}

function livenessSocketPath(jobDir: string): string {
	const path = join(jobDir, LIVENESS_SOCKET_NAME);
	if (Buffer.byteLength(path) > JOB_LIVENESS_SOCKET_PATH_BYTES_MAX) {
		throw new Error("job liveness socket path exceeds limit");
	}
	return path;
}

export function assertJobLivenessPath(jobDir: string): void {
	livenessSocketPath(jobDir);
}

function livenessHandshake(token: string): string {
	const handshake = `${LIVENESS_PROTOCOL} ${token}\n`;
	if (Buffer.byteLength(handshake) > JOB_LIVENESS_HANDSHAKE_BYTES_MAX) {
		throw new Error("job liveness handshake exceeds limit");
	}
	return handshake;
}

async function assertSocketAbsent(path: string): Promise<void> {
	try {
		await lstat(path);
		throw new Error(`job liveness socket already exists: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function acceptObserver(
	socket: Socket,
	connections: Set<Socket>,
	handshake: string,
): void {
	socket.on("error", () => socket.destroy());
	if (connections.size >= JOB_LIVENESS_OBSERVER_COUNT_MAX) {
		socket.end(LIVENESS_BUSY);
		return;
	}
	connections.add(socket);
	socket.once("close", () => connections.delete(socket));
	socket.on("data", () => socket.destroy());
	socket.write(handshake);
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.removeListener("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ path, backlog: JOB_LIVENESS_OBSERVER_COUNT_MAX });
	});
}

async function closeServer(
	server: Server,
	connections: Set<Socket>,
	path: string,
): Promise<void> {
	const closed = new Promise<void>((resolve, reject) => {
		server.close((error?: Error) => error ? reject(error) : resolve());
	});
	for (const socket of connections) socket.destroy();
	await closed;
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function listenForJobLiveness(
	jobDir: string,
	token: string,
): Promise<JobLivenessServer> {
	const path = livenessSocketPath(jobDir);
	const handshake = livenessHandshake(token);
	await assertSocketAbsent(path);
	const connections = new Set<Socket>();
	const controller = new AbortController();
	const server = createServer((socket) => acceptObserver(socket, connections, handshake));
	await listen(server, path);
	try {
		await chmod(path, 0o600);
	} catch (error) {
		await closeServer(server, connections, path);
		throw error;
	}
	let closing = false;
	let closePromise: Promise<void> | undefined;
	server.on("error", (error) => {
		if (!closing) controller.abort(error);
	});
	return {
		signal: controller.signal,
		close() {
			closing = true;
			closePromise ??= closeServer(server, connections, path);
			return closePromise;
		},
	};
}

function monitorSocket(socket: Socket): JobLivenessMonitor {
	const controller = new AbortController();
	let closedByCaller = false;
	let socketError: Error | undefined;
	socket.on("error", (error) => {
		socketError = error;
	});
	socket.once("close", () => {
		if (closedByCaller) return;
		const detail = socketError ? `: ${socketError.message}` : "";
		controller.abort(new JobLivenessError(
			"channel-closed",
			`job liveness channel closed${detail}`,
		));
	});
	socket.resume();
	return {
		signal: controller.signal,
		close() {
			closedByCaller = true;
			socket.destroy();
		},
	};
}

function connectSocket(
	path: string,
	expectedHandshake: string,
	signal?: AbortSignal,
): Promise<JobLivenessMonitor> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path });
		let bytes = Buffer.alloc(0);
		let settled = false;
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			socket.removeListener("data", onData);
			socket.removeListener("error", onError);
			socket.removeListener("close", onClose);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onAbort = () => fail(new Error("job liveness connection aborted"));
		const onError = (error: Error) => fail(error);
		const onClose = () => fail(new Error("job liveness channel closed before handshake"));
		const onData = (chunk: Buffer) => {
			if (chunk.length + bytes.length > JOB_LIVENESS_HANDSHAKE_BYTES_MAX) {
				fail(new JobLivenessError("protocol", "job liveness handshake exceeds limit"));
				return;
			}
			bytes = Buffer.concat([bytes, chunk]);
			if (!bytes.includes(0x0a)) return;
			const handshake = bytes.toString("utf8");
			if (handshake === LIVENESS_BUSY) {
				fail(new JobLivenessError("observer-limit", "job liveness observer limit reached"));
				return;
			}
			if (handshake !== expectedHandshake) {
				fail(new JobLivenessError("protocol", "job liveness identity handshake failed"));
				return;
			}
			settled = true;
			cleanup();
			resolve(monitorSocket(socket));
		};
		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

export async function connectToJobLiveness(
	jobDir: string,
	processId: number,
	token: string,
	signal?: AbortSignal,
): Promise<JobLivenessMonitor> {
	if (!(await processTokenMatches(processId, token))) {
		throw new JobLivenessError("process-missing", "job process identity is not running");
	}
	let monitor: JobLivenessMonitor;
	try {
		monitor = await connectSocket(livenessSocketPath(jobDir), livenessHandshake(token), signal);
	} catch (error) {
		if (error instanceof JobLivenessError) throw error;
		if (signal?.aborted) throw error;
		if (!(await processTokenMatches(processId, token))) {
			throw new JobLivenessError("process-missing", "job process identity is not running");
		}
		throw new JobLivenessError(
			"channel-unavailable",
			`job liveness channel unavailable: ${(error as Error).message}`,
		);
	}
	if (await processTokenMatches(processId, token)) return monitor;
	monitor.close();
	throw new JobLivenessError("process-missing", "job process identity changed while connecting");
}

function isMissingProcessError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ESRCH";
}

export async function processToken(processId: number): Promise<string> {
	if (!Number.isSafeInteger(processId) || processId <= 1) {
		throw new Error("invalid process id");
	}
	const fields = await readLinuxProcessFields(processId);
	const startTicks = fields[19];
	if (!startTicks) throw new Error("cannot read process start identity");
	return `linux:${processId}:${startTicks}`;
}

export async function processIsRunning(processId: number): Promise<boolean> {
	if (!Number.isSafeInteger(processId) || processId <= 1) {
		throw new Error("invalid process id");
	}
	try {
		return (await readLinuxProcessFields(processId))[0] !== "Z";
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		throw error;
	}
}

export async function processTokenMatches(
	processId: number,
	expected: string,
): Promise<boolean> {
	if (!Number.isSafeInteger(processId) || processId <= 1) {
		throw new Error("invalid process id");
	}
	try {
		const fields = await readLinuxProcessFields(processId);
		if (fields[0] === "Z") return false;
		const startTicks = fields[19];
		if (!startTicks) throw new Error("cannot read process start identity");
		return expected === `linux:${processId}:${startTicks}`;
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		throw error;
	}
}

export async function assertProcessGroupLeader(processId: number): Promise<void> {
	const fields = await readLinuxProcessFields(processId);
	const processGroupId = Number(fields[2]);
	if (processGroupId !== processId) throw new Error("job process is not a process-group leader");
}

async function processGroupMembers(processGroupId: number, excludedProcessIds: number[]) {
	const entries = await readdir("/proc", { withFileTypes: true });
	if (entries.length > PROCESS_DIRECTORY_ENTRY_COUNT_MAX) {
		throw new Error("process directory entry limit exceeded");
	}
	const excluded = new Set(excludedProcessIds);
	const members: number[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const processId = Number(entry.name);
		if (processId <= 1 || excluded.has(processId)) continue;
		try {
			const fields = await readLinuxProcessFields(processId);
			if (fields[0] !== "Z" && Number(fields[2]) === processGroupId) members.push(processId);
		} catch (error) {
			if (!isMissingProcessError(error)) throw error;
		}
	}
	return members;
}

async function readProcessMetadata(path: string, buffer: Buffer): Promise<Buffer> {
	const file = await open(path, "r");
	try {
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > PROCESS_METADATA_BYTES_MAX) {
			throw new Error("process metadata exceeds limit");
		}
		return buffer.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}

async function processEnvironmentMarkerIds(
	name: string,
	value: string,
	processGroup?: number,
	excludedProcessIds: number[] = [],
): Promise<number[]> {
	if (!name || name.includes("=") || name.includes("\0") || value.includes("\0")) {
		throw new Error("invalid process environment marker");
	}
	if (!process.getuid) throw new Error("Linux process user identity is unavailable");
	const userId = process.getuid();
	const entries = await readdir("/proc", { withFileTypes: true });
	if (entries.length > PROCESS_DIRECTORY_ENTRY_COUNT_MAX) {
		throw new Error("process directory entry limit exceeded");
	}
	const excluded = new Set(excludedProcessIds);
	const marker = `${name}=${value}`;
	const buffer = Buffer.alloc(PROCESS_METADATA_BYTES_MAX + 1);
	const processIds: number[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const processId = Number(entry.name);
		if (excluded.has(processId)) continue;
		try {
			const fields = await readLinuxProcessFields(processId);
			const inOwnedGroup = processGroup === undefined || Number(fields[2]) === processGroup;
			const status = (
				await readProcessMetadata(`/proc/${entry.name}/status`, buffer)
			).toString();
			const owner = /^Uid:\s+(\d+)/m.exec(status);
			if (!owner || Number(owner[1]) !== userId) continue;
			let environment: Buffer;
			try {
				environment = await readProcessMetadata(`/proc/${entry.name}/environ`, buffer);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				const inaccessible = code === "EACCES" || code === "EPERM";
				if (inaccessible && !inOwnedGroup) continue;
				throw error;
			}
			if (environment.toString().split("\0").includes(marker)) processIds.push(processId);
		} catch (error) {
			if (!isMissingProcessError(error)) throw error;
		}
	}
	return processIds;
}

export async function processEnvironmentMarkerExists(
	name: string,
	value: string,
	processGroup?: number,
): Promise<boolean> {
	return (await processEnvironmentMarkerIds(name, value, processGroup)).length > 0;
}

interface EnvironmentMarkerTerminationOptions {
	excludedProcessIds?: number[];
	ownedProcessGroup?: number;
}

export async function terminateEnvironmentMarkerProcesses(
	name: string,
	value: string,
	options: EnvironmentMarkerTerminationOptions = {},
): Promise<void> {
	for (let pass = 0; pass < PROCESS_GROUP_DRAIN_PASS_COUNT_MAX; pass += 1) {
		const processIds = await processEnvironmentMarkerIds(
			name,
			value,
			options.ownedProcessGroup,
			options.excludedProcessIds,
		);
		if (processIds.length === 0) return;
		for (const processId of processIds) {
			try {
				process.kill(processId, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}
	if ((await processEnvironmentMarkerIds(
		name,
		value,
		options.ownedProcessGroup,
		options.excludedProcessIds,
	)).length > 0) {
		throw new Error("writer owner retained marked descendants after SIGKILL");
	}
}

export async function processGroupId(processId = process.pid): Promise<number> {
	const fields = await readLinuxProcessFields(processId);
	const groupId = Number(fields[2]);
	if (!Number.isSafeInteger(groupId) || groupId <= 1) {
		throw new Error("invalid process group identity");
	}
	return groupId;
}

export async function terminateProcessGroupMembers(
	processGroupId: number,
	excludedProcessIds: number[] = [],
): Promise<void> {
	for (let pass = 0; pass < PROCESS_GROUP_DRAIN_PASS_COUNT_MAX; pass += 1) {
		const members = await processGroupMembers(processGroupId, excludedProcessIds);
		if (members.length === 0) return;
		for (const processId of members) {
			try {
				process.kill(processId, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}
	if ((await processGroupMembers(processGroupId, excludedProcessIds)).length > 0) {
		throw new Error("owned process group retained descendants after SIGKILL");
	}
}

async function readLinuxProcessFields(processId: number): Promise<string[]> {
	const stat = await readFile(`/proc/${processId}/stat`, "utf8");
	const closingParenthesis = stat.lastIndexOf(")");
	if (closingParenthesis < 0) throw new Error("invalid Linux process metadata");
	return stat.slice(closingParenthesis + 2).split(" ");
}
