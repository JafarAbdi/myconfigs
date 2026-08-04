import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runAgent } from "./run-agent.ts";
import type { Agent } from "./runtimes.ts";

const CLAUDE_MODEL = "claude-sonnet-5";
const AGENT: Agent = {
	name: "reviewer",
	description: "reviews",
	tools: ["read"],
	skills: "none",
	continuable: false,
	systemPrompt: "Review the supplied candidate.",
};

function installClaude(directory: string, body: string): void {
	const command = join(directory, "claude");
	writeFileSync(command, `#!/usr/bin/env node\n${body}`);
	chmodSync(command, 0o755);
}

function tracePath(sessionDir: string, traceId: string): string {
	return join(sessionDir, "native-claude", traceId);
}

function withClaudePath(directory: string): () => void {
	const previous = process.env.PATH;
	process.env.PATH = `${directory}${delimiter}${previous ?? ""}`;
	return () => {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	};
}

test("native Claude persists its exact request and raw streams under a unique session trace", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-"));
	const restorePath = withClaudePath(directory);
	try {
		installClaude(directory, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "${CLAUDE_MODEL}" }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "report" }) + "\\n");
	process.stderr.write("native diagnostic\\n");
});
`);
		const sessionDir = join(directory, "session");
		const result = await runAgent({
			agent: AGENT,
			task: "inspect",
			cwd: directory,
			inherited: { sessionDir },
			model: CLAUDE_MODEL,
			nativeClaude: {
				effort: "high",
				jsonSchema: { type: "object", properties: { verdict: { type: "string" } } },
			},
		});

		assert.equal(result.output, "report");
		assert.ok(result.traceId);
		const trace = tracePath(sessionDir, result.traceId);
		const request = JSON.parse(readFileSync(join(trace, "request.json"), "utf8"));
		assert.equal(request.traceId, result.traceId);
		assert.equal(request.cwd, directory);
		assert.equal(request.command, "claude");
		assert.equal(request.input, "Task: inspect");
		assert.equal(request.args[request.args.indexOf("--effort") + 1], "high");
		assert.equal(
			request.args[request.args.indexOf("--json-schema") + 1],
			JSON.stringify({ type: "object", properties: { verdict: { type: "string" } } }),
		);
		assert.equal(readFileSync(join(trace, "stdout.jsonl"), "utf8"), [
			JSON.stringify({ type: "system", subtype: "init", model: CLAUDE_MODEL }),
			JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "report" }),
			"",
		].join("\n"));
		assert.equal(readFileSync(join(trace, "stderr.log"), "utf8"), "native diagnostic\n");
	} finally {
		restorePath();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("native Claude cancellation still leaves request, stdout, and stderr traces", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-cancel-"));
	const restorePath = withClaudePath(directory);
	try {
		installClaude(directory, `
process.stderr.write("waiting\\n");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "${CLAUDE_MODEL}" }) + "\\n");
setInterval(() => {}, 1_000);
`);
		const sessionDir = join(directory, "session");
		const controller = new AbortController();
		const result = await runAgent({
			agent: AGENT,
			task: "wait",
			cwd: directory,
			inherited: { sessionDir },
			model: CLAUDE_MODEL,
			signal: controller.signal,
			onProgress: () => controller.abort(),
		});

		assert.equal(result.termination, "cancelled");
		assert.ok(result.traceId);
		const trace = tracePath(sessionDir, result.traceId);
		assert.match(readFileSync(join(trace, "request.json"), "utf8"), /Task: wait/u);
		assert.match(readFileSync(join(trace, "stdout.jsonl"), "utf8"), /"subtype":"init"/u);
		assert.equal(readFileSync(join(trace, "stderr.log"), "utf8").includes("waiting\n"), true);
	} finally {
		restorePath();
		rmSync(directory, { recursive: true, force: true });
	}
});
