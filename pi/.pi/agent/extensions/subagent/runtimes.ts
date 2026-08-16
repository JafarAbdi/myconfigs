/**
 * The two child CLIs `delegate` can spawn, their JSONL decoders, and normalized run state.
 * Runtime-specific wire shapes stop here; process management and rendering consume `ChildEvent`.
 * This module imports Pi packages only as types so its tests run directly with `node --test`.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { DELEGATE_CHILD_ENV, SSH_DESCRIPTOR_ENV } from "../ssh/descriptor.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}

export type FrontmatterValue =
	| string
	| number
	| boolean
	| null
	| FrontmatterValue[]
	| FrontmatterObject;

export interface FrontmatterObject {
	[key: string]: FrontmatterValue;
}

function isString(value: JsonValue | FrontmatterValue | undefined): value is string {
	return typeof value === "string";
}

function isNumber(value: JsonValue | undefined): value is number {
	return typeof value === "number";
}

function isBoolean(value: JsonValue | FrontmatterValue | undefined): value is boolean {
	return typeof value === "boolean";
}

function isStringOrNumber(value: JsonValue | undefined): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFrontmatterObject(
	value: FrontmatterValue | undefined,
): value is FrontmatterObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is JsonValue[] {
	return Array.isArray(value);
}

function isFrontmatterArray(
	value: FrontmatterValue | undefined,
): value is FrontmatterValue[] {
	return Array.isArray(value);
}

export interface Agent {
	name: string;
	description: string;
	/** Required. This list is the agent's capability — nothing else adds to it or takes from it. */
	tools: string[];
	skills: "all" | "none";
	continuable: boolean;
	systemPrompt: string;
}

export function agentFromFrontmatter(
	name: string,
	frontmatter: FrontmatterObject,
	systemPrompt: string,
): Agent {
	const description = frontmatter.description;
	if (description === undefined) throw new Error("missing a description");
	if (!isString(description) || !description) throw new Error("description must be a non-empty string");

	const rawTools = frontmatter.tools;
	if (rawTools === undefined) throw new Error("must declare tools");
	if (!isString(rawTools) && !isFrontmatterArray(rawTools)) {
		throw new Error("tools must be a string or string array");
	}
	if (isFrontmatterArray(rawTools) && !rawTools.every(isString)) {
		throw new Error("tools must be a string or string array");
	}
	const parts = isString(rawTools) ? rawTools.split(",") : rawTools;
	const tools = parts.map((tool) => tool.trim()).filter(Boolean);
	if (!tools.length && (!Array.isArray(rawTools) || rawTools.length > 0)) throw new Error("must declare tools");

	const rawSkills = frontmatter.skills;
	if (rawSkills !== undefined && rawSkills !== "all" && rawSkills !== "none") {
		throw new Error('skills must be "all" or "none"');
	}
	const rawContinuable = frontmatter.continuable;
	if (rawContinuable !== undefined && !isBoolean(rawContinuable)) {
		throw new Error("continuable must be a boolean");
	}
	return {
		name,
		description,
		tools,
		skills: rawSkills ?? "all",
		continuable: rawContinuable ?? false,
		systemPrompt,
	};
}

export type RunActivity =
	| { kind: "thinking"; tokens?: number }
	| { kind: "tools"; label: string };

export function activityLabel(activity: RunActivity): string {
	if (activity.kind === "tools") return activity.label;
	return activity.tokens === undefined ? "thinking" : `thinking ${activity.tokens}`;
}

export interface RunResult {
	agent: string;
	task: string;
	runId?: string;
	/** Native Claude trace directory identity, when that runtime persists a request and raw streams. */
	traceId?: string;
	/** The latest assistant text. The final turn's, once there is one; before that, the last thing said. */
	output: string;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	termination?: "cancelled";
	/** What the child is doing now. Progress only; absent while waiting and once finished. */
	activity?: RunActivity;
	/** Every tool the child has run, in order. What `expanded` shows while the run is still going. */
	steps: Step[];
	turns: number;
	usage: Usage;
	durationMs: number;
}

export interface Step {
	tool: string;
	/** The salient argument — a command, a path, a pattern. Already flattened and truncated. */
	detail?: string;
	/** Absent while the tool is still running, which is also how a killed child's last step reads. */
	outcome?: "ok" | "failed";
}

export const RESULT_TOOL_ENV = "PI_SUBAGENT_RESULT_TOOL";

/** Tool details are short presentation summaries, not retained argument payloads. */
const DETAIL_STORED_MAX = 2000;

/** Ordered by how specifically each field identifies a tool call. */
const DETAIL_KEYS = ["command", "pattern", "file_path", "path", "glob", "url", "query", "description"];

