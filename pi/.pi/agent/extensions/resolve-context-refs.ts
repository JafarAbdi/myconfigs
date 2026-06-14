/**
 * Resolve @-references in context files (CLAUDE.md / AGENTS.md).
 *
 * TODO: Remove the local /context-files command when pi exposes
 * extension-contributed context as structured contextFiles. For now pi only exposes
 * native loader context files; this extension appends resolved refs to the system
 * prompt, so it must also own introspection for those refs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

interface ContextFileInfo {
	path: string;
	content: string;
	source: "context" | "resolved-ref";
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
		if (!ref) continue;
		refs.push(ref.replace(/\\ /g, " "));
	}
	return refs;
}

function collectRefs(
	files: ContextFileInfo[],
	content: string,
	baseDir: string,
	cwd: string,
	seen: Set<string>,
	depth: number,
): string[] {
	if (depth > 5) return [];
	const names: string[] = [];
	for (const ref of extractRefs(content)) {
		const filePath = path.resolve(baseDir, ref);
		if (seen.has(filePath)) continue;
		if (!fs.existsSync(filePath)) continue;
		seen.add(filePath);
		try {
			const refContent = fs.readFileSync(filePath, "utf-8");
			files.push({ path: filePath, content: refContent, source: "resolved-ref" });
			names.push(path.relative(cwd, filePath));
			names.push(...collectRefs(files, refContent, path.dirname(filePath), cwd, seen, depth + 1));
		} catch {
			// skip unreadable refs.
		}
	}
	return names;
}

function formatPromptSuffix(files: ContextFileInfo[], cwd: string): string | null {
	const blocks = files
		.filter((file) => file.source === "resolved-ref")
		.map((file) => `### ${path.relative(cwd, file.path)}\n\n${file.content}`);
	if (blocks.length === 0) return null;
	return `\n\n## Referenced project files\n\n${blocks.join("\n\n")}\n`;
}

function formatContextFiles(files: ContextFileInfo[], includeContent: boolean): string {
	if (files.length === 0) return "No context files loaded.";

	const lines = ["Context files:"];
	for (const file of files) {
		lines.push(`- [${file.source}] ${file.path}`);
		if (includeContent) {
			lines.push("", "```markdown", file.content.trimEnd(), "```", "");
		}
	}
	return lines.join("\n");
}

export default function resolveContextRefsExtension(pi: ExtensionAPI) {
	let promptSuffix: string | null = null;
	let files: ContextFileInfo[] = [];

	pi.on("session_start", async (_event, ctx) => {
		const agentDir = getAgentDir();
		const contextFiles = loadProjectContextFiles({ cwd: ctx.cwd, agentDir });
		files = contextFiles.map((file) => ({ ...file, source: "context" as const }));

		const seen = new Set(files.map((file) => file.path));
		const names: string[] = [];
		for (const file of files.filter((candidate) => candidate.source === "context")) {
			names.push(...collectRefs(files, file.content, path.dirname(file.path), ctx.cwd, seen, 0));
		}

		promptSuffix = formatPromptSuffix(files, ctx.cwd);

		if (names.length > 0) {
			ctx.ui.notify(`Resolved refs: ${names.join(", ")}`, "info");
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
			const includeContent = args.trim() === "show";
			pi.sendMessage({
				customType: "context-files",
				content: formatContextFiles(files, includeContent),
				display: true,
			});
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!promptSuffix) return;
		return { systemPrompt: event.systemPrompt + promptSuffix };
	});
}
