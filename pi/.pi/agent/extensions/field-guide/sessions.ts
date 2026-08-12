import { spawnSync } from "node:child_process";
import { createReadStream, type Dirent, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const TEXT_CHARS_MAX = 20_000;
const COMMAND_CHARS_MAX = 2_000;

export interface SessionFile {
	id: string;
	mtimeMs: number;
	path: string;
	source: "claude" | "pi";
}

export interface FieldGuideState {
	/** Session path → the mtime that was reviewed. A newer mtime makes the session pending again. */
	reviewed: Record<string, number>;
	/** Session path → consecutive failures at that mtime, so a permanently broken session is dropped. */
	failed: Record<string, { attempts: number; mtimeMs: number }>;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function bounded(text: string, limit = TEXT_CHARS_MAX): string {
	const trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n[truncated]`;
}

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [bounded(content)] : [];
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => bounded(part.text))
		.filter(Boolean);
}

function pathArgument(input: JsonRecord): string | undefined {
	for (const key of ["path", "file_path"]) {
		if (typeof input[key] === "string") return input[key];
	}
	return undefined;
}

function toolLine(name: string, input: unknown): string | undefined {
	if (!isRecord(input)) return `Tool ${name}`;
	const normalized = name.toLowerCase();
	if (normalized === "bash" && typeof input.command === "string") {
		return `Tool bash: ${bounded(input.command, COMMAND_CHARS_MAX)}`;
	}
	if (["edit", "write", "read"].includes(normalized)) {
		const path = pathArgument(input);
		return path ? `Tool ${normalized}: ${path}` : undefined;
	}
	if (normalized === "grep") {
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		const path = pathArgument(input);
		return `Tool grep: ${pattern}${path ? ` in ${path}` : ""}`;
	}
	if (normalized === "find") {
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		const path = pathArgument(input);
		return `Tool find: ${pattern}${path ? ` in ${path}` : ""}`;
	}
	return `Tool ${name}`;
}

function toolResultLine(name: string | undefined, content: unknown, isError: boolean): string | undefined {
	if (name?.toLowerCase() === "read") return undefined;
	const text = textBlocks(content).join("\n");
	if (!text) return undefined;
	return `${isError ? "Tool error" : `Tool ${name ?? "result"} result`}:\n${bounded(text, COMMAND_CHARS_MAX)}`;
}

function piMessageLines(entry: JsonRecord): string[] {
	if (entry.type !== "message" || !isRecord(entry.message)) return [];
	const message = entry.message;
	const role = message.role;
	if (role === "toolResult") {
		const name = typeof message.toolName === "string" ? message.toolName : undefined;
		const line = toolResultLine(name, message.content, message.isError === true);
		return line ? [line] : [];
	}
	if (role !== "user" && role !== "assistant") return [];

	const lines = textBlocks(message.content);
	if (role === "assistant" && Array.isArray(message.content)) {
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
			const line = toolLine(part.name, part.arguments);
			if (line) lines.push(line);
		}
	}
	return lines.length ? [`${role === "user" ? "User" : "Assistant"}:\n${lines.join("\n")}`] : [];
}

function claudeMessageLines(entry: JsonRecord, tools: Map<string, string>): string[] {
	if ((entry.type !== "user" && entry.type !== "assistant") || entry.isSidechain === true || !isRecord(entry.message)) {
		return [];
	}
	const message = entry.message;
	const role = message.role;
	if (role !== "user" && role !== "assistant") return [];

	const lines = textBlocks(message.content);
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (!isRecord(part)) continue;
			if (role === "assistant" && part.type === "tool_use" && typeof part.name === "string") {
				if (typeof part.id === "string") tools.set(part.id, part.name);
				const line = toolLine(part.name, part.input);
				if (line) lines.push(line);
			}
			if (part.type === "tool_result") {
				const name = typeof part.tool_use_id === "string" ? tools.get(part.tool_use_id) : undefined;
				const line = toolResultLine(name, part.content, part.is_error === true);
				if (line) lines.push(line);
			}
		}
	}
	return lines.length ? [`${role === "user" ? "User" : "Assistant"}:\n${lines.join("\n")}`] : [];
}

async function* jsonLines(path: string): AsyncGenerator<JsonRecord> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			try {
				const value: unknown = JSON.parse(line);
				if (isRecord(value)) yield value;
			} catch {
				// An interrupted writer may leave one incomplete final JSONL record.
			}
		}
	} finally {
		lines.close();
		stream.destroy();
	}
}

export function normalizePiEntries(entries: unknown[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (isRecord(entry)) sections.push(...piMessageLines(entry));
	}
	return sections.join("\n\n");
}

/**
 * Claude only. Pi sessions never reach the raw JSONL: `SessionManager.getBranch()` gives the
 * active branch as `SessionEntry[]`, which `normalizePiEntries` takes directly — reading the file
 * would also pull in branches the user rewound away from.
 */
export async function normalizeClaudeSession(path: string): Promise<string> {
	const sections: string[] = [];
	const claudeTools = new Map<string, string>();
	for await (const entry of jsonLines(path)) sections.push(...claudeMessageLines(entry, claudeTools));
	return sections.join("\n\n");
}

async function claudeMetadata(path: string): Promise<{ cwd: string; id: string } | undefined> {
	let cwd: string | undefined;
	let id: string | undefined;
	for await (const entry of jsonLines(path)) {
		if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
		if (!id && typeof entry.sessionId === "string") id = entry.sessionId;
		if (cwd && id) return { cwd, id };
	}
	return cwd ? { cwd, id: id ?? basename(path, ".jsonl") } : undefined;
}

export function belongsToRepository(repository: string, cwd: string): boolean {
	const relation = relative(resolve(repository), resolve(cwd));
	return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function gitRepository(cwd: string): string | undefined {
	let existing = resolve(cwd);
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return undefined;
		existing = parent;
	}
	const result = spawnSync("git", ["-C", existing, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
	return result.status === 0 ? resolve(result.stdout.trim()) : undefined;
}

export function isRepositoryCwd(repository: string, cwd: string): boolean {
	return belongsToRepository(repository, cwd) && gitRepository(cwd) === resolve(repository);
}

export async function discoverClaudeSessions(
	repository: string,
	claudeProjectsDirectory: string,
): Promise<SessionFile[]> {
	const sessions: SessionFile[] = [];
	const repositories = new Map<string, boolean>();
	const matchesRepository = (cwd: string) => {
		if (!repositories.has(cwd)) repositories.set(cwd, isRepositoryCwd(repository, cwd));
		return repositories.get(cwd)!;
	};

	let projectDirectories: Dirent[];
	try {
		projectDirectories = await readdir(claudeProjectsDirectory, { withFileTypes: true });
	} catch {
		projectDirectories = [];
	}
	for (const projectDirectory of projectDirectories) {
		if (!projectDirectory.isDirectory()) continue;
		const directory = join(claudeProjectsDirectory, projectDirectory.name);
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			// Claude's nested <session>/subagents logs repeat delegated work. Only direct files are primary sessions.
			if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".jsonl")) continue;
			const path = join(directory, entry.name);
			const metadata = await claudeMetadata(path);
			if (!metadata || !matchesRepository(metadata.cwd)) continue;
			const info = await stat(path);
			sessions.push({ id: metadata.id, mtimeMs: info.mtimeMs, path, source: "claude" });
		}
	}
	return sessions.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
}