export function stepDetail(input: JsonValue | undefined): string | undefined {
	if (!isJsonObject(input)) return undefined;
	for (const key of DETAIL_KEYS) {
		const value = input[key];
		if (isString(value) && value.trim()) return preview(value, DETAIL_STORED_MAX);
	}
	return undefined;
}

/** What the parent session lends a child. A claude child never borrows the model — see `selectRuntime`. */
export interface Inherited {
	appendSystemPrompt?: string;
	model?: string;
	thinkingLevel?: ModelThinkingLevel;
	/** Pi children persist here; each invocation still creates its own fresh session. */
	sessionDir?: string;
	/** Extension-owned exact child session identity. */
	sessionId?: string;
	resume?: boolean;
}

export function childSessionDir(parentSessionDir: string, parentSessionId: string, agentDir: string): string {
	const root = parentSessionDir || join(agentDir, "sessions");
	return join(root, "subagents", parentSessionId);
}

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Native Claude-only controls; Pi deliberately ignores them. */
export interface NativeClaudeOptions {
	effort?: ClaudeEffort;
	jsonSchema?: object;
}

export interface Invocation {
	command: string;
	args: string[];
	/** Written to the child's stdin and closed. Absent means the child gets no stdin at all. */
	input?: string;
}

/**
 * Live calls keyed by id. Pi fixtures may omit ids, so an unidentified end clears all Pi activity;
 * Claude calls are always identified and therefore preserve concurrently running siblings.
 */
export interface ActivityTracker {
	start(id: string | undefined, tool: string, detail?: string): void;
	end(id: string | undefined, failed?: boolean): void;
	/** Reported thinking. Native Claude supplies a token estimate; Pi supplies only the event. */
	think(tokens?: number): void;
	idle(): void;
}

export function createActivityTracker(result: RunResult): ActivityTracker {
	// Entries point into `result.steps`, so completion updates the step that originally started.
	const live = new Map<string, Step>();
	let unidentified: Step | undefined;
	let isThinking = false;
	let thinkingTokens: number | undefined;

	const refresh = () => {
		const running = [...live.values(), ...(unidentified ? [unidentified] : [])];
		if (running.length) {
			result.activity = {
				kind: "tools",
				label: running.map((step) => (step.detail ? `${step.tool}(${step.detail})` : step.tool)).join(", "),
			};
			return;
		}
		if (!isThinking) {
			result.activity = undefined;
			return;
		}
		const next: RunActivity = { kind: "thinking" };
		if (thinkingTokens !== undefined) next.tokens = thinkingTokens;
		result.activity = next;
	};

	return {
		start(id, tool, detail) {
			isThinking = false;
			const step: Step = { tool, detail };
			result.steps.push(step);
			if (id) live.set(id, step);
			else unidentified = step;
			refresh();
		},
		think(tokens) {
			isThinking = true;
			if (tokens !== undefined) thinkingTokens = tokens;
			refresh();
		},
		idle() {
			isThinking = false;
			refresh();
		},
		end(id, failed) {
			const finish = (step: Step) => {
				step.outcome = failed ? "failed" : "ok";
			};
			if (id) {
				const step = live.get(id);
				if (step) finish(step);
				live.delete(id);
			} else {
				for (const step of live.values()) finish(step);
				live.clear();
				if (unidentified) finish(unidentified);
				unidentified = undefined;
			}
			refresh();
		},
	};
}

