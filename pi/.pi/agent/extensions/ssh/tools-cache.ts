import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../lib/proc.ts";

export const SSH_TOOL_PLATFORMS = ["linux_amd64", "linux_arm64"] as const;
export type SshToolPlatform = (typeof SSH_TOOL_PLATFORMS)[number];
export const SSH_TOOL_NAMES = ["fd", "rg", "fzf"] as const;
export type SshToolName = (typeof SSH_TOOL_NAMES)[number];

interface ToolConfig {
	repo: string;
	binaryName: string;
	tagPrefix: string;
	assetNames: (version: string, platform: SshToolPlatform) => string[];
}

interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface GitHubRelease {
	tag_name: string;
	assets: GitHubReleaseAsset[];
}

// Pinned so every remote gets the same binary, unlike pi's own local tool download (which always
// takes GitHub's latest, fine for a single machine with no cross-host consistency need). Bumping
// a version here only affects the next tool that isn't already cached — see ensureLocalSshTool.
const DEFAULT_SSH_TOOL_VERSIONS: Record<SshToolName, string> = {
	fd: "10.4.2",
	rg: "15.1.0",
	fzf: "0.73.1",
};

const TOOL_CONFIGS: Record<SshToolName, ToolConfig> = {
	fd: {
		repo: "sharkdp/fd",
		binaryName: "fd",
		tagPrefix: "v",
		assetNames(version, platform) {
			const arch = platform === "linux_arm64" ? "aarch64" : "x86_64";
			return [`fd-v${version}-${arch}-unknown-linux-musl.tar.gz`, `fd-v${version}-${arch}-unknown-linux-gnu.tar.gz`];
		},
	},
	rg: {
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		assetNames(version, platform) {
			const arch = platform === "linux_arm64" ? "aarch64" : "x86_64";
			return [
				`ripgrep-${version}-${arch}-unknown-linux-musl.tar.gz`,
				`ripgrep-${version}-${arch}-unknown-linux-gnu.tar.gz`,
			];
		},
	},
	fzf: {
		repo: "junegunn/fzf",
		binaryName: "fzf",
		tagPrefix: "v",
		assetNames(version, platform) {
			return [`fzf-${version}-${platform}.tar.gz`];
		},
	},
};

const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DIRECTORY_SCAN_LIMIT = 10_000;

function sshToolsCacheDir(platform: SshToolPlatform): string {
	return join(homedir(), ".cache", "pi", "ssh-tools", "search-tools", platform);
}

function localToolPath(tool: SshToolName, platform: SshToolPlatform): string {
	return join(sshToolsCacheDir(platform), tool);
}

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		throw error;
	}
}

function githubAuthHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
	const response = await fetch(url, {
		headers: { "User-Agent": "pi-ssh-tools", ...githubAuthHeaders() },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		const rateLimited = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
		const hint = rateLimited ? " (GitHub API rate limit hit; set GITHUB_TOKEN to raise it)" : "";
		throw new Error(`GitHub request failed (${response.status}): ${url}${hint}`);
	}
	return (await response.json()) as T;
}

async function selectReleaseAsset(
	tool: SshToolName,
	version: string,
	platform: SshToolPlatform,
): Promise<GitHubReleaseAsset> {
	const config = TOOL_CONFIGS[tool];
	const tag = `${config.tagPrefix}${version}`;
	const release = await fetchJson<GitHubRelease>(
		`https://api.github.com/repos/${config.repo}/releases/tags/${tag}`,
		NETWORK_TIMEOUT_MS,
	);
	const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
	for (const assetName of config.assetNames(version, platform)) {
		const asset = byName.get(assetName);
		if (asset) return asset;
	}
	throw new Error(`No ${tool} ${version} release asset for ${platform}`);
}

async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`Download failed (${response.status}): ${url}`);
	}
	await writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

async function findBinary(rootDir: string, binaryName: string): Promise<string> {
	const stack: string[] = [rootDir];
	let scanned = 0;
	while (stack.length > 0) {
		scanned += 1;
		if (scanned > DIRECTORY_SCAN_LIMIT) {
			throw new Error(`Archive contains too many entries while looking for ${binaryName}`);
		}

		const currentDir = stack.pop();
		if (!currentDir) continue;
		for (const entry of await readdir(currentDir, { withFileTypes: true })) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryName) return fullPath;
			if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	throw new Error(`Binary not found in archive: ${binaryName}`);
}

// Download straight to a uniquely-named tmp dir and rename just the one binary out of it — same
// shape as pi's own utils/tools-manager.ts. The final rename is a single-file, same-filesystem
// move (atomic), and the tmp dir is always removed in `finally`, so nothing extraction-related
// (docs, licenses, the raw archive) can ever leak into the cache directory.
async function installLocalTool(tool: SshToolName, platform: SshToolPlatform): Promise<string> {
	const version = DEFAULT_SSH_TOOL_VERSIONS[tool];
	const asset = await selectReleaseAsset(tool, version, platform);
	const cacheDir = sshToolsCacheDir(platform);
	await mkdir(cacheDir, { recursive: true });
	const targetBinary = localToolPath(tool, platform);

	const tmpDir = join(cacheDir, `.tmp-${tool}-${process.pid}-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });
	try {
		const archivePath = join(tmpDir, asset.name);
		await downloadFile(asset.browser_download_url, archivePath);
		await runCommand("tar", ["xzf", archivePath, "-C", tmpDir]);
		const extractedBinary = await findBinary(tmpDir, TOOL_CONFIGS[tool].binaryName);
		await rename(extractedBinary, targetBinary);
		await chmod(targetBinary, 0o755);
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
	return targetBinary;
}

export async function ensureLocalSshTool(tool: SshToolName, platform: SshToolPlatform): Promise<string> {
	const targetBinary = localToolPath(tool, platform);
	if (await pathExists(targetBinary)) return targetBinary;
	if (isOfflineModeEnabled()) {
		throw new Error(`SSH tool cache is missing ${tool} for ${platform} and PI_OFFLINE is enabled: ${targetBinary}`);
	}
	return installLocalTool(tool, platform);
}
