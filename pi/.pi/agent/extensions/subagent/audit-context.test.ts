import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { loadAuditProjectContext, withProjectContext } from "./audit-context.ts";
import type { Agent } from "./runtimes.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args]);
}

test("audit context covers distinct staged directories and deduplicates Pi results", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-audit-context-"));
	try {
		for (const directory of ["pkg", "old"]) mkdirSync(join(root, directory));
		writeFileSync(join(root, "AGENTS.md"), "root");
		writeFileSync(join(root, "pkg", "AGENTS.md"), "pkg");
		writeFileSync(join(root, "pkg", "a.ts"), "a\n");
		writeFileSync(join(root, "pkg", "b.ts"), "b\n");
		writeFileSync(join(root, "old", "file.ts"), "rename me\n");
		git(root, "init", "-q");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		git(root, "add", ".");
		git(root, "commit", "-qm", "fixture");

		writeFileSync(join(root, "pkg", "a.ts"), "changed a\n");
		writeFileSync(join(root, "pkg", "b.ts"), "changed b\n");
		mkdirSync(join(root, "renamed"));
		git(root, "mv", "old/file.ts", "renamed/file.ts");
		rmSync(join(root, "old"), { recursive: true });
		git(root, "add", "pkg/a.ts", "pkg/b.ts");

		const calls: string[] = [];
		const context = loadAuditProjectContext(root, "/agent", ({ cwd, agentDir }) => {
			assert.equal(agentDir, "/agent");
			calls.push(cwd);
			const shared = [
				{ path: "/agent/AGENTS.md", content: "global" },
				{ path: join(root, "AGENTS.md"), content: "root" },
			];
			return basename(cwd) === "pkg"
				? [...shared, { path: join(root, "pkg", "AGENTS.md"), content: "pkg" }]
				: shared;
		});

		assert.deepEqual(new Set(calls), new Set([root, join(root, "pkg"), join(root, "renamed")]));
		assert.equal(calls.length, 3, "two staged files in pkg share one discovery call");
		assert.deepEqual(
			new Set(context.map((file) => file.path)),
			new Set(["/agent/AGENTS.md", join(root, "AGENTS.md"), join(root, "pkg", "AGENTS.md")]),
		);
		assert.equal(context.filter((file) => file.path === join(root, "AGENTS.md")).length, 1);
		assert.throws(
			() => loadAuditProjectContext(root, "/agent", () => [], "--cached"),
			/audit base ref must be a full Git object ID/u,
		);
		assert.throws(
			() => loadAuditProjectContext(root, "/agent", () => [], "a".repeat(41)),
			/audit base ref must be a full Git object ID/u,
		);
		let revision = 0;
		assert.throws(
			() => loadAuditProjectContext(root, "/agent", () => [
				{ path: join(root, "AGENTS.md"), content: String(revision++) },
			]),
			/project context changed during audit preparation/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project context is appended exactly once and an empty discovery adds nothing", () => {
	const agent: Agent = {
		name: "audit",
		description: "audits",
		tools: ["read"],
		skills: "none",
		systemPrompt: "Audit the candidate.",
	};
	assert.equal(withProjectContext(agent, []), agent);
	const enriched = withProjectContext(agent, [
		{ path: "/repo/AGENTS.md", content: "Preserve exact schema authority." },
	]);
	assert.equal(enriched.systemPrompt.split("Preserve exact schema authority.").length - 1, 1);
	assert.match(enriched.systemPrompt, /<project_instructions path="\/repo\/AGENTS\.md">/);
	assert.equal(agent.systemPrompt, "Audit the candidate.");
});
