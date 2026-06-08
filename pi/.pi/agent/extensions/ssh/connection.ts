import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { SSH_CONTROL_DIR, SSH_CONTROL_PATH } from "./constants.ts";
import {
	ensureLocalPythonUvCommands,
	type LocalPythonUvCommands,
	PYTHON_UV_COMMAND_NAMES,
} from "./python-uv-commands.ts";
import { shellQuote, toDisplayPath } from "./shell.ts";
import {
	ensureLocalSshTools,
	type LocalSshToolsCache,
	SSH_TOOL_NAMES,
	type SshToolName,
	type SshToolPlatform,
} from "./tools-cache.ts";

const SSH_ERROR_COMMAND_MAX_LENGTH = 500;

function formatStderr(stderr: string): string {
	const trimmed = stderr.trim();
	return trimmed || "<empty>";
}

function formatCommand(command: string): string {
	if (command.length <= SSH_ERROR_COMMAND_MAX_LENGTH) return command;
	return `${command.slice(0, SSH_ERROR_COMMAND_MAX_LENGTH)}...`;
}

export class SshConnection {
	readonly remote: string;
	readonly localCwd: string;
	remoteCwd = ".";
	remoteHome = "~";
	fdPath: string | undefined;
	rgPath: string | undefined;
	fzfPath: string | undefined;
	remoteToolBinDir: string | undefined;
	remotePythonUvCommandsBinDir: string | undefined;
	remoteUvBinDir: string | undefined;

	private sshOptions: string[] = [];
	private closed = false;

	constructor(remote: string, localCwd: string) {
		this.remote = remote;
		this.localCwd = resolve(localCwd);
	}