function suppliedSystemPrompt(agent: Agent, inherited: Inherited): string {
	return [inherited.appendSystemPrompt?.trim(), agent.systemPrompt]
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
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

/** A runtime owns child invocation and decoding; all later code sees only `ChildEvent`. */
export interface Runtime {
	name: "pi" | "claude";
	invoke(
		agent: Agent,
		task: string,
		inherited: Inherited,
		model?: string,
		nativeClaude?: NativeClaudeOptions,
	): Invocation;
	decode(value: JsonValue): ChildEvent[];
}

/**
 * Exact model names only. Claude aliases can select a different family under `-p`, so accepting an
 * alias would make the requested runtime ambiguous.
 */
const CLAUDE_MODELS = new Set([
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-fable-5",
	"claude-haiku-4-5-20251001",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-sonnet-4-6",
	"claude-opus-4-6",
]);
export const CLAUDE_MODEL_NAMES = [...CLAUDE_MODELS].sort();

export function delegateModelNames(piModels: string[], includeNativeClaude: boolean): string[] {
	return [...new Set([...piModels, ...(includeNativeClaude ? CLAUDE_MODEL_NAMES : [])])];
}

export function childEnvironment(
	runtime: Runtime["name"],
	env: NodeJS.ProcessEnv = process.env,
	resultTool?: string,
): NodeJS.ProcessEnv {
	if (runtime !== "pi" || (!env[SSH_DESCRIPTOR_ENV] && resultTool === undefined)) return env;
	const childEnv = { ...env };
	if (env[SSH_DESCRIPTOR_ENV]) childEnv[DELEGATE_CHILD_ENV] = "1";
	if (resultTool !== undefined) childEnv[RESULT_TOOL_ENV] = resultTool;
	return childEnv;
}

/** Delegation depth is exactly one; grandchildren would create unbounded fan-out and spend. */
const NEVER_IN_CHILD = ["delegate"];
const CLAUDE_TOOLS = new Map<string, string>([
	["read", "Read"],
	["grep", "Grep"],
	["find", "Glob"],
	["ls", "Glob"],
	["bash", "Bash"],
	["host_bash", "Bash"],
	["edit", "Edit"],
	["write", "Write"],
	["web_search", "WebSearch"],
	["fetch_content", "WebFetch"],
]);

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

function addUsage(total: Usage, next: Usage): void {
	for (const key of COUNT_KEYS) total[key] += next[key];
	for (const key of COST_KEYS) total.cost[key] += next.cost[key];
}

function requiredStringField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (!isString(value)) throw new Error(`${context}.${field} must be a string`);
	return value;
}

function optionalStringField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isString(value)) throw new Error(`${context}.${field} must be a string`);
	return value;
}

function optionalNumberField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isNumber(value)) throw new Error(`${context}.${field} must be a number`);
	return value;
}

function optionalBooleanField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isBoolean(value)) throw new Error(`${context}.${field} must be a boolean`);
	return value;
}

function requiredObjectField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (!isJsonObject(value)) throw new Error(`${context}.${field} must be an object`);
	return value;
}

function optionalObjectField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) throw new Error(`${context}.${field} must be an object`);
	return value;
}

function requiredArrayField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (!isJsonArray(value)) throw new Error(`${context}.${field} must be an array`);
	return value;
}

function optionalArrayField(object: JsonObject, field: string, context: string) {
	const value = object[field];
	if (value === undefined) return undefined;
	if (!isJsonArray(value)) throw new Error(`${context}.${field} must be an array`);
	return value;
}

