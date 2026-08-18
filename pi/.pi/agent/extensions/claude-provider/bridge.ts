/**
 * Per-turn bridge: pi's main loop calls streamSimple → we run one host-local `claude` turn with its
 * built-in tools replaced by our MCP server, decode its stream-json, and re-emit pi assistant events.
 *
 * Agent-as-a-turn: claude runs its whole internal loop. With --include-partial-messages it emits
 * Anthropic-style partial frames (`stream_event`), so we stream its thinking, narration, and answer
 * live — token by token — into pi text/thinking blocks (merged by kind). Tool calls surface as inline
 * word-form markers (`read <path>`, `$ <command>`). Only the `system` (init) and `result` envelopes
 * are decoded — the non-partial `assistant`/`user` frames repeat streamed content and are ignored.
 *
 * Why a CLI can back a pi model at all: pi's `streamSimple` provider seam is code-level, not an HTTP
 * endpoint. Auth is entirely the claude CLI's own session — pi resolves no Claude credentials
 * (index.ts's baseUrl/apiKey are inert placeholders that only satisfy registration). Each turn spawns
 * a fresh `claude -p`, which re-reads CLAUDE.md/skills (~seconds of startup); a long-lived
 * `--input-format stream-json` process is the lever if that latency ever matters.
 *
 * SSH: when PI_SSH_DESCRIPTOR is present it rides into the MCP server's env so tools run on the remote
 * (claude stays on the host); an unusable descriptor fails the stream rather than running on the host.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	decodeClaude,
	emptyUsage,
	isJsonObject,
	isNumber,
	isString,
	type JsonObject,
	type JsonValue,
	optionalNumberField,
	optionalObjectField,
	stepDetail,
} from "../lib/claude-stream.ts";
import { parseSshConnectionDescriptor, SSH_DESCRIPTOR_ENV } from "../ssh/descriptor.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(EXT_DIR, "mcp-server.ts");
// The MCP server is a bare `node` child pi does not load, so it cannot resolve pi's package by bare
// specifier. Resolve pi's entry here — inside pi, where it does resolve — and hand the child the
// absolute URL via env; the child dynamic-imports it to reuse pi's own read/write/edit tools.
const PI_CODING_AGENT_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent");
// claude's only tools. In SSH mode host_bash is added so host-local files (a pasted clipboard image,
// pi config) stay reachable while the rest target the remote — parity with pi's ssh extension.
//
// A fixed allowlist, not pi's `context.tools`: claude runs these tools itself (inside its own loop),
// so pi's permission hooks (permission-gate, protected-paths) never fire on a claude-cli turn.
// Intersecting with context.tools would restore them, but pi gives extensions no way to execute its
// tools, so enforcement would have to be reimplemented here — deferred; acceptable for a self-driven CLI.
const BASE_TOOLS = [
	"mcp__pi__bash",
	"mcp__pi__read",
	"mcp__pi__write",
	"mcp__pi__edit",
	"mcp__pi__ls",
	"mcp__pi__find",
	"mcp__pi__grep",
	// claude's native web tools — parity with pi's own web_search + fetch_content. These are claude
	// built-ins (not MCP): server-side search / public fetch, machine-independent, so they work the
	// same locally and under SSH (no filesystem, nothing to forward through the remote).
	"WebSearch",
	"WebFetch",
];

// The mcp.json carries the SSH descriptor (when present) into the server's env, so the server runs
// tools on the remote. The filename is scoped to this pid so two concurrent pi processes targeting
// different remotes can't clobber each other's descriptor between write and claude's read.
// process.execPath is the node running pi — a stable interpreter.
function mcpConfigFor(descriptor: string | undefined): string {
	const dir = join(tmpdir(), "pi-claude-cli");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `mcp-${process.pid}-${descriptor ? "ssh" : "local"}.json`);
	const env = descriptor
		? { PI_CODING_AGENT_ENTRY, [SSH_DESCRIPTOR_ENV]: descriptor }
		: { PI_CODING_AGENT_ENTRY };
	const config = {
		mcpServers: {
			pi: { command: process.execPath, args: ["--experimental-strip-types", MCP_SERVER], env },
		},
	};
	writeFileSync(path, JSON.stringify(config, null, 2));
	return path;
}

function messageText(content: string | { type: string; text?: string }[]): string {
	if (!Array.isArray(content)) return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function latestUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role === "user") return messageText(message.content);
	}
	return "";
}

/**
 * A fresh claude session has no memory of pi's prior turns, so we seed it with the whole conversation
 * as a plain transcript — the same shape pi's own openai-codex provider uses on a fresh connection
 * (full input, then continuation). Tool-result and other internal roles are claude's own concern and
 * are omitted from the seed. Once a claude session exists we send only the newest message and resume.
 */
