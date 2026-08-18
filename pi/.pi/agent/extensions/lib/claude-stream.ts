/**
 * Shared claude `--output-format stream-json` decoder + normalized child-event types.
 *
 * Two extensions parse claude's stream-json: `subagent` (delegating a task to `claude -p`) and
 * `claude-provider` (claude as pi's main model). This is the single decoder for that wire format —
 * one source of truth, so a newly-added claude event type is handled in exactly one place.
 *
 * The generic JSON guards, field validators, and `Usage` helpers live here too because the decoder
 * needs them and the pi decoder in `subagent/runtimes.ts` reuses them. Pi packages are imported only
 * as types, so this module can be unit-tested directly with `node --test`.
 */
import type { Usage } from "@earendil-works/pi-ai";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}

export function isString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
}

export function isNumber(value: JsonValue | undefined): value is number {
	return typeof value === "number";
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
	return typeof value === "boolean";
}

export function isStringOrNumber(value: JsonValue | undefined): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is JsonValue[] {
	return Array.isArray(value);
}

function requiredStringField(object: JsonObject, field: string, context: string): string {
	const value = object[field];
	if (!isString(value)) throw new Error(`${context}.${field} must be a string`);
	return value;
}

function optionalStringField(object: JsonObject, field: string, context: string): string | undefined {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isString(value)) throw new Error(`${context}.${field} must be a string`);
	return value;
}

function optionalNumberField(object: JsonObject, field: string, context: string): number | undefined {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isNumber(value)) throw new Error(`${context}.${field} must be a number`);
	return value;
}

function optionalBooleanField(object: JsonObject, field: string, context: string): boolean | undefined {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isBoolean(value)) throw new Error(`${context}.${field} must be a boolean`);
	return value;
}

function requiredObjectField(object: JsonObject, field: string, context: string): JsonObject {
	const value = object[field];
	if (!isJsonObject(value)) throw new Error(`${context}.${field} must be an object`);
	return value;
}

function optionalObjectField(object: JsonObject, field: string, context: string): JsonObject | undefined {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) throw new Error(`${context}.${field} must be an object`);
	return value;
}

function requiredArrayField(object: JsonObject, field: string, context: string): JsonValue[] {
	const value = object[field];
	if (!isJsonArray(value)) throw new Error(`${context}.${field} must be an array`);
	return value;
}

function optionalArrayField(object: JsonObject, field: string, context: string): JsonValue[] | undefined {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isJsonArray(value)) throw new Error(`${context}.${field} must be an array`);
	return value;
}

const COUNT_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(total: Usage, next: Usage): void {
	for (const key of COUNT_KEYS) total[key] += next[key];
	for (const key of COST_KEYS) total.cost[key] += next.cost[key];
}

export function decodeUsage(value: JsonValue, context: string): Usage {
	if (!isJsonObject(value)) throw new Error(`${context} must be an object`);
	const cost = requiredObjectField(value, "cost", context);
	const usage = emptyUsage();
	for (const key of COUNT_KEYS) {
		const count = value[key];
		if (!isNumber(count)) throw new Error(`${context}.${key} must be a number`);
		usage[key] = count;
	}
	for (const key of COST_KEYS) {
		const amount = cost[key];
		if (!isNumber(amount)) throw new Error(`${context}.cost.${key} must be a number`);
		usage.cost[key] = amount;
	}
	return usage;
}

/** Tool details are short presentation summaries, not retained argument payloads. */
const DETAIL_STORED_MAX = 2000;

/** Ordered by how specifically each field identifies a tool call. */
const DETAIL_KEYS = ["command", "pattern", "file_path", "path", "glob", "url", "query", "description"];

export function preview(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function stepDetail(input: JsonValue | undefined): string | undefined {
	if (!isJsonObject(input)) return undefined;
	for (const key of DETAIL_KEYS) {
		const value = input[key];
		if (isString(value) && value.trim()) return preview(value, DETAIL_STORED_MAX);
	}
	return undefined;
}

function decodeTextContent(content: JsonValue[], context: string, ignoredTypes: Set<string>): string {
	const text: string[] = [];
	for (const [index, value] of content.entries()) {
		if (!isJsonObject(value)) throw new Error(`${context}[${index}] must be an object`);
		const blockContext = `${context}[${index}]`;
		const type = requiredStringField(value, "type", blockContext);
		if (type === "text") {
			text.push(requiredStringField(value, "text", blockContext));
			continue;
		}
		if (ignoredTypes.has(type)) continue;
		throw new Error(`unknown ${blockContext}.type ${JSON.stringify(type)}`);
	}
	return text.join("\n");
}

export function stringifyJson(value: JsonValue): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("JSON value could not be serialized");
	return serialized;
}

export type JsonPayload =
	| { kind: "absent" }
	| { kind: "present"; value: JsonValue };

