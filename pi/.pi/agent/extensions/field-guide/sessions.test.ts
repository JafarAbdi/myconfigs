import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { belongsToRepository, isRepositoryCwd, normalizeClaudeSession, normalizePiEntries } from "./sessions.ts";

assert.equal(belongsToRepository("/work/repo", "/work/repo"), true);
assert.equal(belongsToRepository("/work/repo", "/work/repo/src"), true);
assert.equal(belongsToRepository("/work/repo", "/work/repository"), false);
assert.equal(belongsToRepository("/work/repo", "/work"), false);

// Entries, not a file: production feeds `normalizePiEntries` straight from `SessionManager.getBranch()`.
const piTranscript = normalizePiEntries([
	{ type: "session", version: 3, id: "pi", cwd: "/work/repo" },
	{ type: "message", message: { role: "user", content: "Please stop using the legacy parser." } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "I will replace it." },
				{ type: "toolCall", name: "edit", arguments: { path: "src/parser.ts", oldText: "secret" } },
			],
		},
	},
	{
		type: "message",
		message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "large file output" }] },
	},
	{
		type: "message",
		message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "1 passed" }] },
	},
]);
assert.match(piTranscript, /legacy parser/);
assert.match(piTranscript, /Tool edit: src\/parser\.ts/);
assert.match(piTranscript, /Tool bash result:\n1 passed/);
assert.doesNotMatch(piTranscript, /private|large file output|secret/);

const directory = await mkdtemp(join(tmpdir(), "field-guide-sessions-test-"));
try {
	const claudePath = join(directory, "claude.jsonl");
	await writeFile(
		claudePath,
		[
			JSON.stringify({
				type: "user",
				cwd: "/work/repo",
				sessionId: "claude",
				message: { role: "user", content: [{ type: "text", text: "Run the focused test." }] },
			}),
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private" },
						{ type: "text", text: "Testing now." },
						{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pytest tests/test_one.py" } },
					],
				},
			}),
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool-1", content: "1 passed" }],
				},
			}),
			JSON.stringify({
				type: "assistant",
				isSidechain: true,
				message: { role: "assistant", content: [{ type: "text", text: "nested duplicate" }] },
			}),
		].join("\n"),
		"utf-8",
	);
	const claudeTranscript = await normalizeClaudeSession(claudePath);
	assert.match(claudeTranscript, /focused test/);
	assert.match(claudeTranscript, /Tool bash: pytest tests\/test_one\.py/);
	assert.match(claudeTranscript, /Tool Bash result:\n1 passed/);
	assert.doesNotMatch(claudeTranscript, /private|nested duplicate/);

	const repository = join(directory, "repository");
	const nestedRepository = join(repository, "nested");
	await mkdir(nestedRepository, { recursive: true });
	assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
	assert.equal(spawnSync("git", ["init", "-q", nestedRepository]).status, 0);
	assert.equal(isRepositoryCwd(repository, repository), true);
	assert.equal(isRepositoryCwd(repository, nestedRepository), false);
} finally {
	await rm(directory, { recursive: true, force: true });
}

console.log("field-guide session characterization: ok");