function serializeTranscript(context: Context): string {
	const lines: string[] = [];
	for (const message of context.messages) {
		if (message.role === "user") lines.push(`User: ${messageText(message.content)}`);
		else if (message.role === "assistant") lines.push(`Assistant: ${messageText(message.content)}`);
	}
	return lines.join("\n\n");
}

function buildPrompt(context: Context, sendFullHistory: boolean): string {
	if (sendFullHistory && context.messages.length > 1) return serializeTranscript(context);
	return latestUserText(context);
}

interface ImagePart {
	mimeType: string;
	data: string;
}

/** Base64 images pasted into the newest user message. pi delivers them as ImageContent, not paths. */
function latestUserImages(context: Context): ImagePart[] {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		if (!Array.isArray(message.content)) return [];
		return message.content
			.filter((block): block is { type: "image"; data: string; mimeType: string } => block.type === "image")
			.map((block) => ({ mimeType: block.mimeType, data: block.data }));
	}
	return [];
}

/**
 * One stream-json user turn carrying text and/or pasted images (base64). Used only when the message
 * has images: claude `-p` over plain stdin has no image channel, so we switch to
 * `--input-format stream-json`, which forwards the images to claude's vision independent of any
 * filesystem — so a paste works identically locally and over SSH (the data is in the message, not a
 * host file a remote read couldn't reach).
 */
