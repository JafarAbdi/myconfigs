import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { toError } from "../lib/errors.ts";
import { SftpClient } from "./sftp.ts";
import { shellQuote, toDisplayPath } from "./shell.ts";
import { ensureHostSshTool, SSH_TOOL_NAMES, type SshToolName, type SshToolPlatform } from "./tools-cache.ts";

const SSH_ERROR_COMMAND_MAX_LENGTH = 500;
// These deadlines bound states that can remain open without completing: a silent SFTP handshake,
// a stuck cancellation-control session, and the grace period before TERM escalates to KILL.
const TERM_GRACE_MS = 200;
const REMOTE_CONTROL_TIMEOUT_MS = 1000;
const SFTP_HANDSHAKE_TIMEOUT_MS = 15_000;
const SSH_TRANSPORT_ARGS = [
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=10",
	"-o",
	"ServerAliveInterval=15",
	"-o",
	"ServerAliveCountMax=2",
];
const REQUIRED_REMOTE_COMMANDS = ["bash", "setsid"] as const;
const REMOTE_BASH_STDIN_ARGS = ["env", "-u", "BASH_ENV", "bash", "--noprofile", "--norc", "-s"] as const;

interface RemoteRun {
	pidFile: string;
}

function formatStderr(stderr: string): string {
	const trimmed = stderr.trim();
	return trimmed || "<empty>";
}

