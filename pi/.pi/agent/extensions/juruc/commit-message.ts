import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const COMMIT_MESSAGE_MAX_LENGTH = 10_000;

export const COMMIT_INSPECTION_COMMANDS = [
	"git diff --cached",
	"git diff --cached --stat",
	"git log -n 50 --pretty=format:%s",
] as const;

export type CommitMessageClassification =
	| { kind: "absent" }
	| { kind: "valid"; responseEntryId: string; text: string }
	| { kind: "invalid"; reason: string };

export interface CommitMessageClassifierInput {
	baselineEntryId: string;
	branch: readonly SessionEntry[];
	canonicalPrompt: string;
	task: string;
	phase: string;
}

export interface CommitInspectionPreflight {
	currentCallLocation: number | undefined;
	malformedSuffix: boolean;
	priorCount: number;
	currentCount: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isCommitInspectionInput(value: unknown): value is { command: string } {
	const args = record(value);
	return Boolean(
		args && exactKeys(args, ["command"]) && typeof args.command === "string" &&
			(COMMIT_INSPECTION_COMMANDS as readonly string[]).includes(args.command),
	);
}

export function deriveCommitInspectionPreflight(
	input: CommitMessageClassifierInput & { toolCallId: string; toolInput: unknown },
): CommitInspectionPreflight {
	const baseline = input.branch.findIndex((entry) => entry.id === input.baselineEntryId);
	const malformed = (currentCallLocation: number | undefined, priorCount: number, currentCount = priorCount): CommitInspectionPreflight => ({
		currentCallLocation,
		malformedSuffix: true,
		priorCount,
		currentCount,
	});
	if (baseline < 0) return malformed(undefined, 0);
	let promptSeen = false;
	let priorCount = 0;
	let currentCallLocation: number | undefined;
	let currentAssistantIndex: number | undefined;
	let lastActiveIndex: number | undefined;
	let priorCountAtCurrent = 0;
	let currentCount = 0;
	const pending = new Set<string>();
	const seenIds = new Set<string>();
	for (let index = baseline + 1; index < input.branch.length; index++) {
		const entry = input.branch[index];
		if (entry.type === "compaction") continue;
		lastActiveIndex = index;
		if (entry.type === "custom_message") {
			if (promptSeen || !validPromptEntry(entry, input)) return malformed(currentCallLocation, priorCount, currentCount);
			promptSeen = true;
			continue;
		}
		if (!promptSeen || entry.type !== "message") return malformed(currentCallLocation, priorCount, currentCount);
		const message = entry.message;
		if (message.role === "toolResult") {
			if (message.toolName !== "bash" || message.isError || !pending.delete(message.toolCallId))
				return malformed(currentCallLocation, priorCount, currentCount);
			continue;
		}
		if (message.role !== "assistant") return malformed(currentCallLocation, priorCount, currentCount);
		const blocks = Array.isArray(message.content) ? message.content : [];
		const textBlocks: string[] = [];
		const calls: Array<Record<string, unknown>> = [];
		for (const block of blocks) {
			const value = record(block);
			if (!value || typeof value.type !== "string") return malformed(currentCallLocation, priorCount, currentCount);
			if (value.type === "thinking") continue;
			if (value.type === "text" && typeof value.text === "string") {
				textBlocks.push(value.text);
				continue;
			}
			if (value.type === "toolCall") {
				calls.push(value);
				continue;
			}
			return malformed(currentCallLocation, priorCount, currentCount);
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			if (textBlocks.some((text) => text.trim().length > 0) || calls.length > 0)
				return malformed(currentCallLocation, priorCount, currentCount);
			continue;
		}
		if (message.errorMessage) return malformed(currentCallLocation, priorCount, currentCount);
		if (message.stopReason !== "toolUse" || textBlocks.some((text) => text.trim().length > 0) ||
			calls.length === 0 || pending.size > 0) return malformed(currentCallLocation, priorCount, currentCount);
		const before = priorCount;
		currentAssistantIndex = index;
		for (const [callIndex, call] of calls.entries()) {
			if (typeof call.id !== "string" || !call.id || seenIds.has(call.id) ||
				call.name !== "bash" || !isCommitInspectionInput(call.arguments))
				return malformed(currentCallLocation, before, currentCount);
			seenIds.add(call.id);
			pending.add(call.id);
			if (call.id === input.toolCallId) {
				if (currentCallLocation !== undefined || JSON.stringify(call.arguments) !== JSON.stringify(input.toolInput))
					return malformed(index, before, currentCount);
				currentCallLocation = index;
				priorCountAtCurrent = before + callIndex;
			}
			priorCount++;
		}
		if (currentCallLocation !== undefined) currentCount = before + calls.length;
	}
	if (!promptSeen || currentCallLocation === undefined || currentAssistantIndex !== lastActiveIndex || pending.size === 0)
		return malformed(currentCallLocation, priorCount, currentCount);
	return { currentCallLocation, malformedSuffix: false, priorCount: priorCountAtCurrent, currentCount };
}

function invalid(reason: string): CommitMessageClassification {
	return { kind: "invalid", reason };
}

function validPromptEntry(
	entry: SessionEntry,
	input: CommitMessageClassifierInput,
): boolean {
	if (entry.type !== "custom_message" || entry.customType !== "juruc-commit-message" || entry.display !== false)
		return false;
	if (!Array.isArray(entry.content) || entry.content.length !== 1) return false;
	const content = record(entry.content[0]);
	if (!content || !exactKeys(content, ["type", "text"]) ||
		content.type !== "text" || content.text !== input.canonicalPrompt) return false;
	const details = record(entry.details);
	return Boolean(
		details && exactKeys(details, ["task", "phase", "baseline"]) &&
		details.task === input.task && details.phase === input.phase &&
		details.baseline === input.baselineEntryId,
	);
}

function validCommitMessage(text: string): boolean {
	return text.trim().length > 0 && text.length <= COMMIT_MESSAGE_MAX_LENGTH && !text.includes("\0");
}

export function classifyCommitMessageSuffix(
	input: CommitMessageClassifierInput,
): CommitMessageClassification {
	const baselineIndexes = input.branch.flatMap((entry, index) =>
		entry.id === input.baselineEntryId ? [index] : []);
	if (baselineIndexes.length !== 1) return invalid("baseline is missing or ambiguous on the active branch");
	const suffix = input.branch.slice(baselineIndexes[0] + 1);
	let promptSeen = false;
	let final: { id: string; text: string } | undefined;
	const pendingCalls = new Set<string>();
	const completedCalls = new Set<string>();

	for (const entry of suffix) {
		if (entry.type === "compaction") continue;
		if (entry.type === "custom_message") {
			if (promptSeen || final || !validPromptEntry(entry, input))
				return invalid("canonical prompt provenance is invalid or duplicated");
			promptSeen = true;
			continue;
		}
		if (!promptSeen) {
			if (entry.type === "message" && entry.message.role === "user")
				return invalid("contextual message appears after the baseline");
			return invalid("non-prompt activity appears after the baseline");
		}
		if (entry.type !== "message") return invalid("unsupported entry appears after the canonical prompt");
		const message = entry.message;
		if (message.role === "user" || message.role === "custom")
			return invalid("contextual continuation appears after the canonical prompt");
		if (message.role === "toolResult") {
			if (final || message.toolName !== "bash" || message.isError ||
				!pendingCalls.delete(message.toolCallId) || completedCalls.has(message.toolCallId))
				return invalid("tool result does not match one permitted inspection call");
			completedCalls.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant")
			return invalid("unsupported contextual message appears after the canonical prompt");
		if (final) return invalid("multiple final assistant responses are present");
		const blocks = Array.isArray(message.content) ? message.content : [];
		const textBlocks: string[] = [];
		const calls: Array<Record<string, unknown>> = [];
		for (const block of blocks) {
			const value = record(block);
			if (!value || typeof value.type !== "string") return invalid("assistant content is malformed");
			if (value.type === "thinking") continue;
			if (value.type === "text" && typeof value.text === "string") {
				textBlocks.push(value.text);
				continue;
			}
			if (value.type === "toolCall") {
				calls.push(value);
				continue;
			}
			return invalid("assistant response contains unsupported content");
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			if (textBlocks.some((text) => text.trim().length > 0) || calls.length > 0)
				return invalid("retry error contains semantic content");
			continue;
		}
		if (message.errorMessage) return invalid("assistant response contains an error");
		if (message.stopReason === "toolUse") {
			if (textBlocks.some((text) => text.trim().length > 0) || calls.length === 0)
				return invalid("tool-use response contains semantic text or no calls");
			for (const call of calls) {
				if (pendingCalls.size + completedCalls.size >= COMMIT_INSPECTION_COMMANDS.length)
					return invalid("inspection call bound was exceeded");
				if (call.name !== "bash" || typeof call.id !== "string" || !call.id ||
					pendingCalls.has(call.id) || completedCalls.has(call.id) ||
					!isCommitInspectionInput(call.arguments))
					return invalid("assistant requested a disallowed or malformed inspection");
				pendingCalls.add(call.id);
			}
			continue;
		}
		if (message.stopReason !== "stop" || calls.length > 0 || pendingCalls.size > 0)
			return invalid("assistant response did not settle cleanly");
		const text = textBlocks.join("\n");
		if (!validCommitMessage(text)) return invalid("commit message is empty, invalid, or too long");
		final = { id: entry.id, text };
	}

	if (!promptSeen) return { kind: "absent" };
	if (pendingCalls.size > 0) return invalid("inspection call has no matching result");
	return final
		? { kind: "valid", responseEntryId: final.id, text: final.text }
		: invalid("canonical response is incomplete");
}
