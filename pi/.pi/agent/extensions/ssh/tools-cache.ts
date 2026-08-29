import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { toError } from "../lib/errors.ts";
import { runCommand } from "../lib/proc.ts";

export const SSH_TOOL_NAMES = ["fd", "rg", "fzf"] as const;
export type SshToolName = (typeof SSH_TOOL_NAMES)[number];
export type SshToolPlatform = "linux_amd64" | "linux_arm64";

interface ToolArchive {
	url: string;
	binaryPath: string;
}

const TOOL_VERSIONS = {
	fd: "10.4.2",
	rg: "15.2.0",
	fzf: "0.73.1",
} satisfies Record<SshToolName, string>;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function toolArchive(tool: SshToolName, platform: SshToolPlatform): ToolArchive {
	const version = TOOL_VERSIONS[tool];
	const architecture = platform === "linux_amd64" ? "x86_64" : "aarch64";
	switch (tool) {
		case "fd": {
			const name = `fd-v${version}-${architecture}-unknown-linux-musl`;
			return {
				url: `https://github.com/sharkdp/fd/releases/download/v${version}/${name}.tar.gz`,
				binaryPath: `${name}/fd`,
			};
		}
		case "rg": {
			const name = `ripgrep-${version}-${architecture}-unknown-linux-musl`;
			return {
				url: `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${name}.tar.gz`,
				binaryPath: `${name}/rg`,
			};
		}
		case "fzf": {
			const name = `fzf-${version}-${platform}`;
			return {
				url: `https://github.com/junegunn/fzf/releases/download/v${version}/${name}.tar.gz`,
				binaryPath: "fzf",
			};
		}
	}
}

function hostToolPath(tool: SshToolName, platform: SshToolPlatform): string {
	return join(homedir(), ".cache", "pi", "ssh-tools", platform, tool);
}

async function executableExists(path: string): Promise<boolean> {
	const attrs = await stat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!attrs) return false;
	if (!attrs.isFile()) throw new Error(`SSH tool cache path is not a file: ${path}`);
	try {
		await access(path, constants.X_OK);
	} catch (error) {
		throw new Error(`SSH tool cache path is not executable: ${path}`, { cause: error });
	}
	return true;
}

async function download(url: string, path: string): Promise<void> {
	const response = await fetch(url, {
		headers: { "User-Agent": "pi-ssh-tools" },
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`SSH tool download failed (${response.status}): ${url}`);
	await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

async function removeTemporaryDirectory(path: string, operationError?: Error): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch (error) {
		const cleanupError = toError(error);
		if (operationError !== undefined) {
			throw new AggregateError([operationError, cleanupError], `SSH tool install and cleanup failed for ${path}`, {
				cause: operationError,
			});
		}
		throw cleanupError;
	}
}

export async function ensureHostSshTool(
	tool: SshToolName,
	platform: SshToolPlatform,
	onDownload?: () => void,
): Promise<string> {
	const target = hostToolPath(tool, platform);
	if (await executableExists(target)) return target;

	const cacheDirectory = join(homedir(), ".cache", "pi", "ssh-tools", platform);
	await mkdir(cacheDirectory, { recursive: true });
	if (await executableExists(target)) return target;

	const archive = toolArchive(tool, platform);
	const temporaryDirectory = await mkdtemp(join(cacheDirectory, `.${tool}-`));
	let operationError: Error | undefined;
	try {
		const archivePath = join(temporaryDirectory, "archive.tar.gz");
		onDownload?.();
		await download(archive.url, archivePath);
		await runCommand("tar", ["xzf", archivePath, "-C", temporaryDirectory, archive.binaryPath]);
		const extractedPath = join(temporaryDirectory, archive.binaryPath);
		await chmod(extractedPath, 0o755);
		await rename(extractedPath, target);
		return target;
	} catch (error) {
		operationError = toError(error);
		throw operationError;
	} finally {
		await removeTemporaryDirectory(temporaryDirectory, operationError);
	}
}