function streamJsonUserMessage(text: string, images: ImagePart[]): string {
	const content: JsonValue[] = [];
	if (text) content.push({ type: "text", text });
	for (const image of images) {
		content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
	}
	return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/**
 * Per pi-session claude session state, so established turns resume claude's own memory instead of
 * re-sending history. Keyed by session + remote target. `lastUserKey` is the identity of the newest
 * user message on the last successful turn: a re-call whose newest message is unchanged is pi
 * retrying, so we fork from the last good state rather than double-appending it. Using the message
 * identity (not a count) stays correct across compaction and edits, which rewrite history but not
 * which message is newest. In-memory — interactive pi is one long-lived process.
 */
const SESSIONS = new Map<string, { sessionId: string; lastUserKey: string }>();

function baseMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

// pi's thinking level → claude's --effort. pi delivers the level as options.reasoning ("off" arrives
// as undefined). claude has no "minimal", so it maps to "low"; the rest pass through. Absent/unknown
// → omit the flag and let claude use its default effort.
const EFFORT_BY_LEVEL = new Map([
	["minimal", "low"],
	["low", "low"],
	["medium", "medium"],
	["high", "high"],
	["xhigh", "xhigh"],
	["max", "max"],
]);
function claudeEffort(level: string | undefined): string | undefined {
	return level === undefined ? undefined : EFFORT_BY_LEVEL.get(level);
}

/**
 * claude's result envelope carries both the run total (`modelUsage`, summed over every internal turn)
 * and the final turn (top-level `usage`, snake_case). As pi's main provider we report the **final
 * turn**: pi derives "context used" from `usage.totalTokens` to drive the indicator and
 * compaction/overflow, and the final turn ≈ claude's real current context fill, whereas the run total
 * would over-report by a multiple and trigger spurious compaction. Cost is the whole run's cost.
 *
 * Returns undefined when the envelope has no top-level `usage` object, so the caller falls back to
 * the run total (`event.usage`) rather than reporting zero. Absent counters within a present `usage`
 * read as 0; a counter present with a non-numeric value is a wire-format break and throws.
 */
function finalTurnUsage(raw: JsonObject): Usage | undefined {
	const turn = optionalObjectField(raw, "usage", "claude result");
	if (!turn) return undefined;
	const usage = emptyUsage();
	const context = "claude result.usage";
	usage.input = optionalNumberField(turn, "input_tokens", context) ?? 0;
	usage.output = optionalNumberField(turn, "output_tokens", context) ?? 0;
	usage.cacheRead = optionalNumberField(turn, "cache_read_input_tokens", context) ?? 0;
	usage.cacheWrite = optionalNumberField(turn, "cache_creation_input_tokens", context) ?? 0;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.cost.total = optionalNumberField(raw, "total_cost_usd", "claude result") ?? 0;
	return usage;
}

export function runClaudeTurn(
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void drive(model, context, options, stream).catch((error) => {
		stream.push({
			type: "error",
			reason: "error",
			error: {
				...baseMessage(model),
				stopReason: "error",
				errorMessage: `claude-cli bridge failed: ${error instanceof Error ? error.message : String(error)}`,
			},
		});
	});
	return stream;
}

async function drive(
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const partial = baseMessage(model);
	let started = false;
	let settled = false;
	let observedSessionId: string | undefined;
	let finalUsage: Usage | undefined;
	// One open pi content block at a time, merged by kind: a new kind closes the current block and
	// opens the next, so claude's interleaved thinking/text/tool markers become an ordered block list.
	let openKind: "text" | "thinking" | undefined;
	let openText = "";

	const snapshot = (): AssistantMessage => ({
		...partial,
		content: partial.content.map((block) => ({ ...block })),
		usage: { ...partial.usage, cost: { ...partial.usage.cost } },
	});
	const ensureStart = (): void => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: snapshot() });
	};
	const closeBlock = (): void => {
		if (openKind === undefined) return;
		const index = partial.content.length - 1;
		if (openKind === "text") stream.push({ type: "text_end", contentIndex: index, content: openText, partial: snapshot() });
		else stream.push({ type: "thinking_end", contentIndex: index, content: openText, partial: snapshot() });
		openKind = undefined;
		openText = "";
	};
	const appendDelta = (kind: "text" | "thinking", delta: string): void => {
		if (!delta) return;
		ensureStart();
		if (openKind !== kind) {
			closeBlock();
			openKind = kind;
			openText = "";
			partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			const index = partial.content.length - 1;
			if (kind === "text") stream.push({ type: "text_start", contentIndex: index, partial: snapshot() });
			else stream.push({ type: "thinking_start", contentIndex: index, partial: snapshot() });
		}
		openText += delta;
		const index = partial.content.length - 1;
		partial.content[index] = kind === "text" ? { type: "text", text: openText } : { type: "thinking", thinking: openText };
		if (kind === "text") stream.push({ type: "text_delta", contentIndex: index, delta, partial: snapshot() });
		else stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: snapshot() });
	};
	const fail = (errorMessage: string, reason: "error" | "aborted" = "error"): void => {
		if (settled) return;
		settled = true;
		closeBlock();
		stream.push({ type: "error", reason, error: { ...snapshot(), stopReason: reason, errorMessage } });
	};

	const latest = latestUserText(context).trim();
	const images = latestUserImages(context);
	if (!latest && images.length === 0) {
		fail("no user message to send to claude");
		return;
	}

	// SSH mode is detected at dispatch (not registration): the ssh extension can connect after we
	// registered. When active, the descriptor rides into the MCP server's env so tools run on the
	// remote. An unusable descriptor means we cannot honor the remote, so fail loud rather than
	// silently run against the host — the load-bearing safety property of this design. The descriptor
	// is decoded by the ssh extension's own parser, so the bridge and the MCP server agree on exactly
	// what a usable descriptor is.
	const descriptor = process.env[SSH_DESCRIPTOR_ENV];
	let remoteKey = "local";
	if (descriptor) {
		try {
			const parsed = parseSshConnectionDescriptor(descriptor);
			remoteKey = `${parsed.remote}:${parsed.remoteCwd}`;
		} catch (error) {
			fail(`SSH is active but its descriptor is unusable (${error instanceof Error ? error.message : String(error)}); refusing to run against the host`);
			return;
		}
	}
	const allowedTools = (descriptor ? [...BASE_TOOLS, "mcp__pi__host_bash"] : BASE_TOOLS).join(",");

	// Session strategy. With a pi session id we persist and resume claude's own memory across turns;
	// without one (e.g. a bare `pi -p`) we run a single ephemeral turn. The key includes the remote
	// target so switching machines never resumes a session whose context is about a different one.
	const piSessionId = options?.sessionId;
	let sessionArgs: string[];
	let sendFullHistory: boolean;
	let commitSession: ((observed: string | undefined) => void) | undefined;
	if (piSessionId) {
		const sessionKey = `${piSessionId}::${remoteKey}`;
		const entry = SESSIONS.get(sessionKey);
		let baseId: string;
		if (!entry) {
			// No claude session yet (new conversation, pi restart, or a switch to this model): start one
			// and seed it with the full conversation so nothing prior is lost.
			baseId = randomUUID();
			sessionArgs = ["--session-id", baseId];
			sendFullHistory = true;
		} else if (entry.lastUserKey !== latest) {
			// A genuinely new newest message → continue claude's session with just that message.
			baseId = entry.sessionId;
			sessionArgs = ["--resume", baseId];
			sendFullHistory = false;
		} else {
			// Same newest message as the last successful turn ⇒ pi is retrying. Fork from the last good
			// state so the retried message is not appended twice into the canonical session.
			baseId = entry.sessionId;
			sessionArgs = ["--resume", baseId, "--fork-session"];
			sendFullHistory = false;
		}
		commitSession = (observed) => SESSIONS.set(sessionKey, { sessionId: observed ?? baseId, lastUserKey: latest });
	} else {
		sessionArgs = ["--no-session-persistence"];
		sendFullHistory = true;
	}

	const prompt = buildPrompt(context, sendFullHistory);

	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--mcp-config",
		mcpConfigFor(descriptor),
		"--strict-mcp-config",
		"--tools",
		allowedTools,
		"--allowed-tools",
		allowedTools,
		"--permission-mode",
		"acceptEdits",
		"--model",
		model.id,
		// pi's --system-prompt is the single source of instructions; load none of claude's own
		// settings/CLAUDE.md — they would duplicate what pi already put in the system prompt (claude
		// otherwise injects ~/.claude/CLAUDE.md as a system-reminder over pi's prompt). Empty drops
		// user/project/local sources but not OAuth (keychain), so subscription auth is unaffected —
		// unlike --bare, which forces ANTHROPIC_API_KEY. Must be "" (empty), NOT "project": a claude
		// bug (anthropics/claude-code#87590) still loads ~/.claude/CLAUDE.md under "project"; empty
		// gates it (content-verified).
		"--setting-sources",
		"",
		...sessionArgs,
	];
	// context.systemPrompt is pi's complete assembled prompt; replace claude's default rather than
	// append, so the session runs on exactly one system prompt (and one cwd claim in SSH mode).
	if (context.systemPrompt?.trim()) args.push("--system-prompt", context.systemPrompt);
	// Thinking level: pi's setting drives claude's reasoning depth.
	const effort = claudeEffort(options?.reasoning);
	if (effort) args.push("--effort", effort);
	// A pasted image can only reach claude through stream-json input (see streamJsonUserMessage).
	if (images.length > 0) args.push("--input-format", "stream-json");

	const child = spawn("claude", args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
	// Guard the early-return paths below: they leave before the close/error handlers are attached, and
	// an async spawn failure (e.g. `claude` not on PATH → ENOENT) would otherwise emit an unhandled
	// 'error' that can crash the pi process. The real error handler is added later and still runs.
	child.on("error", () => {});

	const signal = options?.signal;
	const onAbort = (): void => {
		if (settled) return;
		try {
			child.kill("SIGKILL");
		} catch {}
		fail("aborted", "aborted");
	};
	if (signal) {
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}

	// pi wires onResponse to its after_provider_response extension event; fire it once as the turn's
	// response begins. onPayload is intentionally unused — there is no HTTP request body to rewrite
	// for a CLI-backed provider.
	await options?.onResponse?.({ status: 200, headers: {} }, model);

	// pi executes tools by the presence of toolCall content blocks, and it has no mcp__pi__* tools of
	// its own — so we must NOT emit real tool calls (pi would try to run them). Instead each claude
	// tool call renders as a marker in the streamed thinking (`read <path>`, `$ <cmd>`). Args arrive
	// as input_json_delta frames, accumulated per block index and parsed at content_block_stop.
	const toolBlocks = new Map<number, { name: string; json: string }>();
	const emitToolMarker = (name: string, json: string): void => {
		const clean = name.replace(/^mcp__pi__/, "");
		// The marker is cosmetic: claude can stop mid-object, so unparsable args just lose the detail.
		let detail: string | undefined;
		try {
			detail = stepDetail(JSON.parse(json || "{}"));
		} catch {}
		// Match pi's own tool-line style: a word verb + the salient value, bash as `$ <cmd>`. (If the
		// user hides thinking, pi collapses the block and these markers hide with it — a known limit of
		// surfacing tool activity through content blocks rather than real tool calls.)
		const marker = clean === "bash" ? `$ ${detail ?? ""}`.trimEnd() : `${clean}${detail ? ` ${detail}` : ""}`;
		appendDelta("thinking", `\n\n${marker}\n\n`);
	};
	// Anthropic-style partial frame → stream thinking/text deltas and tool markers live.
	const handleStreamEvent = (event: JsonValue): void => {
		if (settled || !isJsonObject(event)) return;
		const index = isNumber(event.index) ? event.index : -1;
		switch (event.type) {
			case "message_start":
				toolBlocks.clear(); // Block indices reset each turn.
				return;
			case "content_block_start": {
				const block = event.content_block;
				if (isJsonObject(block) && block.type === "tool_use" && isString(block.name) && index >= 0) {
					toolBlocks.set(index, { name: block.name, json: "" });
				}
				return;
			}
			case "content_block_delta": {
				const delta = event.delta;
				if (!isJsonObject(delta)) return;
				if (delta.type === "text_delta" && isString(delta.text)) appendDelta("text", delta.text);
				else if (delta.type === "thinking_delta" && isString(delta.thinking)) appendDelta("thinking", delta.thinking);
				else if (delta.type === "input_json_delta" && isString(delta.partial_json)) {
					const tool = toolBlocks.get(index);
					if (tool) tool.json += delta.partial_json;
				}
				return;
			}
			case "content_block_stop": {
				const tool = toolBlocks.get(index);
				if (tool) {
					emitToolMarker(tool.name, tool.json);
					toolBlocks.delete(index);
				}
				return;
			}
			default:
				return;
		}
	};

	const finishResult = (event: Extract<ReturnType<typeof decodeClaude>[number], { kind: "claude-result" }>): void => {
		if (settled) return;
		ensureStart();
		if (event.stopReason === "error") {
			settled = true;
			closeBlock();
			partial.stopReason = "error";
			partial.usage = finalUsage ?? event.usage; // A failed turn still spent tokens; report them.
			stream.push({ type: "error", reason: "error", error: { ...snapshot(), errorMessage: event.errorMessage ?? "claude reported an error" } });
			return;
		}
		// Fallback: if no partial content streamed (unexpected), surface the result text as one block.
		if (partial.content.length === 0 && event.text.trim()) appendDelta("text", event.text);
		closeBlock();
		partial.usage = finalUsage ?? event.usage;
		partial.stopReason = event.stopReason === "length" ? "length" : "stop";
		// Advance session state only on success, so a failed turn stays a retry (fork) next time.
		commitSession?.(observedSessionId);
		settled = true;
		stream.push({ type: "done", reason: partial.stopReason, message: snapshot() });
	};

	const stderrChunks: Buffer[] = [];
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
	if (child.stdin) {
		child.stdin.on("error", () => {});
		child.stdin.end(images.length > 0 ? streamJsonUserMessage(prompt, images) : prompt);
	}

	// One decoded frame. Every field it reads is validated, so a wire-format break throws out to the
	// reader below instead of being absorbed as a zero or a missing block.
	const consumeFrame = (raw: JsonValue): void => {
		if (!isJsonObject(raw)) return;
		if (isString(raw.session_id)) observedSessionId = raw.session_id;
		// Partial frames carry the live content we stream; the non-partial `assistant`/`user` frames
		// just repeat it, so they are ignored. Only `system` (init) and `result` are decoded:
		// decodeClaude throws on an unknown content-block type, and confining it to these two envelopes
		// keeps a newly-added claude message shape from failing the whole turn.
		if (raw.type === "stream_event") {
			handleStreamEvent(raw.event);
			return;
		}
		if (raw.type !== "system" && raw.type !== "result") return;
		// Report the final turn's tokens (context proxy), captured before decodeClaude runs.
		if (raw.type === "result") finalUsage = finalTurnUsage(raw);
		for (const event of decodeClaude(raw)) {
			if (settled) return;
			if (event.kind === "claude-init") partial.model = event.model;
			else if (event.kind === "claude-result") finishResult(event);
		}
	};

	createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed || settled) return;
		let raw: JsonValue;
		try {
			raw = JSON.parse(trimmed);
		} catch {
			// Deliberate: claude's stream is pure JSON, so a non-JSON line is a stray diagnostic — skip
			// it rather than fail the turn. A real failure still surfaces via stderr in the close handler.
			return;
		}
		try {
			consumeFrame(raw);
		} catch (error) {
			try {
				child.kill("SIGKILL");
			} catch {}
			fail(`claude stream decode failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	await new Promise<void>((resolve) => {
		child.once("error", (error) => {
			fail(`failed to spawn claude: ${error.message}`);
			resolve();
		});
		child.once("close", () => {
			if (!settled) {
				const diagnostic = Buffer.concat(stderrChunks).toString("utf8").trim();
				fail(diagnostic || "claude exited without a result");
			}
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}