function decodeUsage(value: JsonValue, context: string): Usage {
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

function decodeTextContent(content: JsonValue[], context: string, ignoredTypes: Set<string>) {
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

export function preview(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PI_CONTENT_IGNORED = new Set(["thinking", "toolCall"]);
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

function decodePiMessage(event: JsonObject): ChildEvent[] {
	const message = requiredObjectField(event, "message", "pi message_end");
	const role = requiredStringField(message, "role", "pi message_end.message");
	if (["user", "toolResult", "bashExecution", "custom"].includes(role)) return [{ kind: "ignored" }];
	if (["branchSummary", "compactionSummary"].includes(role)) return [{ kind: "ignored" }];
	if (role !== "assistant") throw new Error(`unknown pi message role ${JSON.stringify(role)}`);
	const content = requiredArrayField(message, "content", "pi message_end.message");
	const usageValue = message.usage;
	const normalized: ChildEvent = {
		kind: "pi-message",
		text: decodeTextContent(content, "pi message_end.message.content", PI_CONTENT_IGNORED),
		provider: optionalStringField(message, "provider", "pi message_end.message"),
		model: optionalStringField(message, "model", "pi message_end.message"),
		stopReason: optionalStringField(message, "stopReason", "pi message_end.message"),
		errorMessage: optionalStringField(message, "errorMessage", "pi message_end.message"),
	};
	if (usageValue !== undefined) normalized.usage = decodeUsage(usageValue, "pi message_end.message.usage");
	return [normalized];
}

function decodePiToolEnd(event: JsonObject): ChildEvent[] {
	const result = optionalObjectField(event, "result", "pi tool_execution_end");
	let details: JsonPayload = { kind: "absent" };
	if (result && Object.hasOwn(result, "details")) details = { kind: "present", value: result.details };
	const normalized: ChildEvent = {
		kind: "tool-end",
		id: optionalStringField(event, "toolCallId", "pi tool_execution_end"),
		tool: optionalStringField(event, "toolName", "pi tool_execution_end"),
		failed: optionalBooleanField(event, "isError", "pi tool_execution_end") ?? false,
		details,
	};
	return [normalized];
}

function decodePi(value: JsonValue): ChildEvent[] {
	if (!isJsonObject(value)) throw new Error("pi event must be an object");
	const type = requiredStringField(value, "type", "pi event");
	switch (type) {
		case "message_update": {
			const update = requiredObjectField(value, "assistantMessageEvent", "pi message_update");
			const updateType = requiredStringField(update, "type", "pi message_update.assistantMessageEvent");
			switch (updateType) {
				case "thinking_delta":
					return [{ kind: "thinking" }];
				case "thinking_end":
					return [{ kind: "idle" }];
				case "start":
				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
				case "done":
				case "error":
					return [{ kind: "ignored" }];
				default:
					throw new Error(`unknown pi assistant message event type ${JSON.stringify(updateType)}`);
			}
		}
		case "tool_execution_start":
			return [{
				kind: "tool-start",
				id: optionalStringField(value, "toolCallId", "pi tool_execution_start"),
				tool: requiredStringField(value, "toolName", "pi tool_execution_start"),
				detail: stepDetail(optionalObjectField(value, "args", "pi tool_execution_start")),
			}];
		case "tool_execution_end":
			return decodePiToolEnd(value);
		case "message_end":
			return decodePiMessage(value);
		case "session":
			requiredStringField(value, "id", "pi session");
			requiredStringField(value, "timestamp", "pi session");
			requiredStringField(value, "cwd", "pi session");
			optionalNumberField(value, "version", "pi session");
			optionalStringField(value, "parentSession", "pi session");
			return [{ kind: "ignored" }];
		case "agent_start":
		case "agent_end":
		case "agent_settled":
		case "turn_start":
		case "turn_end":
		case "message_start":
		case "tool_execution_update":
		case "queue_update":
		case "compaction_start":
		case "compaction_end":
		case "entry_appended":
		case "session_info_changed":
		case "thinking_level_changed":
		case "auto_retry_start":
		case "auto_retry_end":
		case "summarization_retry_scheduled":
		case "summarization_retry_attempt_start":
		case "summarization_retry_finished":
		case "bash_execution_update":
			return [{ kind: "ignored" }];
		default:
			throw new Error(`unknown pi event type ${JSON.stringify(type)}`);
	}
}

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

function decodeClaude(value: JsonValue): ChildEvent[] {
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

export function stringifyJson(value: JsonValue): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("JSON value could not be serialized");
	return serialized;
}

export function consumeChildEvent(event: ChildEvent, result: RunResult, activity: ActivityTracker): boolean {
	switch (event.kind) {
		case "ignored":
			return false;
		case "observed":
			return true;
		case "thinking":
			activity.think(event.tokens);
			return true;
		case "idle":
			activity.idle();
			return true;
		case "tool-start":
			activity.start(event.id, event.tool, event.detail);
			return true;
		case "tool-end":
			activity.end(event.id, event.failed);
			return true;
		case "assistant-text":
			if (event.text.trim()) result.output = event.text;
			return true;
		case "pi-message":
			activity.idle();
			result.turns += 1;
			if (event.provider !== undefined) result.provider = event.provider;
			if (event.model !== undefined) result.model = event.model;
			result.stopReason = event.stopReason;
			result.errorMessage = event.errorMessage;
			if (event.usage) addUsage(result.usage, event.usage);
			result.output = event.text;
			return true;
		case "claude-init":
			result.model = event.model;
			return true;
		case "claude-result":
			if (event.turns !== undefined) result.turns = event.turns;
			result.output = event.output.kind === "present" ? stringifyJson(event.output.value) : event.text;
			result.usage = event.usage;
			result.stopReason = event.stopReason;
			result.errorMessage = event.errorMessage;
			return true;
	}
}

export type OutcomeKind = "success" | "cancelled" | "aborted" | "model-error" | "invalid-response" | "length";

export interface ResultOutcome {
	kind: OutcomeKind;
	label: string;
	message?: string;
}

export function modelLabel(result: RunResult): string | undefined {
	if (result.provider && result.model) {
		return result.model.startsWith(`${result.provider}/`) ? result.model : `${result.provider}/${result.model}`;
	}
	return result.model ?? result.provider;
}

function errorContext(result: RunResult): string {
	const model = modelLabel(result);
	return model ? ` (${model})` : "";
}

export function classifyResult(result: RunResult): ResultOutcome {
	const context = errorContext(result);
	const detail = result.errorMessage?.trim() || undefined;
	const suffix = detail ? `: ${detail}` : ".";

	if (result.termination === "cancelled") {
		return { kind: "cancelled", label: "cancelled", message: `${result.agent} was cancelled.` };
	}
	if (result.stopReason === "length") {
		return {
			kind: "length",
			label: "output limit",
			message: `${result.agent} exceeded its output limit${context}. Retry with a narrower task or request a shorter response.`,
		};
	}
	if (result.stopReason === "aborted") {
		return {
			kind: "aborted",
			label: "timeout/abort",
			message: `${result.agent} timed out or was aborted${context}${suffix}`,
		};
	}
	if (result.stopReason === "error") {
		return {
			kind: "model-error",
			label: "model error",
			message: `${result.agent} model error${context}${suffix}`,
		};
	}
	if (result.stopReason !== "stop" || !result.output.trim()) {
		const reason = detail ?? (result.stopReason ? `unexpected stop reason: ${result.stopReason}` : undefined);
		return {
			kind: "invalid-response",
			label: "no usable text",
			message: `${result.agent} returned no usable final text${context}${reason ? `: ${reason}` : "."} Retry; if this persists, check the model/provider.`,
		};
	}
	return { kind: "success", label: "completed" };
}

/** Translate the exact Pi capability list to Claude names, failing on an unmapped grant. */
export function claudeTools(agent: Agent): string[] {
	const allowed = new Set<string>();
	for (const tool of agent.tools) {
		if (NEVER_IN_CHILD.includes(tool)) continue;
		const mapped = CLAUDE_TOOLS.get(tool);
		if (!mapped) throw new Error(`tool ${tool} has no claude equivalent`);
		allowed.add(mapped);
	}
	if (agent.skills === "all") allowed.add("Skill");
	return [...allowed].sort();
}

const claudeRuntime: Runtime = {
	name: "claude",

	invoke(agent, task, inherited, model, nativeClaude) {
		// Claude keeps only the final repeated system-prompt flag, so inherited and role text travel
		// together as one argument.
		const systemPrompt = suppliedSystemPrompt(agent, inherited);
		const tools = claudeTools(agent).join(",");
		const args = [
			"-p",
			"--verbose",
			"--output-format",
			"stream-json",
			"--strict-mcp-config",
			"--append-system-prompt",
			systemPrompt,
		];
		if (inherited.sessionId) {
			args.push(inherited.resume ? "--resume" : "--session-id", inherited.sessionId);
		} else {
			args.push("--no-session-persistence");
		}
		if (model) args.push("--model", model);
		if (agent.skills === "none") args.push("--safe-mode", "--disable-slash-commands");
		if (nativeClaude?.effort) args.push("--effort", nativeClaude.effort);
		if (nativeClaude?.jsonSchema) args.push("--json-schema", JSON.stringify(nativeClaude.jsonSchema));
		// Availability and permission are separate grants; pin both to the agent capability.
		args.push("--permission-mode", "acceptEdits");
		args.push("--allowed-tools", tools);
		args.push("--tools", tools);
		// Stdin avoids variadic tool flags swallowing the positional prompt.
		return { command: "claude", args, input: `Task: ${task}` };
	},

	decode: decodeClaude,
};

const piRuntime: Runtime = {
	name: "pi",

	invoke(agent, task, inherited, requestedModel) {
		const args = ["--mode", "json", "-p"];
		if (inherited.sessionDir) args.push("--session-dir", inherited.sessionDir);
		if (inherited.sessionId) {
			args.push(inherited.resume ? "--session" : "--session-id", inherited.sessionId);
		}
		if (inherited.appendSystemPrompt?.trim()) {
			args.push("--append-system-prompt", inherited.appendSystemPrompt);
		}
		args.push("--append-system-prompt", agent.systemPrompt);
		const tools = agent.tools.filter((tool) => !NEVER_IN_CHILD.includes(tool));
		// Omission would activate Pi's default tools, so an empty capability needs `--no-tools`.
		args.push(...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]));
		const model = requestedModel ?? inherited.model;
		if (model) args.push("--model", model);
		if (inherited.thinkingLevel) args.push("--thinking", inherited.thinkingLevel);
		if (agent.skills === "none") args.push("--no-skills");
		// Stdin avoids the operating system argument-size limit for review tasks containing patches.
		return { ...piInvocation(args), input: `Task: ${task}` };
	},

	decode: decodePi,
};

export function piInvocation(args: string[]): Invocation {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * The model name selects the runtime. Reject unknown bare Claude names instead of quietly routing
 * a typo through Pi; provider-qualified Claude models intentionally remain Pi models.
 */
export function selectRuntime(model: string | undefined): Runtime {
	if (!model) return piRuntime;
	if (CLAUDE_MODELS.has(model)) return claudeRuntime;
	if (!model.includes("/") && model.startsWith("claude-")) {
		throw new Error(`unknown claude model ${model}; known: ${[...CLAUDE_MODELS].sort().join(", ")}`);
	}
	return piRuntime;
}