export type ChildEvent =
	| { kind: "ignored" }
	| { kind: "observed" }
	| { kind: "thinking"; tokens?: number }
	| { kind: "idle" }
	| { kind: "tool-start"; id?: string; tool: string; detail?: string }
	| { kind: "tool-end"; id?: string; tool?: string; failed: boolean; details: JsonPayload }
	| { kind: "assistant-text"; text: string }
	| {
		kind: "pi-message";
		text: string;
		provider?: string;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
		usage?: Usage;
	}
	| { kind: "claude-init"; model: string }
	| {
		kind: "claude-result";
		turns?: number;
		output: JsonPayload;
		text: string;
		usage: Usage;
		stopReason: "stop" | "length" | "error";
		errorMessage?: string;
	};

const CLAUDE_CONTENT_IGNORED = new Set([
	"thinking",
	"redacted_thinking",
	"server_tool_use",
	"advisor_tool_result",
	"web_search_tool_result",
	"mcp_tool_use",
	"mcp_tool_result",
	"image",
]);

function decodeClaudeMessage(event: JsonObject, eventType: "assistant" | "user"): ChildEvent[] {
	const message = requiredObjectField(event, "message", `claude ${eventType}`);
	const role = requiredStringField(message, "role", `claude ${eventType}.message`);
	if (role !== eventType) throw new Error(`claude ${eventType}.message.role must be ${JSON.stringify(eventType)}`);
	const rawContent = message.content;
	if (eventType === "user" && isString(rawContent)) return [{ kind: "observed" }];
	if (!isJsonArray(rawContent)) throw new Error(`claude ${eventType}.message.content must be an array`);
	const content = rawContent;
	const events: ChildEvent[] = [];
	const text: string[] = [];
	for (const [index, rawBlock] of content.entries()) {
		const context = `claude ${eventType}.message.content[${index}]`;
		if (!isJsonObject(rawBlock)) throw new Error(`${context} must be an object`);
		const blockType = requiredStringField(rawBlock, "type", context);
		switch (blockType) {
			case "text":
				text.push(requiredStringField(rawBlock, "text", context));
				break;
			case "tool_use":
				events.push({
					kind: "tool-start",
					id: requiredStringField(rawBlock, "id", context),
					tool: requiredStringField(rawBlock, "name", context),
					detail: stepDetail(optionalObjectField(rawBlock, "input", context)),
				});
				break;
			case "tool_result":
				events.push({
					kind: "tool-end",
					id: requiredStringField(rawBlock, "tool_use_id", context),
					failed: optionalBooleanField(rawBlock, "is_error", context) ?? false,
					details: { kind: "absent" },
				});
				break;
			default:
				if (!CLAUDE_CONTENT_IGNORED.has(blockType)) {
					throw new Error(`unknown ${context}.type ${JSON.stringify(blockType)}`);
				}
		}
	}
	if (eventType === "assistant") events.unshift({ kind: "assistant-text", text: text.join("\n") });
	else events.unshift({ kind: "observed" });
	return events;
}

/** `modelUsage` is the run total; the envelope's `usage` is only the final turn. */
function decodeClaudeUsage(event: JsonObject): Usage {
	const usage = emptyUsage();
	const perModel = optionalObjectField(event, "modelUsage", "claude result");
	if (perModel) {
		for (const [model, rawEntry] of Object.entries(perModel)) {
			if (!isJsonObject(rawEntry)) throw new Error(`claude result.modelUsage.${model} must be an object`);
			const context = `claude result.modelUsage.${model}`;
			const next = emptyUsage();
			next.input = optionalNumberField(rawEntry, "inputTokens", context) ?? 0;
			next.output = optionalNumberField(rawEntry, "outputTokens", context) ?? 0;
			next.cacheRead = optionalNumberField(rawEntry, "cacheReadInputTokens", context) ?? 0;
			next.cacheWrite = optionalNumberField(rawEntry, "cacheCreationInputTokens", context) ?? 0;
			next.totalTokens = next.input + next.output + next.cacheRead + next.cacheWrite;
			addUsage(usage, next);
		}
	}
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.cost.total = optionalNumberField(event, "total_cost_usd", "claude result") ?? 0;
	return usage;
}

interface ClaudeDenials {
	count: number;
	tools: string[];
}

function decodeClaudeDenials(event: JsonObject): ClaudeDenials {
	const rawDenials = optionalArrayField(event, "permission_denials", "claude result") ?? [];
	const tools: string[] = [];
	for (const [index, rawDenial] of rawDenials.entries()) {
		const context = `claude result.permission_denials[${index}]`;
		if (!isJsonObject(rawDenial)) throw new Error(`${context} must be an object`);
		const tool = optionalStringField(rawDenial, "tool_name", context);
		if (tool) tools.push(tool);
	}
	return { count: rawDenials.length, tools };
}

