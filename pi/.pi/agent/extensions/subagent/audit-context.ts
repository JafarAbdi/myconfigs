import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Agent } from "./runtimes.ts";

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface ProjectContextFile {
	path: string;
	content: string;
}

export type ProjectContextLoader = (options: {
	cwd: string;
	agentDir: string;
}) => ProjectContextFile[];

function stagedPaths(cwd: string, baseRef = "HEAD"): { root: string; paths: string[] } {
	const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf-8",
	}).trim();
	const fields = execFileSync(
		"git",
		["-C", root, "diff", "--cached", "--name-status", "-z", baseRef, "--"],
		{ encoding: "utf-8" },
	).split("\0");
	const paths: string[] = [];
	for (let index = 0; index < fields.length;) {
		const status = fields[index++];
		if (!status) break;
		const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
		for (let offset = 0; offset < pathCount; offset++) {
			const path = fields[index++];
			if (path) paths.push(path);
		}
	}
	return { root, paths };
}

function nearestExistingDirectory(path: string): string {
	let current = path;
	while (true) {
		if (existsSync(current) && statSync(current).isDirectory()) return current;
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

/** Pi-native context governing every staged path, with shared ancestors supplied once. */
export function loadAuditProjectContext(
	cwd: string,
	agentDir: string,
	loadProjectContextFiles: ProjectContextLoader,
	baseRef = "HEAD",
): ProjectContextFile[] {
	if (baseRef !== "HEAD" && !GIT_OBJECT_ID.test(baseRef))
		throw new Error("audit base ref must be a full Git object ID");
	const { root, paths } = stagedPaths(cwd, baseRef);
	const directories = new Set(
		paths.map((path) => nearestExistingDirectory(dirname(resolve(root, path)))),
	);
	const contextFiles = new Map<string, ProjectContextFile>();
	for (const directory of directories) {
		for (const contextFile of loadProjectContextFiles({ cwd: directory, agentDir })) {
			const existing = contextFiles.get(contextFile.path);
			if (existing && existing.content !== contextFile.content)
				throw new Error(`project context changed during audit preparation: ${contextFile.path}`);
			if (!existing) contextFiles.set(contextFile.path, contextFile);
		}
	}
	return [...contextFiles.values()];
}

export function withProjectContext(agent: Agent, contextFiles: ProjectContextFile[]): Agent {
	if (!contextFiles.length) return agent;
	const projectContext = [
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>\n`,
		),
		"</project_context>",
	].join("\n");
	return { ...agent, systemPrompt: `${agent.systemPrompt}\n\n${projectContext}` };
}