function formatCommand(command: string): string {
	if (command.length <= SSH_ERROR_COMMAND_MAX_LENGTH) return command;
	return `${command.slice(0, SSH_ERROR_COMMAND_MAX_LENGTH)}...`;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs).unref();
	});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export class SshConnection {
	readonly remote: string;
	remoteCwd = ".";
	remoteHome = "";
	remoteToolCacheDir = "";
	fdPath: string | undefined;
	rgPath: string | undefined;
	fzfPath: string | undefined;

	private closed = false;
	private connecting: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private sftpClient: SftpClient | undefined;
	private sftpChild: ChildProcessWithoutNullStreams | undefined;
	private readonly commandChildren = new Set<ChildProcess>();
	private readonly controlChildren = new Set<ChildProcess>();
	private readonly finishedChildren = new WeakSet<ChildProcess>();
	private readonly activeRuns = new Map<ChildProcess, RemoteRun>();

	constructor(remote: string) {
		this.remote = remote;
	}

	get sftp(): SftpClient {
		if (!this.sftpClient) throw new Error("SSH SFTP connection is not initialized");
		return this.sftpClient;
	}

	connect(onProgress?: (phase: string) => void): Promise<void> {
		if (this.closed) return Promise.reject(new Error("SSH connection is closed"));
		this.connecting ??= this.connectOnce(onProgress);
		return this.connecting;
	}

	private async connectOnce(onProgress?: (phase: string) => void): Promise<void> {
		onProgress?.("connecting");
		const child = this.spawnSftp();
		const stderr: Buffer[] = [];
		child.stderr.on("data", (data: Buffer) => stderr.push(data));
		const sftp = new SftpClient(child.stdout, child.stdin);
		this.sftpChild = child;
		this.sftpClient = sftp;

		try {
			const defaultDirectory = await withDeadline(
				(async () => {
					await sftp.initialize();
					return sftp.realpath(".");
				})(),
				SFTP_HANDSHAKE_TIMEOUT_MS,
				`SSH SFTP connection timed out for ${this.remote}`,
			);
			if (!posix.isAbsolute(defaultDirectory)) {
				throw new Error("SSH SFTP default directory must be an absolute path");
			}
			this.remoteHome = defaultDirectory.replace(/\/+$/u, "") || "/";
			this.remoteCwd = this.remoteHome;
		} catch (error) {
			await this.close();
			const diagnostic = Buffer.concat(stderr).toString("utf8");
			throw new Error(
				`SSH SFTP connection failed for ${this.remote}: ${toError(error).message}\nstderr: ${formatStderr(diagnostic)}`,
				{ cause: error },
			);
		}

		try {
			this.remoteToolCacheDir = this.remoteHomePath(".cache/pi/ssh-tools");
			onProgress?.("checking tools");
			await this.checkPrerequisites();
			await this.bootstrapSearchTools(onProgress);
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	setRemoteCwd(remoteCwd: string): void {
		this.remoteCwd = remoteCwd.replace(/\/+$/u, "") || "/";
	}

	toRemotePath(filePath: string): string {
		const displayPath = toDisplayPath(filePath);
		if (displayPath === "~") return this.remoteHome;
		if (displayPath.startsWith("~/")) return this.remoteHomePath(displayPath.slice(2));
		if (posix.isAbsolute(displayPath)) return displayPath;
		return toDisplayPath(posix.resolve(this.remoteCwd, displayPath));
	}

	async resolveRemoteCwd(input: string): Promise<string> {
		const target = input.trim();
		if (!target) throw new Error("SSH remote cwd must not be empty");
		const remoteCwd = await this.sftp.realpath(this.toRemotePath(target));
		this.setRemoteCwd(remoteCwd);
		return this.remoteCwd;
	}

	exec(command: string, options?: { signal?: AbortSignal }): Promise<Buffer> {
		this.ensureOpen();
		const run = this.createRemoteRun();
		const child = this.spawnRemoteRun(run, command);
		return this.runBufferedSsh(child, run, command, options);
	}

	execStreaming(
		command: string,
		options: {
			onData: (data: Buffer) => void;
			onStderr?: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
		},
	): Promise<{ exitCode: number | null }> {
		this.ensureOpen();
		if (options.signal?.aborted) return Promise.reject(new Error("aborted"));

		const run = this.createRemoteRun();
		const child = this.spawnRemoteRun(run, command);

		return new Promise((resolvePromise, reject) => {
			let timedOut = false;
			let spawnError: Error | undefined;
			let termination: Promise<boolean> | undefined;
			const terminate = () => {
				termination ??= this.terminateRemoteRun(run, child);
			};
			const timer = options.timeout
				? setTimeout(() => {
						timedOut = true;
						terminate();
					}, options.timeout * 1000).unref()
				: undefined;
			options.signal?.addEventListener("abort", terminate, { once: true });

			child.stdout.on("data", options.onData);
			child.stderr.on("data", options.onStderr ?? options.onData);
			child.on("error", (error) => {
				spawnError = error;
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", terminate);
				void (async () => {
					const terminationConfirmed = termination ? await termination : true;
					if (options.signal?.aborted) {
						reject(this.cancellationError("aborted", terminationConfirmed));
					} else if (timedOut) {
						reject(this.cancellationError(`timeout:${options.timeout}`, terminationConfirmed));
					} else if (spawnError) {
						reject(spawnError);
					} else {
						resolvePromise({ exitCode: code });
					}
				})();
			});
		});
	}

	close(): Promise<void> {
		this.closing ??= this.closeOnce();
		return this.closing;
	}

	private async closeOnce(): Promise<void> {
		this.closed = true;
		const sftp = this.sftpClient;
		const sftpChild = this.sftpChild;
		this.sftpClient = undefined;
		this.sftpChild = undefined;
		sftp?.close();

		const runTerminations = [...this.activeRuns].map(([child, run]) => this.terminateRemoteRun(run, child));
		await Promise.all(runTerminations);
		await Promise.all([...this.commandChildren].map((child) => this.stopLocalChild(child)));
		await Promise.all([...this.controlChildren].map((child) => this.stopLocalChild(child)));
		if (sftpChild) await this.stopLocalChild(sftpChild);
	}

	private remoteHomePath(suffix: string): string {
		if (this.remoteHome === "/") return `/${suffix}`;
		return `${this.remoteHome}/${suffix}`;
	}

	private async checkPrerequisites(): Promise<void> {
		const tools = REQUIRED_REMOTE_COMMANDS.map((tool) => shellQuote(tool)).join(" ");
		const command = [
			"missing=",
			`for tool in ${tools}; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done`,
			'test -z "$missing" || { printf "SSH remote is missing required executables:%s\\n" "$missing" >&2; exit 127; }',
		].join("; ");
		await this.runBufferedRawSsh(command);
	}

	private async bootstrapSearchTools(onProgress?: (phase: string) => void): Promise<void> {
		const paths = await this.findRemoteSearchTools();
		const missing = SSH_TOOL_NAMES.filter((tool) => paths[tool] === undefined);
		if (missing.length > 0) {
			const platform = await this.detectRemotePlatform();
			await this.runBufferedRawSsh(`mkdir -p ${shellQuote(this.remoteToolCacheDir)}`);
			for (const tool of missing) {
				paths[tool] = await this.installRemoteSearchTool(tool, platform, onProgress);
			}
		}
		this.fdPath = paths.fd;
		this.rgPath = paths.rg;
		this.fzfPath = paths.fzf;
	}

	private async findRemoteSearchTools(): Promise<Record<SshToolName, string | undefined>> {
		const commands = SSH_TOOL_NAMES.map((tool) => {
			const cachedPath = `${this.remoteToolCacheDir}/${tool}`;
			return [
				`path=$(command -v ${shellQuote(tool)} 2>/dev/null || :)`,
				'if test -n "$path"; then case "$path" in /*) ;; */*) directory=$' +
					"{path%/*}; name=$" +
					'{path##*/}; directory=$(cd -- "$directory" && pwd -P) || exit; path="$directory/$name" ;; *) path="$(pwd -P)/$path" ;; esac; test -x "$path" || path=; fi',
				`if test -z "$path" && test -x ${shellQuote(cachedPath)}; then path=${shellQuote(cachedPath)}; fi`,
				'printf "%s\\0" "$path"',
			].join("; ");
		});
		const output = await this.runBufferedRawSsh(commands.join("; "));
		const fields = new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0");
		if (fields.length !== SSH_TOOL_NAMES.length + 1 || fields.at(-1) !== "") {
			throw new Error("Invalid SSH search-tool lookup response");
		}

		const paths = {
			fd: fields[0] || undefined,
			rg: fields[1] || undefined,
			fzf: fields[2] || undefined,
		} satisfies Record<SshToolName, string | undefined>;
		for (const tool of SSH_TOOL_NAMES) {
			const path = paths[tool];
			if (path && !posix.isAbsolute(path)) throw new Error(`SSH ${tool} path must be absolute`);
		}
		return paths;
	}

	private async detectRemotePlatform(): Promise<SshToolPlatform> {
		const output = await this.runBufferedRawSsh('printf "%s\\0%s\\0" "$(uname -s)" "$(uname -m)"');
		const fields = new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0");
		if (fields.length !== 3 || fields[2] !== "") throw new Error("Invalid SSH platform response");
		const [system, architecture] = fields;
		if (system !== "Linux") throw new Error(`Unsupported SSH tool platform: ${system || "unknown"}`);
		switch (architecture) {
			case "x86_64":
			case "amd64":
				return "linux_amd64";
			case "aarch64":
			case "arm64":
				return "linux_arm64";
			default:
				throw new Error(`Unsupported SSH tool architecture: ${architecture || "unknown"}`);
		}
	}

	private async installRemoteSearchTool(
		tool: SshToolName,
		platform: SshToolPlatform,
		onProgress?: (phase: string) => void,
	): Promise<string> {
		const hostPath = await ensureHostSshTool(tool, platform, () => onProgress?.(`downloading ${tool}`));
		onProgress?.(`uploading ${tool}`);
		const remotePath = `${this.remoteToolCacheDir}/${tool}`;
		const temporaryPath = `${this.remoteToolCacheDir}/.${tool}-${randomUUID()}.tmp`;
		try {
			await this.sftp.writeFile(temporaryPath, await readFile(hostPath));
			await this.runBufferedRawSsh(
				`chmod 755 ${shellQuote(temporaryPath)} && mv -f ${shellQuote(temporaryPath)} ${shellQuote(remotePath)}`,
			);
		} catch (operationError) {
			try {
				await this.runBufferedRawSsh(`rm -f ${shellQuote(temporaryPath)}`);
			} catch (cleanupError) {
				throw new AggregateError(
					[operationError, cleanupError],
					`SSH ${tool} upload and cleanup failed on ${this.remote}`,
					{ cause: operationError },
				);
			}
			throw operationError;
		}
		return remotePath;
	}

	requireFdPath(): string {
		if (!this.fdPath) throw new Error("SSH fd path is not initialized");
		return this.fdPath;
	}

	requireRgPath(): string {
		if (!this.rgPath) throw new Error("SSH rg path is not initialized");
		return this.rgPath;
	}

	requireFzfPath(): string {
		if (!this.fzfPath) throw new Error("SSH fzf path is not initialized");
		return this.fzfPath;
	}

	private ensureOpen(): void {
		if (this.closed) throw new Error("SSH connection is closed");
	}

	private createRemoteRun(): RemoteRun {
		return { pidFile: `/tmp/pi-ssh-${randomUUID()}.pid` };
	}

	private spawnRemoteRun(run: RemoteRun, command: string): ChildProcessWithoutNullStreams {
		const child = this.spawnCommandSsh([this.remote, ...REMOTE_BASH_STDIN_ARGS]);
		this.writeScript(child, this.buildRemoteRunCommand(run, command));
		this.activeRuns.set(child, run);
		const cleanup = () => this.activeRuns.delete(child);
		child.once("close", cleanup);
		child.once("error", cleanup);
		return child;
	}

	private buildRemoteRunCommand(run: RemoteRun, command: string): string {
		const cleanup = `rm -f ${shellQuote(run.pidFile)}`;
		// A trapped TERM interrupts bash's wait; wait again so the pidfile remains usable until
		// the command exits or cancellation escalates to KILL.
		const wrapper = [
			`printf '%s\\n' "$$" > ${shellQuote(run.pidFile)}`,
			`trap ${shellQuote(cleanup)} EXIT`,
			"term_received=0",
			`trap ${shellQuote("term_received=1")} TERM`,
			'env -u BASH_ENV bash --noprofile --norc -c "$1" <&0 & command_pid=$!',
			'while :; do term_received=0; wait "$command_pid"; exit_code=$?; test "$term_received" -eq 1 || break; done',
			cleanup,
			'exit "$exit_code"',
		].join("; ");
		return `exec setsid env -u BASH_ENV bash --noprofile --norc -c ${shellQuote(wrapper)} _ ${shellQuote(command)}`;
	}

	private async terminateRemoteRun(run: RemoteRun, child: ChildProcess): Promise<boolean> {
		const termSent = await this.signalRemoteRun(run, "TERM");
		if (!termSent) {
			await this.stopLocalChild(child);
			await this.cleanupRemoteRun(run);
			return false;
		}
		if (await this.waitForChildCloseDuringGrace(child)) {
			await this.cleanupRemoteRun(run);
			return true;
		}

		const killSent = await this.signalRemoteRun(run, "KILL");
		await this.stopLocalChild(child);
		await this.cleanupRemoteRun(run);
		return killSent;
	}

	private signalRemoteRun(run: RemoteRun, signal: "TERM" | "KILL"): Promise<boolean> {
		const command = [
			`test -r ${shellQuote(run.pidFile)} || exit 1`,
			`pid=$(cat ${shellQuote(run.pidFile)}) || exit 1`,
			`case "$pid" in ''|*[!0-9]*) exit 1;; esac`,
			`test "$pid" -gt 1 || exit 1`,
			`kill -${signal} -- "-$pid"`,
		].join("; ");
		return this.execRemoteRunControl(command);
	}

	private cleanupRemoteRun(run: RemoteRun): Promise<boolean> {
		return this.execRemoteRunControl(`rm -f ${shellQuote(run.pidFile)}`);
	}

	private execRemoteRunControl(command: string): Promise<boolean> {
		const child = this.spawnControlSsh([this.remote, ...REMOTE_BASH_STDIN_ARGS]);
		this.writeScript(child, command);
		return new Promise((resolvePromise) => {
			let settled = false;
			let timedOut = false;
			const settle = (success: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolvePromise(success);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				void this.stopLocalChild(child);
			}, REMOTE_CONTROL_TIMEOUT_MS).unref();
			child.once("error", () => settle(false));
			child.once("close", (code) => settle(!timedOut && code === 0));
		});
	}

	private cancellationError(reason: string, terminationConfirmed: boolean): Error {
		return new Error(terminationConfirmed ? reason : `${reason}; remote termination was not confirmed`);
	}

	private writeScript(child: ChildProcessWithoutNullStreams, script: string): void {
		child.stdin.on("error", () => {});
		child.stdin.end(script, "utf8");
	}

	private runBufferedSsh(
		child: ChildProcessWithoutNullStreams,
		run: RemoteRun,
		command: string,
		options?: { signal?: AbortSignal },
	): Promise<Buffer> {
		if (options?.signal?.aborted) {
			return this.terminateRemoteRun(run, child).then((confirmed) => {
				throw this.cancellationError("aborted", confirmed);
			});
		}

		return new Promise((resolvePromise, reject) => {
			const chunks: Buffer[] = [];
			const stderr: Buffer[] = [];
			let spawnError: Error | undefined;
			let termination: Promise<boolean> | undefined;
			const terminate = () => {
				termination ??= this.terminateRemoteRun(run, child);
			};
			options?.signal?.addEventListener("abort", terminate, { once: true });

			child.stdout.on("data", (data: Buffer) => chunks.push(data));
			child.stderr.on("data", (data: Buffer) => stderr.push(data));
			child.on("error", (error) => {
				spawnError = error;
			});
			child.on("close", (code) => {
				options?.signal?.removeEventListener("abort", terminate);
				void (async () => {
					const terminationConfirmed = termination ? await termination : true;
					if (options?.signal?.aborted) {
						reject(this.cancellationError("aborted", terminationConfirmed));
					} else if (spawnError) {
						reject(spawnError);
					} else if (code !== 0) {
						const stderrText = Buffer.concat(stderr).toString("utf8");
						const commandText = formatCommand(command);
						if (code === 255) {
							reject(new Error(`SSH transport failed for ${this.remote}: ${formatStderr(stderrText)}`));
						} else {
							reject(
								new Error(
									`Remote command failed on ${this.remote} (exit ${code}): ${commandText}\nstderr: ${formatStderr(
										stderrText,
									)}`,
								),
							);
						}
					} else {
						resolvePromise(Buffer.concat(chunks));
					}
				})();
			});
		});
	}

	private runBufferedRawSsh(command: string): Promise<Buffer> {
		const child = this.spawnCommandSsh([this.remote, ...REMOTE_BASH_STDIN_ARGS]);
		this.writeScript(child, command);
		return new Promise((resolvePromise, reject) => {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let spawnError: Error | undefined;
			child.stdout.on("data", (data: Buffer) => stdout.push(data));
			child.stderr.on("data", (data: Buffer) => stderr.push(data));
			child.on("error", (error) => {
				spawnError = error;
			});
			child.on("close", (code) => {
				if (spawnError) reject(spawnError);
				else if (code !== 0) {
					reject(
						new Error(
							`Remote prerequisite check failed on ${this.remote} (exit ${code}): ${formatStderr(
								Buffer.concat(stderr).toString("utf8"),
							)}`,
						),
					);
				} else resolvePromise(Buffer.concat(stdout));
			});
		});
	}

	private trackChild<T extends ChildProcess>(child: T, children: Set<ChildProcess>): T {
		children.add(child);
		const cleanup = () => {
			this.finishedChildren.add(child);
			children.delete(child);
		};
		child.once("close", cleanup);
		child.once("error", cleanup);
		return child;
	}

	private waitForChildClose(child: ChildProcess): Promise<void> {
		if (this.isChildFinished(child)) return Promise.resolve();
		return new Promise((resolvePromise) => {
			const finish = () => {
				child.removeListener("close", finish);
				child.removeListener("error", finish);
				resolvePromise();
			};
			child.once("close", finish);
			child.once("error", finish);
		});
	}

	private waitForChildCloseDuringGrace(child: ChildProcess): Promise<boolean> {
		if (this.isChildFinished(child)) return Promise.resolve(true);
		return new Promise((resolvePromise) => {
			const finish = (closed: boolean) => {
				clearTimeout(timer);
				child.removeListener("close", onClose);
				child.removeListener("error", onError);
				resolvePromise(closed);
			};
			const onClose = () => finish(true);
			const onError = () => finish(true);
			const timer = setTimeout(() => finish(false), TERM_GRACE_MS).unref();
			child.once("close", onClose);
			child.once("error", onError);
		});
	}

	private async stopLocalChild(child: ChildProcess): Promise<void> {
		if (this.isChildFinished(child)) return;
		child.kill("SIGTERM");
		if (await this.waitForChildCloseDuringGrace(child)) return;
		child.kill("SIGKILL");
		await this.waitForChildClose(child);
	}

	private isChildFinished(child: ChildProcess): boolean {
		return this.finishedChildren.has(child) || child.exitCode !== null || child.signalCode !== null;
	}

	private spawnSftp(): ChildProcessWithoutNullStreams {
		const child = spawn("ssh", [...SSH_TRANSPORT_ARGS, "-s", this.remote, "sftp"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const finish = () => this.finishedChildren.add(child);
		child.once("close", finish);
		child.once("error", finish);
		return child;
	}

	private spawnCommandSsh(args: string[]): ChildProcessWithoutNullStreams {
		return this.trackChild(
			spawn("ssh", [...SSH_TRANSPORT_ARGS, ...args], {
				stdio: ["pipe", "pipe", "pipe"],
			}),
			this.commandChildren,
		);
	}

	private spawnControlSsh(args: string[]): ChildProcessWithoutNullStreams {
		return this.trackChild(
			spawn("ssh", [...SSH_TRANSPORT_ARGS, ...args], { stdio: ["pipe", "pipe", "pipe"] }),
			this.controlChildren,
		);
	}
}
