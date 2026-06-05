import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_ROOT_SEARCH_MAX = 32;

export type SshPathRoute = "local-readonly" | "local-writable" | "remote";

export interface LocalRuntimeRoots {
	readonly: string[];
	writable: string[];
}

function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function readPackageName(packageJsonPath: string): string | undefined {
	const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
	return typeof parsed.name === "string" ? parsed.name : undefined;
}

function findPackageRoot(startFile: string | undefined, packageName: string): string | undefined {
	if (!startFile) return undefined;

	let dir = dirname(realpathOrResolve(startFile));
	for (let i = 0; i < PACKAGE_ROOT_SEARCH_MAX; i += 1) {
		const packageJsonPath = join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			try {
				if (readPackageName(packageJsonPath) === packageName) return dir;
			} catch {}
		}

		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

function isPathInside(path: string, root: string): boolean {
	const relativePath = relative(resolve(root), resolve(path));
	if (relativePath === "") return true;
	if (relativePath === "..") return false;
	if (relativePath.startsWith(`..${sep}`)) return false;
	return !isAbsolute(relativePath);
}

function uniquePaths(paths: Array<string | undefined>): string[] {
	return [...new Set(paths.filter((path): path is string => path !== undefined))];
}

function rootPaths(path: string | undefined): string[] {
	if (!path) return [];
	return uniquePaths([resolve(path), realpathOrResolve(path)]);
}

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function normalizeToolPath(path: string): string {
	const pathWithoutReferencePrefix = path.startsWith("@") ? path.slice(1) : path;
	return expandHomePath(pathWithoutReferencePrefix);
}

function filePathFromSpecifier(specifier: string): string | undefined {
	if (specifier.startsWith("file:")) return fileURLToPath(specifier);
	return isAbsolute(specifier) ? specifier : undefined;
}

function resolveModuleEntry(specifier: string): string | undefined {
	try {
		return filePathFromSpecifier(import.meta.resolve(specifier));
	} catch {
		return undefined;
	}
}

export function createLocalRuntimeRoots(): LocalRuntimeRoots {
	const extensionRoot = dirname(fileURLToPath(import.meta.url));
	const piEntry = resolveModuleEntry(PI_PACKAGE_NAME) ?? process.argv[1];
	const piPackageRoot = findPackageRoot(piEntry, PI_PACKAGE_NAME);

	return {
		readonly: rootPaths(piPackageRoot),
		writable: uniquePaths([...rootPaths(getAgentDir()), ...rootPaths(extensionRoot)]),
	};
}

export function routePath(
	path: string | undefined,
	localRuntimeRoots: LocalRuntimeRoots,
): SshPathRoute {
	if (!path) return "remote";

	const normalizedPath = normalizeToolPath(path);
	if (!isAbsolute(normalizedPath)) return "remote";

	const absolutePath = resolve(normalizedPath);
	if (localRuntimeRoots.writable.some((root) => isPathInside(absolutePath, root))) {
		return "local-writable";
	}
	if (localRuntimeRoots.readonly.some((root) => isPathInside(absolutePath, root))) {
		return "local-readonly";
	}
	return "remote";
}

export function isLocalPathRoute(route: SshPathRoute): boolean {
	return route === "local-readonly" || route === "local-writable";
}

function isPathlikeToken(token: string): boolean {
	return token.startsWith("/") || token.startsWith("~/") || token === "~";
}

export function extractAbsolutePaths(command: string): string[] {
	const paths: string[] = [];
	for (const token of command.split(/\s+/)) {
		const cleaned = token.replace(/^['"]|['"]$/g, "");
		if (isPathlikeToken(cleaned)) paths.push(cleaned);
	}
	return paths;
}

export function hasLocalPathTarget(
	command: string,
	localRuntimeRoots: LocalRuntimeRoots,
): boolean {
	return extractAbsolutePaths(command).some(
		(path) => isLocalPathRoute(routePath(path, localRuntimeRoots)),
	);
}