	async connect(): Promise<void> {
		try {
			await mkdir(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
			this.sshOptions = [
				"-o",
				"ControlMaster=auto",
				"-o",
				"ControlPersist=yes",
				"-o",
				`ControlPath=${SSH_CONTROL_PATH}`,
			];
			await this.runControlCommand([...this.sshOptions, this.remote, "true"]);
			this.remoteHome = (await this.exec('printf "%s" "$HOME"')).toString("utf8").trim() || "~";
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	setRemoteCwd(remoteCwd: string): void {
		this.remoteCwd = remoteCwd.replace(/\/+$/, "") || "/";
	}

	toRemotePath(filePath: string): string {
		const displayPath = toDisplayPath(filePath);
		if (displayPath === "~") return this.remoteHome;
		if (displayPath.startsWith("~/")) return `${this.remoteHome}/${displayPath.slice(2)}`;
		if (isAbsolute(displayPath)) return displayPath;
		return toDisplayPath(resolve(this.remoteCwd, displayPath));
	}

	async changeRemoteCwd(input: string): Promise<string> {
		const target = input.trim();
		if (!target) {
			throw new Error("Usage: /ssh-cd <remote-directory>");
		}
		const nextRemoteCwd = (await this.exec(this.buildChangeDirectoryCommand(target))).toString("utf8").trim();
		this.setRemoteCwd(nextRemoteCwd);
		return this.remoteCwd;
	}

	async bootstrapTools(onStatus?: (status: string) => void): Promise<void> {
		onStatus?.("checking tools");
		const probed = {} as Record<SshToolName, string | undefined>;
		for (const tool of SSH_TOOL_NAMES) {
			probed[tool] = await this.findRemoteTool(tool);
		}
		const missingTools = SSH_TOOL_NAMES.filter((tool) => !probed[tool]);

		const resolved = { ...probed } as Record<SshToolName, string>;
		if (missingTools.length > 0) {
			const platform = await this.detectRemotePlatform();
			onStatus?.("caching tools");
			const cache = await ensureLocalSshTools();
			onStatus?.(`installing tools for ${platform}`);
			const installed = await this.installRemoteTools(cache, platform, missingTools);
			this.remoteToolBinDir = installed.binDir;
			for (const tool of missingTools) {
				resolved[tool] = installed.paths[tool];
			}
			for (const tool of missingTools) {
				await this.verifyRemoteTool(tool, resolved[tool]);
			}
		}

		this.fdPath = resolved.fd;
		this.rgPath = resolved.rg;
		this.fzfPath = resolved.fzf;
		await this.bootstrapPythonUvCommands(onStatus);
	}

	requireFdPath(): string {
		if (!this.fdPath) {
			throw new Error("remote fd is not initialized");
		}
		return this.fdPath;
	}

	requireRgPath(): string {
		if (!this.rgPath) {
			throw new Error("remote rg is not initialized");
		}
		return this.rgPath;
	}

	requireFzfPath(): string {
		if (!this.fzfPath) {
			throw new Error("remote fzf is not initialized");
		}
		return this.fzfPath;
	}

	exec(command: string, options?: { signal?: AbortSignal }): Promise<Buffer> {
		const args = [...this.sshOptions, this.remote, this.buildBashCommand(command)];
		return this.runBufferedSsh(args, command, options);
	}

	execStreaming(
		command: string,
		options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
	): Promise<{ exitCode: number | null }> {
		return new Promise((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}

			const child = this.spawnRemoteCommand(command);
			child.stdin.end();
			let timedOut = false;
			const timer = options.timeout
				? setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeout * 1000)
				: undefined;
			const onAbort = () => child.kill();
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout.on("data", options.onData);
			child.stderr.on("data", options.onData);
			child.on("error", (error) => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(error);
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				if (options.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
				else resolve({ exitCode: code });
			});
		});
	}

	spawnRemoteCommand(command: string): ChildProcessWithoutNullStreams {
		return spawn("ssh", [...this.sshOptions, this.remote, this.buildBashCommand(command)], {
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	spawnRemoteTool(commandPath: string, args: string[]): ChildProcessWithoutNullStreams {
		const child = this.spawnRemoteCommand([shellQuote(commandPath), ...args.map(shellQuote)].join(" "));
		child.stdin.end();
		return child;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
	}

	private async detectRemotePlatform(): Promise<SshToolPlatform> {
		const output = (await this.exec("uname -s && uname -m")).toString("utf8").trim().split("\n");
		const system = output[0]?.trim();
		const arch = output[1]?.trim();
		if (system !== "Linux") {
			throw new Error(`Unsupported SSH tool platform: ${system || "unknown"}/${arch || "unknown"}`);
		}
		if (arch === "x86_64" || arch === "amd64") return "linux_amd64";
		if (arch === "aarch64" || arch === "arm64") return "linux_arm64";
		throw new Error(`Unsupported SSH tool architecture: ${arch || "unknown"}`);
	}

	private async findRemoteTool(tool: SshToolName): Promise<string | undefined> {
		const output = (await this.exec(`command -v ${tool} 2>/dev/null || true`)).toString("utf8").trim();
		return output ? output.split("\n")[0]?.trim() : undefined;
	}

	private async installRemoteTools(
		cache: LocalSshToolsCache,
		platform: SshToolPlatform,
		tools: SshToolName[],
	): Promise<{ binDir: string; paths: Record<SshToolName, string> }> {
		const cacheHome = (await this.exec('printf "%s\\n" "$HOME/.cache"')).toString("utf8").trim();
		const rootDir = `${cacheHome}/pi/ssh-tools/search-tools/${cache.cacheKey}/${platform}`;
		const binDir = `${rootDir}/bin`;
		const remoteArchivePath = `${rootDir}/${platform}.tar.gz`;
		await this.exec(`mkdir -p ${shellQuote(binDir)}`);
		await this.uploadFile(cache.platforms[platform].archivePath, remoteArchivePath);
		const entries = tools.map((tool) => shellQuote(`bin/${tool}`)).join(" ");
		const chmodPaths = tools.map((tool) => shellQuote(`${binDir}/${tool}`)).join(" ");
		await this.exec(
			[
				`tar xzf ${shellQuote(remoteArchivePath)} -C ${shellQuote(rootDir)} ${entries}`,
				`chmod 755 ${chmodPaths}`,
				`rm -f ${shellQuote(remoteArchivePath)}`,
			].join(" && "),
		);
		const paths = {} as Record<SshToolName, string>;
		for (const tool of tools) {
			paths[tool] = `${binDir}/${tool}`;
		}
		return { binDir, paths };
	}

	private async bootstrapPythonUvCommands(onStatus?: (status: string) => void): Promise<void> {
		const uvPath = await this.findRemoteUv();
		if (!uvPath) return;

		onStatus?.("caching python uv commands");
		const commands = await ensureLocalPythonUvCommands();
		onStatus?.("installing python uv commands");
		const installed = await this.installPythonUvCommands(commands);
		this.remotePythonUvCommandsBinDir = installed.binDir;
		this.remoteUvBinDir = dirname(uvPath);
	}

	private async findRemoteUv(): Promise<string | undefined> {
		const command = [
			"command -v uv 2>/dev/null",
			'test -x "$HOME/.local/bin/uv" && printf "%s\\n" "$HOME/.local/bin/uv"',
			'test -x "$HOME/.cargo/bin/uv" && printf "%s\\n" "$HOME/.cargo/bin/uv"',
		].join(" || ");
		const output = (await this.exec(`${command} || true`)).toString("utf8").trim();
		return output ? output.split("\n")[0]?.trim() : undefined;
	}

	private async installPythonUvCommands(commands: LocalPythonUvCommands): Promise<{ binDir: string }> {
		const cacheHome = (await this.exec('printf "%s\\n" "$HOME/.cache"')).toString("utf8").trim();
		const rootDir = `${cacheHome}/pi/ssh-tools/python-uv-commands`;
		const binDir = `${rootDir}/bin`;
		const remoteArchivePath = `${rootDir}/python-uv-commands.tar.gz`;
		await this.exec(`mkdir -p ${shellQuote(rootDir)}`);
		await this.uploadFile(commands.archivePath, remoteArchivePath);
		const chmodPaths = PYTHON_UV_COMMAND_NAMES.map((name) => shellQuote(`${binDir}/${name}`)).join(" ");
		await this.exec(
			[
				`tar xzf ${shellQuote(remoteArchivePath)} -C ${shellQuote(rootDir)}`,
				`chmod 755 ${chmodPaths}`,
				`rm -f ${shellQuote(remoteArchivePath)}`,
			].join(" && "),
		);
		return { binDir };
	}

	private async verifyRemoteTool(tool: SshToolName, commandPath: string): Promise<void> {
		await this.exec(`${shellQuote(commandPath)} --version >/dev/null 2>&1`, {}).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to verify remote ${tool}: ${message}`);
		});
	}

	private uploadFile(localPath: string, remotePath: string): Promise<void> {
		const child = this.spawnRemoteCommand(`cat > ${shellQuote(remotePath)}`);
		return new Promise((resolvePromise, reject) => {
			let settled = false;
			const stderr: Buffer[] = [];
			const input = createReadStream(localPath);
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				child.kill();
				input.destroy();
				reject(error);
			};

			child.stderr.on("data", (data) => stderr.push(data));
			child.on("error", fail);
			input.on("error", fail);
			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				if (code === 0) {
					resolvePromise();
					return;
				}
				reject(new Error(`SSH upload failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
			});
			input.pipe(child.stdin);
		});
	}

