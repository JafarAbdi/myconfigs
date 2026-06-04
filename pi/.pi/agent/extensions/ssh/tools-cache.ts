import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SSH_TOOL_PLATFORMS = ["linux_amd64", "linux_arm64"] as const;
export type SshToolPlatform = (typeof SSH_TOOL_PLATFORMS)[number];
export type SshToolName = "fd" | "rg";

export interface SshToolVersions {
	fd: string;
	rg: string;
}

export interface LocalSshToolsPlatformCache {
	archivePath: string;
	binDir: string;
	tools: Record<SshToolName, string>;
}

export interface LocalSshToolsCache {
	cacheKey: string;
	rootDir: string;
	versions: SshToolVersions;
	platforms: Record<SshToolPlatform, LocalSshToolsPlatformCache>;
}

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

interface ToolManifestEntry {
	assetName: string;
	assetUrl: string;
	sha256: string;
}

interface PlatformManifestEntry {
	archivePath: string;
	archiveSha256: string;
	tools: Record<SshToolName, ToolManifestEntry>;
}

interface SshToolsManifest {
	cacheKey: string;
	versions: SshToolVersions;
	platforms: Record<SshToolPlatform, PlatformManifestEntry>;
}

interface ActiveSshToolsCache {
	cacheKey: string;
	versions: SshToolVersions;
	updatedAt: string;
}

const DEFAULT_SSH_TOOL_VERSIONS: SshToolVersions = {
	fd: "10.4.2",
	rg: "15.1.0",
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
};

const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DIRECTORY_SCAN_LIMIT = 10_000;

const releaseAssets = new Map<string, Promise<GitHubReleaseAsset[]>>();

function sshToolsCacheRoot(): string {
	return join(homedir(), ".cache", "pi", "ssh-tools", "search-tools");
}

function cacheKey(versions: SshToolVersions): string {
	return `fd-${versions.fd}-rg-${versions.rg}`;
}

function versionForTool(versions: SshToolVersions, tool: SshToolName): string {
	return tool === "fd" ? versions.fd : versions.rg;
}

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseVersions(value: unknown): SshToolVersions | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.fd !== "string") return undefined;
	if (typeof value.rg !== "string") return undefined;
	return { fd: value.fd, rg: value.rg };
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

async function assertPathExists(path: string): Promise<void> {
	if (await pathExists(path)) return;
	throw new Error(`Missing SSH tools cache entry: ${path}`);
}

function formatCommandFailure(command: string, code: number | null, stderr: Buffer[]): string {
	const text = Buffer.concat(stderr).toString("utf8").trim();
	return text || `${command} exited with ${code ?? "unknown status"}`;
}

function runCommand(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		const stderr: Buffer[] = [];
		child.stderr.on("data", (data) => stderr.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(formatCommandFailure(command, code, stderr)));
		});
	});
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
	const response = await fetch(url, {
		headers: { "User-Agent": "pi-ssh-tools" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`GitHub request failed (${response.status}): ${url}`);
	}
	return (await response.json()) as T;
}

async function getReleaseAssets(tool: SshToolName, version: string): Promise<GitHubReleaseAsset[]> {
	const config = TOOL_CONFIGS[tool];
	const tag = `${config.tagPrefix}${version}`;
	const key = `${config.repo}:${tag}`;
	const cached = releaseAssets.get(key);
	if (cached) return cached;

	const promise = fetchJson<GitHubRelease>(
		`https://api.github.com/repos/${config.repo}/releases/tags/${tag}`,
		NETWORK_TIMEOUT_MS,
	).then((release) => release.assets);
	releaseAssets.set(key, promise);
	return promise;
}

async function getLatestVersion(tool: SshToolName): Promise<string> {
	const config = TOOL_CONFIGS[tool];
	const release = await fetchJson<GitHubRelease>(
		`https://api.github.com/repos/${config.repo}/releases/latest`,
		NETWORK_TIMEOUT_MS,
	);
	return release.tag_name.replace(/^v/, "");
}

