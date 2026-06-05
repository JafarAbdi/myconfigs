import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_ROOT_SEARCH_MAX = 32;

export type SshPathRoute = "local-runtime" | "remote";

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

function normalizeToolPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
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

export function createLocalRuntimeRoots(): string[] {
	const extensionRoot = dirname(fileURLToPath(import.meta.url));
	const piEntry = resolveModuleEntry(PI_PACKAGE_NAME) ?? process.argv[1];
	const piPackageRoot = findPackageRoot(piEntry, PI_PACKAGE_NAME);
	return [extensionRoot, piPackageRoot].filter((root): root is string => root !== undefined);
}

export function routePath(
	path: string | undefined,
	localRuntimeRoots: readonly string[],
): SshPathRoute {
	if (!path) return "remote";

	const normalizedPath = normalizeToolPath(path);
	if (!isAbsolute(normalizedPath)) return "remote";

	const absolutePath = resolve(normalizedPath);
	const routeLocal = localRuntimeRoots.some((root) => isPathInside(absolutePath, root));
	return routeLocal ? "local-runtime" : "remote";
}
