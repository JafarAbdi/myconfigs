import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runAgent } from "./run-agent.ts";
import { RESULT_TOOL_ENV, type Agent } from "./runtimes.ts";

const CLAUDE_MODEL = "claude-sonnet-5";
const AGENT: Agent = {
	name: "reviewer",
	description: "reviews",
	tools: ["read"],
	skills: "none",
	continuable: false,
	systemPrompt: "Review the supplied candidate.",
};
const RESULT_AGENT: Agent = { ...AGENT, tools: [...AGENT.tools, "finish"] };

function installClaude(directory: string, body: string): void {
	const command = join(directory, "claude");
	writeFileSync(command, `#!/usr/bin/env node\n${body}`);
	chmodSync(command, 0o755);
}

function installPi(directory: string, body: string): string {
	const command = join(directory, "fake-pi.js");
	writeFileSync(command, `#!/usr/bin/env node\n${body}`);
	chmodSync(command, 0o755);
	return command;
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

test("Pi result tools receive their marker and declared capability, then capture details", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-result-"));
	const script = installPi(directory, `
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "untrusted prose" }] },
}) + "\\n");
process.stdout.write(JSON.stringify({
	type: "tool_execution_end",
	toolName: "other",
	isError: false,
	result: { details: { verdict: "wrong tool" } },
}) + "\\n");
process.stdout.write(JSON.stringify({
	type: "tool_execution_end",
	toolName: process.env.${RESULT_TOOL_ENV},
	isError: false,
	result: { details: { marker: process.env.${RESULT_TOOL_ENV}, argv: process.argv.slice(2) } },
}) + "\\n");
`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await runAgent({
			agent: RESULT_AGENT,
			task: "inspect",
			cwd: directory,
			inherited: {},
			model: undefined,
			resultTool: "finish",
		});
		const output = JSON.parse(result.output) as { marker: string; argv: string[] };
		assert.equal(output.marker, "finish");
		assert.equal(output.argv[output.argv.indexOf("--tools") + 1], "read,finish");
		assert.equal(result.stopReason, "stop");
		assert.notEqual(result.output, "untrusted prose");
		assert.deepEqual(RESULT_AGENT.tools, ["read", "finish"]);
		assert.deepEqual(AGENT.tools, ["read"]);
	} finally {
		process.argv[1] = previousScript;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Pi reports when the child process starts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-start-"));
	const script = installPi(directory, `
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
}) + "\\n");
`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	let started = false;
	try {
		await runAgent({
			agent: AGENT,
			task: "inspect",
			cwd: directory,
			inherited: {},
			model: undefined,
			onStart: () => { started = true; },
		});
		assert.equal(started, true);
	} finally {
		process.argv[1] = previousScript;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Pi accepts large protocol records, diagnostics, and final output", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-large-"));
	const script = installPi(directory, `
const large = "x".repeat(2 * 1024 * 1024 + 1);
process.stdout.write(JSON.stringify({ type: "agent_end", messages: [large] }) + "\\n");
process.stderr.write("d".repeat(128 * 1024));
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: large }] },
}) + "\\n");
`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await runAgent({
			agent: AGENT,
			task: "inspect",
			cwd: directory,
			inherited: {},
			model: undefined,
		});
		assert.equal(result.stopReason, "stop");
		assert.equal(result.output, "x".repeat(2 * 1024 * 1024 + 1));
		assert.equal(result.errorMessage, undefined);
	} finally {
		process.argv[1] = previousScript;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Pi preserves complete stderr when it is the only failure detail", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-stderr-"));
	const script = installPi(directory, `process.stderr.write("d".repeat(128 * 1024));`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await runAgent({
			agent: AGENT,
			task: "inspect",
			cwd: directory,
			inherited: {},
			model: undefined,
		});
		assert.equal(result.errorMessage, "d".repeat(128 * 1024));
	} finally {
		process.argv[1] = previousScript;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Pi result tools reject duplicate successful submissions", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-duplicate-result-"));
	const script = installPi(directory, `
for (const verdict of ["first", "second"]) {
	process.stdout.write(JSON.stringify({
		type: "tool_execution_end",
		toolName: process.env.${RESULT_TOOL_ENV},
		isError: false,
		result: { details: { verdict } },
	}) + "\\n");
}
`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await runAgent({
			agent: RESULT_AGENT,
			task: "inspect",
			cwd: directory,
			inherited: {},
			model: undefined,
			resultTool: "finish",
		});
		assert.equal(result.output, "");
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /returned finish more than once/u);
	} finally {
		process.argv[1] = previousScript;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Pi result tools reject a model turn after submission", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-result-not-final-"));
	const script = installPi(directory, `
process.stdout.write(JSON.stringify({
	type: "tool_execution_end",
	toolName: process.env.${RESULT_TOOL_ENV},
	isError: false,
	result: { details: { verdict: "first" } },
}) + "\\n");
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "continued" }] },
}) + "\\n");
`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await runAgent({
			agent: RESULT_AGENT,
			task: "inspect",
			cwd: directory,
			inherited: {},
			model: undefined,
			resultTool: "finish",
		});
		assert.equal(result.output, "");
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /continued after finish/u);
	} finally {
		process.argv[1] = previousScript;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Pi result tools reject assistant prose when no successful result was returned", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-no-result-"));
	const script = installPi(directory, `
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "only prose" }] },
}) + "\\n");
`);
	const previousScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await runAgent({
			agent: RESULT_AGENT,
			task: "inspect",
			cwd: directory,
			inherited: {},
			model: undefined,
			resultTool: "finish",
		});
		assert.equal(result.output, "");
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /no successful finish result/);
	} finally {
		process.argv[1] = previousScript;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Pi result tools must be declared by the agent", () => {
	assert.throws(
		() => runAgent({
			agent: AGENT,
			task: "inspect",
			cwd: process.cwd(),
			inherited: {},
			model: undefined,
			resultTool: "finish",
		}),
		/resultTool finish is not declared in agent\.tools/,
	);
});

test("result tools are Pi-only", () => {
	assert.throws(
		() => runAgent({
			agent: RESULT_AGENT,
			task: "inspect",
			cwd: process.cwd(),
			inherited: {},
			model: CLAUDE_MODEL,
			resultTool: "finish",
		}),
		/resultTool is only supported for Pi children/,
	);
});

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
	process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "report", structured_output: { verdict: "PASS" } }) + "\\n");
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

		assert.equal(result.output, JSON.stringify({ verdict: "PASS" }));
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
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				stop_reason: "end_turn",
				result: "report",
				structured_output: { verdict: "PASS" },
			}),
			"",
		].join("\n"));
		assert.equal(readFileSync(join(trace, "stderr.log"), "utf8"), "native diagnostic\n");
	} finally {
		restorePath();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("native Claude rejects prose when a JSON schema was required", async () => {
	const directory = mkdtempSync(join(tmpdir(), "subagent-run-agent-claude-no-structured-"));
	const restorePath = withClaudePath(directory);
	try {
		installClaude(directory, `
process.stdout.write(JSON.stringify({
	type: "result",
	subtype: "success",
	is_error: false,
	stop_reason: "end_turn",
	result: '{"verdict":"PASS"}',
}) + "\\n");
`);
		const result = await runAgent({
			agent: AGENT,
			task: "inspect",
			cwd: directory,
			inherited: { sessionDir: join(directory, "session") },
			model: CLAUDE_MODEL,
			nativeClaude: { jsonSchema: { type: "object" } },
		});
		assert.equal(result.output, "");
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "native Claude returned no structured output");
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