async function selectReleaseAsset(
	tool: SshToolName,
	version: string,
	platform: SshToolPlatform,
): Promise<GitHubReleaseAsset> {
	const assets = await getReleaseAssets(tool, version);
	const byName = new Map(assets.map((asset) => [asset.name, asset]));
	for (const assetName of TOOL_CONFIGS[tool].assetNames(version, platform)) {
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

async function sha256File(filePath: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex");
}

function cacheDescriptor(versions: SshToolVersions): LocalSshToolsCache {
	const key = cacheKey(versions);
	const rootDir = join(sshToolsCacheRoot(), key);
	const platforms = {} as Record<SshToolPlatform, LocalSshToolsPlatformCache>;
	for (const platform of SSH_TOOL_PLATFORMS) {
		const platformDir = join(rootDir, platform);
		const binDir = join(platformDir, "bin");
		platforms[platform] = {
			archivePath: join(rootDir, `${platform}.tar.gz`),
			binDir,
			tools: {
				fd: join(binDir, "fd"),
				rg: join(binDir, "rg"),
			},
		};
	}
	return { cacheKey: key, rootDir, versions, platforms };
}

async function readActiveVersions(): Promise<SshToolVersions | undefined> {
	const activePath = join(sshToolsCacheRoot(), "active.json");
	if (!(await pathExists(activePath))) return undefined;
	const parsed = JSON.parse(await readFile(activePath, "utf8")) as unknown;
	if (!isRecord(parsed)) return undefined;
	return parseVersions(parsed.versions);
}

async function validateCache(cache: LocalSshToolsCache): Promise<boolean> {
	try {
		await assertPathExists(join(cache.rootDir, "manifest.json"));
		for (const platform of SSH_TOOL_PLATFORMS) {
			const platformCache = cache.platforms[platform];
			await assertPathExists(platformCache.archivePath);
			await assertPathExists(platformCache.tools.fd);
			await assertPathExists(platformCache.tools.rg);
		}
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		if (error instanceof Error && error.message.startsWith("Missing SSH tools cache entry:")) return false;
		throw error;
	}
}

async function installToolBinary(options: {
	cache: LocalSshToolsCache;
	platform: SshToolPlatform;
	tool: SshToolName;
	tmpDir: string;
}): Promise<ToolManifestEntry> {
	const version = versionForTool(options.cache.versions, options.tool);
	const asset = await selectReleaseAsset(options.tool, version, options.platform);
	const archivePath = join(options.tmpDir, asset.name);
	const extractDir = join(options.tmpDir, `${options.tool}-extract`);
	await mkdir(extractDir, { recursive: true });
	await downloadFile(asset.browser_download_url, archivePath);
	await runCommand("tar", ["xzf", archivePath, "-C", extractDir]);

	const binaryName = TOOL_CONFIGS[options.tool].binaryName;
	const extractedBinary = await findBinary(extractDir, binaryName);
	const targetBinary = options.cache.platforms[options.platform].tools[options.tool];
	await mkdir(join(options.cache.platforms[options.platform].binDir), { recursive: true });
	await copyFile(extractedBinary, targetBinary);
	await chmod(targetBinary, 0o755);

	return {
		assetName: asset.name,
		assetUrl: asset.browser_download_url,
		sha256: await sha256File(targetBinary),
	};
}

async function buildLocalSshToolsCache(versions: SshToolVersions): Promise<LocalSshToolsCache> {
	const cache = cacheDescriptor(versions);
	const parentDir = sshToolsCacheRoot();
	const tmpDir = join(parentDir, `.tmp-${cache.cacheKey}-${process.pid}-${Date.now()}`);
	const tmpCache = cacheDescriptor(versions);
	tmpCache.rootDir = tmpDir;
	for (const platform of SSH_TOOL_PLATFORMS) {
		const platformDir = join(tmpDir, platform);
		const binDir = join(platformDir, "bin");
		tmpCache.platforms[platform] = {
			archivePath: join(tmpDir, `${platform}.tar.gz`),
			binDir,
			tools: {
				fd: join(binDir, "fd"),
				rg: join(binDir, "rg"),
			},
		};
	}

	await mkdir(parentDir, { recursive: true });
	await rm(tmpDir, { recursive: true, force: true });
	await mkdir(tmpDir, { recursive: true });
	try {
		const platforms = {} as Record<SshToolPlatform, PlatformManifestEntry>;
		for (const platform of SSH_TOOL_PLATFORMS) {
			const toolTmpDir = join(tmpDir, `${platform}-downloads`);
			await mkdir(toolTmpDir, { recursive: true });
			const tools = {} as Record<SshToolName, ToolManifestEntry>;
			tools.fd = await installToolBinary({ cache: tmpCache, platform, tool: "fd", tmpDir: toolTmpDir });
			tools.rg = await installToolBinary({ cache: tmpCache, platform, tool: "rg", tmpDir: toolTmpDir });
			await runCommand("tar", [
				"czf",
				tmpCache.platforms[platform].archivePath,
				"-C",
				join(tmpDir, platform),
				"bin",
			]);
			platforms[platform] = {
				archivePath: `${platform}.tar.gz`,
				archiveSha256: await sha256File(tmpCache.platforms[platform].archivePath),
				tools,
			};
		}

		const manifest: SshToolsManifest = { cacheKey: cache.cacheKey, versions, platforms };
		await writeFile(join(tmpDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		await rm(cache.rootDir, { recursive: true, force: true });
		await rename(tmpDir, cache.rootDir);
	} catch (error) {
		await rm(tmpDir, { recursive: true, force: true });
		throw error;
	}

	const active: ActiveSshToolsCache = { cacheKey: cache.cacheKey, versions, updatedAt: new Date().toISOString() };
	await writeFile(join(parentDir, "active.json"), `${JSON.stringify(active, null, "\t")}\n`);
	return cache;
}

export async function getLatestSshToolVersions(): Promise<SshToolVersions> {
	const [fd, rg] = await Promise.all([getLatestVersion("fd"), getLatestVersion("rg")]);
	return { fd, rg };
}

export async function installLatestSshTools(): Promise<LocalSshToolsCache> {
	return ensureLocalSshTools(await getLatestSshToolVersions());
}

export async function ensureLocalSshTools(versions?: SshToolVersions): Promise<LocalSshToolsCache> {
	const resolvedVersions = versions ?? (await readActiveVersions()) ?? DEFAULT_SSH_TOOL_VERSIONS;
	const cache = cacheDescriptor(resolvedVersions);
	if (await validateCache(cache)) return cache;
	if (isOfflineModeEnabled()) {
		throw new Error(`SSH tools cache is missing and PI_OFFLINE is enabled: ${cache.rootDir}`);
	}
	return buildLocalSshToolsCache(resolvedVersions);
}
