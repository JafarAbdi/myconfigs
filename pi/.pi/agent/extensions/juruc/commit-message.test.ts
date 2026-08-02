import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	classifyCommitMessageSuffix,
	COMMIT_INSPECTION_COMMANDS,
	deriveCommitInspectionPreflight,
	COMMIT_MESSAGE_MAX_LENGTH,
	isCommitInspectionInput,
	type CommitMessageClassifierInput,
} from "./commit-message.ts";

const BASELINE = "base0001";
const PROMPT = "Return the canonical commit message.\n";
const TASK = "task";
const PHASE = "P1";
let nextId = 1;

function entry(value: Record<string, unknown>): SessionEntry {
	return {
		id: `entry${nextId++}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		...value,
	} as SessionEntry;
}

function baseline(): SessionEntry {
	return entry({ type: "session_info", id: BASELINE, name: "phase" });
}

function prompt(overrides: Record<string, unknown> = {}): SessionEntry {
	return entry({
		type: "custom_message",
		customType: "juruc-commit-message",
		content: [{ type: "text", text: PROMPT }],
		display: false,
		details: { task: TASK, phase: PHASE, baseline: BASELINE },
		...overrides,
	});
}

function assistant(
	content: unknown[],
	stopReason: string,
	errorMessage?: string,
): SessionEntry {
	return entry({
		type: "message",
		message: {
			role: "assistant",
			content,
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason,
			...(errorMessage ? { errorMessage } : {}),
			timestamp: 0,
		},
	});
}

function toolResult(id: string, name = "bash", isError = false): SessionEntry {
	return entry({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "output" }],
			isError,
			timestamp: 0,
		},
	});
}

function classify(suffix: SessionEntry[], overrides: Partial<CommitMessageClassifierInput> = {}) {
	return classifyCommitMessageSuffix({
		baselineEntryId: BASELINE,
		branch: [baseline(), ...suffix],
		canonicalPrompt: PROMPT,
		task: TASK,
		phase: PHASE,
		...overrides,
	});
}

test("commit-message suffix classifier accepts exact direct and inspected responses", () => {
	const direct = assistant([
		{ type: "thinking", thinking: "wording" },
		{ type: "text", text: "Subject" },
		{ type: "text", text: "Body" },
	], "stop");
	assert.deepEqual(classify([prompt(), direct]), {
		kind: "valid",
		responseEntryId: direct.id,
		text: "Subject\nBody",
	});

	const call = assistant([
		{ type: "thinking", thinking: "inspect" },
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git diff --cached" } },
	], "toolUse");
	const final = assistant([{ type: "text", text: "Commit candidate" }], "stop");
	assert.deepEqual(classify([prompt(), call, toolResult("call-1"), final]), {
		kind: "valid",
		responseEntryId: final.id,
		text: "Commit candidate",
	});
});

test("commit-message suffix classifier distinguishes absence and permits harmless retry errors and compaction", () => {
	assert.deepEqual(classify([]), { kind: "absent" });
	assert.deepEqual(classify([entry({ type: "compaction", summary: "compact", tokensBefore: 1 })]), { kind: "absent" });
	const final = assistant([{ type: "text", text: "Recovered wording" }], "stop");
	assert.deepEqual(classify([
		prompt(),
		assistant([{ type: "thinking", thinking: "retry" }], "error", "temporary"),
		entry({ type: "compaction", summary: "compact", tokensBefore: 1 }),
		final,
	]), { kind: "valid", responseEntryId: final.id, text: "Recovered wording" });
});

test("commit-message suffix classifier rejects malformed provenance and contextual continuation", () => {
	const final = () => assistant([{ type: "text", text: "Message" }], "stop");
	for (const suffix of [
		[prompt({ content: PROMPT }), final()],
		[prompt({ content: [{ type: "text", text: `${PROMPT}changed` }] }), final()],
		[prompt({ details: { task: "other", phase: PHASE, baseline: BASELINE } }), final()],
		[prompt({ display: true }), final()],
		[prompt(), prompt(), final()],
		[entry({ type: "message", message: { role: "user", content: "later", timestamp: 0 } })],
		[prompt(), entry({ type: "custom_message", customType: "other", content: "later", display: false }), final()],
	]) assert.equal(classify(suffix).kind, "invalid");
});

test("commit-message suffix classifier rejects malformed tool trajectories", () => {
	const final = () => assistant([{ type: "text", text: "Message" }], "stop");
	const call = (id: string, name: string, args: Record<string, unknown>) =>
		assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
	for (const suffix of [
		[prompt(), call("a", "bash", { command: "git status" }), toolResult("a"), final()],
		[prompt(), call("a", "read", { path: "x" }), toolResult("a", "read"), final()],
		[prompt(), call("a", "bash", { command: "git diff --cached", extra: true }), toolResult("a"), final()],
		[prompt(), call("a", "bash", { command: "git diff --cached", timeout: 1000 }), toolResult("a"), final()],
		[prompt(), call("a", "bash", { command: "git diff --cached" }), final()],
		[prompt(), call("a", "bash", { command: "git diff --cached" }), toolResult("other"), final()],
		[prompt(), call("a", "bash", { command: "git diff --cached" }), toolResult("a", "bash", true), final()],
		[prompt(), call("a", "bash", { command: "git diff --cached" }), toolResult("a"), toolResult("a"), final()],
		[prompt(), assistant([{ type: "text", text: "semantic retry" }], "error", "retry"), final()],
	]) assert.equal(classify(suffix).kind, "invalid");
});

test("commit-message suffix classifier rejects invalid final responses and branch provenance", () => {
	for (const suffix of [
		[prompt()],
		[prompt(), assistant([], "stop")],
		[prompt(), assistant([{ type: "thinking", thinking: "only" }], "stop")],
		[prompt(), assistant([{ type: "text", text: "" }], "stop")],
		[prompt(), assistant([{ type: "text", text: "nul\0text" }], "stop")],
		[prompt(), assistant([{ type: "text", text: "x".repeat(COMMIT_MESSAGE_MAX_LENGTH + 1) }], "stop")],
		[prompt(), assistant([{ type: "text", text: "first" }], "stop"), assistant([{ type: "text", text: "second" }], "stop")],
		[prompt(), assistant([{ type: "image", data: "x", mimeType: "image/png" }], "stop")],
	]) assert.equal(classify(suffix).kind, "invalid");
	assert.equal(classify([prompt(), assistant([{ type: "text", text: "ok" }], "stop")], { baselineEntryId: "missing" }).kind, "invalid");
	assert.equal(classify([prompt(), assistant([{ type: "text", text: "ok" }], "stop")], { branch: [baseline(), baseline()] }).kind, "invalid");
});

test("preflight counts the exact current call within a complete sibling tool message", () => {
	const call = assistant([
		{ type: "thinking", thinking: "inspect" },
		{ type: "text", text: "" },
		{ type: "toolCall", id: "a", name: "bash", arguments: { command: COMMIT_INSPECTION_COMMANDS[0] } },
		{ type: "toolCall", id: "b", name: "bash", arguments: { command: COMMIT_INSPECTION_COMMANDS[1] } },
	], "toolUse");
	const retry = assistant([{ type: "thinking", thinking: "retry" }, { type: "text", text: "" }], "error", "temporary");
	assert.equal(deriveCommitInspectionPreflight({
		baselineEntryId: BASELINE,
		branch: [baseline(), prompt(), retry, call],
		canonicalPrompt: PROMPT,
		task: TASK,
		phase: PHASE,
		toolCallId: "a",
		toolInput: { command: COMMIT_INSPECTION_COMMANDS[0] },
	}).malformedSuffix, false);
	assert.deepEqual(deriveCommitInspectionPreflight({
		baselineEntryId: BASELINE,
		branch: [baseline(), prompt(), call],
		canonicalPrompt: PROMPT,
		task: TASK,
		phase: PHASE,
		toolCallId: "b",
		toolInput: { command: COMMIT_INSPECTION_COMMANDS[1] },
	}), { currentCallLocation: 2, malformedSuffix: false, priorCount: 1, currentCount: 2 });
	const missing = deriveCommitInspectionPreflight({
		baselineEntryId: BASELINE,
		branch: [baseline(), prompt(), call],
		canonicalPrompt: PROMPT,
		task: TASK,
		phase: PHASE,
		toolCallId: "missing",
		toolInput: { command: COMMIT_INSPECTION_COMMANDS[0] },
	});
	assert.equal(missing.malformedSuffix, true);
	assert.equal(missing.currentCallLocation, undefined);
	const ambiguous = deriveCommitInspectionPreflight({
		baselineEntryId: BASELINE,
		branch: [baseline(), baseline(), prompt(), call],
		canonicalPrompt: PROMPT,
		task: TASK,
		phase: PHASE,
		toolCallId: "a",
		toolInput: { command: COMMIT_INSPECTION_COMMANDS[0] },
	});
	assert.equal(ambiguous.malformedSuffix, true);
});

test("isCommitInspectionInput accepts command-only input and rejects timeout or unknown keys identically for every listed command", () => {
	for (const command of COMMIT_INSPECTION_COMMANDS) {
		assert.equal(isCommitInspectionInput({ command }), true);
		assert.equal(isCommitInspectionInput({ command, timeout: 1000 }), false);
		assert.equal(isCommitInspectionInput({ command, unknownKey: true }), false);
	}
	assert.equal(isCommitInspectionInput({ command: "git status" }), false);
	assert.equal(isCommitInspectionInput({ command: 1 }), false);
	assert.equal(isCommitInspectionInput({}), false);
	assert.equal(isCommitInspectionInput(null), false);
});