/** Claude can exit zero with an in-band failure, so preserve every structured diagnosis. */
function claudeFailure(event: JsonObject, subtype: string, result: string, denials: ClaudeDenials): string {
	const parts: string[] = [];
	if (denials.tools.length) {
		parts.push(`denied ${[...new Set(denials.tools)].join(", ")} — the run reported success anyway`);
	}
	if (subtype !== "success") parts.push(subtype);
	const terminalReason = optionalStringField(event, "terminal_reason", "claude result");
	if (terminalReason) parts.push(terminalReason);
	const apiStatus = event.api_error_status;
	if (apiStatus !== undefined && apiStatus !== null) {
		if (!isStringOrNumber(apiStatus)) throw new Error("claude result.api_error_status must be a string or number");
		parts.push(`api status ${String(apiStatus)}`);
	}
	if (result.trim()) parts.push(result.trim());
	return parts.join("; ") || "claude reported a failure with no detail";
}

function decodeClaudeResult(event: JsonObject): ChildEvent[] {
	const subtype = requiredStringField(event, "subtype", "claude result");
	const result = subtype === "success"
		? requiredStringField(event, "result", "claude result")
		: optionalStringField(event, "result", "claude result") ?? "";
	const isError = optionalBooleanField(event, "is_error", "claude result") ?? false;
	const stopReason = optionalStringField(event, "stop_reason", "claude result");
	const denials = decodeClaudeDenials(event);
	let output: JsonPayload = { kind: "absent" };
	if (Object.hasOwn(event, "structured_output")) output = { kind: "present", value: event.structured_output };
	let normalizedStopReason: "stop" | "length" | "error";
	let errorMessage: string | undefined;
	// Denial wins over truncation, and truncation wins over apparent success.
	if (isError || subtype !== "success" || denials.count) {
		normalizedStopReason = "error";
		errorMessage = claudeFailure(event, subtype, result, denials);
	} else if (stopReason === "max_tokens") {
		normalizedStopReason = "length";
	} else {
		normalizedStopReason = "stop";
	}
	return [{
		kind: "claude-result",
		turns: optionalNumberField(event, "num_turns", "claude result"),
		output,
		text: result,
		usage: decodeClaudeUsage(event),
		stopReason: normalizedStopReason,
		errorMessage,
	}];
}

export function decodeClaude(value: JsonValue): ChildEvent[] {
	if (!isJsonObject(value)) throw new Error("claude event must be an object");
	const type = requiredStringField(value, "type", "claude event");
	switch (type) {
		case "system": {
			const subtype = requiredStringField(value, "subtype", "claude system");
			switch (subtype) {
				case "init":
					return [{ kind: "claude-init", model: requiredStringField(value, "model", "claude system init") }];
				case "thinking_tokens": {
					const tokens = value.estimated_tokens;
					if (!isNumber(tokens)) throw new Error("claude system thinking_tokens.estimated_tokens must be a number");
					return [{ kind: "thinking", tokens }];
				}
				case "api_retry":
				case "model_refusal_fallback":
				case "model_refusal_no_fallback":
				case "memory_recall":
				case "compact_boundary":
				case "permission_denied":
				case "model_fallback":
				case "model_consent_fallback":
				case "status":
				case "task_started":
				case "task_progress":
				case "task_updated":
				case "task_notification":
				case "background_tasks_changed":
				case "feedback_draft_queued":
				case "task_summary":
				case "session_state_changed":
				case "post_turn_summary":
				case "hook_started":
				case "hook_progress":
				case "hook_response":
				case "commands_changed":
				case "elicitation_complete":
				case "files_persisted":
				case "mirror_error":
				case "code_change_published":
				case "vcs_state_changed":
					return [{ kind: "ignored" }];
				default:
					throw new Error(`unknown claude system subtype ${JSON.stringify(subtype)}`);
			}
		}
		case "assistant":
		case "user":
			return decodeClaudeMessage(value, type);
		case "result":
			return decodeClaudeResult(value);
		case "rate_limit_event":
		case "stream_event":
		case "tool_progress":
		case "tool_use_summary":
		case "auth_status":
		case "prompt_suggestion":
		case "files_persisted":
		case "conversation_reset":
		case "command_lifecycle":
			return [{ kind: "ignored" }];
		default:
			throw new Error(`unknown claude event type ${JSON.stringify(type)}`);
	}
}

// Re-exported for the pi decoder in subagent/runtimes.ts, which validates the same wire shapes.
export {
	requiredStringField,
	optionalStringField,
	optionalNumberField,
	optionalBooleanField,
	requiredObjectField,
	optionalObjectField,
	requiredArrayField,
	optionalArrayField,
	decodeTextContent,
};
