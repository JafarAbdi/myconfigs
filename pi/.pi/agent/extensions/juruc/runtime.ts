import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface RuntimePaths {
	root: string;
	tasks: string;
	worktrees: string;
}

export function requireExactDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
		throw new Error(`${path} is not an exact non-symlink directory`);
}

function createExactDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	requireExactDirectory(path);
}

export function requireRuntimePaths(paths: RuntimePaths): void {
	if (
		paths.tasks !== join(paths.root, "tasks") ||
		paths.worktrees !== join(paths.root, "worktrees")
	)
		throw new Error("JURUC runtime paths do not have the exact expected layout");
	requireExactDirectory(paths.root);
	requireExactDirectory(paths.tasks);
	requireExactDirectory(paths.worktrees);
}

export function runtimePathsForRoot(root: string): RuntimePaths {
	const paths = {
		root,
		tasks: join(root, "tasks"),
		worktrees: join(root, "worktrees"),
	};
	requireRuntimePaths(paths);
	return paths;
}

export function runtimePaths(agentDir: string): RuntimePaths {
	const agentRoot = realpathSync(agentDir);
	requireExactDirectory(agentRoot);
	const root = join(agentRoot, "juruc");
	const paths = {
		root,
		tasks: join(root, "tasks"),
		worktrees: join(root, "worktrees"),
	};
	createExactDirectory(paths.root);
	createExactDirectory(paths.tasks);
	createExactDirectory(paths.worktrees);
	return runtimePathsForRoot(root);
}