	private buildBashCommand(command: string): string {
		return `env -u BASH_ENV bash --noprofile --norc -c ${shellQuote(command)}`;
	}

	private buildChangeDirectoryCommand(target: string): string {
		let cdTarget: string;
		if (target === "~") {
			cdTarget = "";
		} else if (target === "~/") {
			cdTarget = "";
		} else if (target.startsWith("~/")) {
			cdTarget = `"$HOME"/${shellQuote(target.slice(2))}`;
		} else {
			cdTarget = shellQuote(target);
		}
		const changeDirectory = cdTarget ? `cd ${cdTarget}` : "cd";
		return `cd ${shellQuote(this.remoteCwd)} && ${changeDirectory} && pwd -P`;
	}

	private runControlCommand(args: string[]): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
			const errChunks: Buffer[] = [];
			child.stderr.on("data", (data) => errChunks.push(data));
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					const stderr = Buffer.concat(errChunks).toString("utf8");
					const message = `SSH control connection failed for ${this.remote} (exit ${code})`;
					reject(new Error(`${message}: ${formatStderr(stderr)}`));
				}
			});
		});
	}

	private runBufferedSsh(
		args: string[],
		command: string,
		options?: { signal?: AbortSignal },
	): Promise<Buffer> {
		return new Promise((resolvePromise, reject) => {
			if (options?.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}

			const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
			const chunks: Buffer[] = [];
			const errChunks: Buffer[] = [];
			const onAbort = () => child.kill();
			options?.signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout.on("data", (data) => chunks.push(data));
			child.stderr.on("data", (data) => errChunks.push(data));
			child.on("error", (error) => {
				options?.signal?.removeEventListener("abort", onAbort);
				reject(error);
			});
			child.on("close", (code) => {
				options?.signal?.removeEventListener("abort", onAbort);
				if (options?.signal?.aborted) {
					reject(new Error("aborted"));
				} else if (code !== 0) {
					const stderr = Buffer.concat(errChunks).toString("utf8");
					const commandText = formatCommand(command);
					if (code === 255) {
						reject(new Error(`SSH transport failed for ${this.remote}: ${formatStderr(stderr)}`));
					} else {
						const message = `Remote command failed on ${this.remote} (exit ${code})`;
						reject(new Error(`${message}: ${commandText}\nstderr: ${formatStderr(stderr)}`));
					}
				} else {
					resolvePromise(Buffer.concat(chunks));
				}
			});
		});
	}
}
