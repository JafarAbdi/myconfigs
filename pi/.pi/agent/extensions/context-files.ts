/**
 * Load global Claude context and resolve @-references in context files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

const MAX_REF_DEPTH = 5;
const MAX_CONTEXT_FILES = 128;

interface ContextFileInfo {
	path: string;
	scanDir: string;
	displayPath: string;
	content: string;
	source: "pi-context" | "claude-global" | "resolved-ref";
	promptSource: "pi" | "extension";
}

interface PendingScan {
	content: string;
	baseDir: string;
	depth: number;
}

function canonicalPath(filePath: string): string {
	try {
		return fs.realpathSync.native(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function displayPath(filePath: string, cwd: string): string {
	const home = os.homedir();
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}${path.sep}`)) return `~/${path.relative(home, filePath)}`;
	return path.relative(cwd, filePath) || filePath;
}

function extractRefs(text: string): string[] {
	const refs: string[] = [];
	const linkRe = /\[@([^\]]+)\]\(([^)]+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = linkRe.exec(text)) !== null) refs.push(match[2]);

	const bareRe = /(?:^|\s)@((?:[^\s\\[\]]|\\ )+)/g;
	while ((match = bareRe.exec(text)) !== null) {
		let ref = match[1];
		if (!ref) continue;
		const hash = ref.indexOf("#");
		if (hash !== -1) ref = ref.substring(0, hash);
		if (ref) refs.push(ref.replace(/\\ /g, " "));
	}
	return refs;
}

function addFile(
	files: ContextFileInfo[],
	seen: Set<string>,
	filePath: string,
	cwd: string,
	source: ContextFileInfo["source"],
	promptSource: ContextFileInfo["promptSource"],
): ContextFileInfo | null {
	if (!fs.existsSync(filePath)) return null;
	if (!fs.statSync(filePath).isFile()) return null;

	const absolutePath = path.resolve(filePath);
	const realPath = canonicalPath(absolutePath);
	if (seen.has(realPath)) return null;
	seen.add(realPath);

	const content = fs.readFileSync(realPath, "utf-8");
	const file = {
		path: realPath,
		scanDir: path.dirname(absolutePath),
		displayPath: displayPath(absolutePath, cwd),
		content,
		source,
		promptSource,
	};
	files.push(file);
	return file;
}

function loadContextFiles(cwd: string): ContextFileInfo[] {
	const files: ContextFileInfo[] = [];
	const seen = new Set<string>();
	const scans: PendingScan[] = [];

	for (const file of loadProjectContextFiles({ cwd, agentDir: getAgentDir() })) {
		const added = addFile(files, seen, file.path, cwd, "pi-context", "pi");
		if (added) scans.push({ content: added.content, baseDir: added.scanDir, depth: 0 });
	}

	const claudePath = path.join(os.homedir(), ".claude", "CLAUDE.md");
	const claude = addFile(files, seen, claudePath, cwd, "claude-global", "extension");
	if (claude) scans.push({ content: claude.content, baseDir: claude.scanDir, depth: 0 });

	for (let index = 0; index < scans.length; index += 1) {
		if (files.length >= MAX_CONTEXT_FILES) break;
		const scan = scans[index];
		if (scan.depth >= MAX_REF_DEPTH) continue;

		for (const ref of extractRefs(scan.content)) {
			if (files.length >= MAX_CONTEXT_FILES) break;
			const filePath = path.resolve(scan.baseDir, ref);
			const added = addFile(files, seen, filePath, cwd, "resolved-ref", "extension");
			if (added) {
				scans.push({
					content: added.content,
					baseDir: added.scanDir,
					depth: scan.depth + 1,
				});
			}
		}
	}

	return files;
}

function formatPromptSuffix(files: ContextFileInfo[]): string | null {
	const blocks = files
		.filter((file) => file.promptSource === "extension")
		.map((file) => `### ${file.displayPath}\n\n${file.content}`);
	if (blocks.length === 0) return null;
	return `\n\n## Referenced context files\n\n${blocks.join("\n\n")}\n`;
}

function formatContextFiles(files: ContextFileInfo[], includeContent: boolean): string {
	if (files.length === 0) return "No context files loaded.";

	const lines = ["Context files:"];
	for (const file of files) {
		lines.push(`- [${file.source}] ${file.displayPath} (prompt: ${file.promptSource})`);
		if (includeContent) lines.push("", "```markdown", file.content.trimEnd(), "```", "");
	}
	return lines.join("\n");
}

export default function contextFilesExtension(pi: ExtensionAPI) {
	let promptSuffix: string | null = null;
	let files: ContextFileInfo[] = [];

	pi.on("session_start", async (_event, ctx) => {
		files = loadContextFiles(ctx.cwd);
		promptSuffix = formatPromptSuffix(files);

		const resolved = files.filter((file) => file.source === "resolved-ref");
		if (resolved.length > 0) {
			ctx.ui.notify(`Resolved refs: ${resolved.map((file) => file.displayPath).join(", ")}`, "info");
		}
	});

	pi.registerCommand("context-files", {
		description: "List loaded context files and resolved refs for this session",
		getArgumentCompletions: (prefix) => {
			const items = [{ value: "show", label: "show", description: "include file contents" }];
			const trimmed = prefix.trimStart();
			return items.filter((item) => item.value.startsWith(trimmed));
		},
		handler: async (args) => {
			pi.sendMessage({
				customType: "context-files",
				content: formatContextFiles(files, args.trim() === "show"),
				display: true,
			});
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!promptSuffix) return;
		return { systemPrompt: event.systemPrompt + promptSuffix };
	});
}
