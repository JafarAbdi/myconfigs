/**
 * Resolve @-references in context files (CLAUDE.md / AGENTS.md)
 *
 * Uses pi's loadProjectContextFiles to discover context files, resolves
 * @path and [@path](link) references within them, caches the result, and
 * appends to the system prompt every turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

function extractRefs(text: string): string[] {
	const refs: string[] = [];
	const linkRe = /\[@([^\]]+)\]\(([^)]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(text)) !== null) refs.push(m[2]);
	const bareRe = /(?:^|\s)@((?:[^\s\\[\]]|\\ )+)/g;
	while ((m = bareRe.exec(text)) !== null) {
		let p = m[1];
		if (!p) continue;
		const hash = p.indexOf("#");
		if (hash !== -1) p = p.substring(0, hash);
		if (!p) continue;
		refs.push(p.replace(/\\ /g, " "));
	}
	return refs;
}

function resolveRefs(content: string, baseDir: string, cwd: string, depth = 0, seen = new Set<string>()): string {
	if (depth > 5) return "";
	const blocks: string[] = [];
	for (const ref of extractRefs(content)) {
		const absPath = path.resolve(baseDir, ref);
		if (seen.has(absPath)) continue;
		seen.add(absPath);
		try {
			const refContent = fs.readFileSync(absPath, "utf-8");
			blocks.push(`### ${path.relative(cwd, absPath)}\n\n${refContent}`);
			const nested = resolveRefs(refContent, path.dirname(absPath), cwd, depth + 1, seen);
			if (nested) blocks.push(nested);
		} catch { /* skip */ }
	}
	return blocks.join("\n\n");
}

export default function resolveContextRefsExtension(pi: ExtensionAPI) {
	let promptSuffix: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const agentDir = getAgentDir();
		const ctxFiles = loadProjectContextFiles({ cwd: ctx.cwd, agentDir });

		const blocks: string[] = [];
		const names: string[] = [];
		const resolved = new Set<string>();

		for (const cf of ctxFiles) {
			const baseDir = path.dirname(cf.path);
			const chunk = resolveRefs(cf.content, baseDir, ctx.cwd);
			if (chunk) {
				blocks.push(chunk);
				for (const ref of extractRefs(cf.content)) {
					const abs = path.resolve(baseDir, ref);
					if (!resolved.has(abs) && fs.existsSync(abs)) {
						resolved.add(abs);
						names.push(path.relative(ctx.cwd, abs));
					}
				}
			}
		}

		if (blocks.length > 0) {
			promptSuffix = `\n\n## Referenced project files\n\n${blocks.join("\n\n")}\n`;
			ctx.ui.notify(`Resolved refs: ${names.join(", ")}`, "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!promptSuffix) return;
		return { systemPrompt: event.systemPrompt + promptSuffix };
	});
}
