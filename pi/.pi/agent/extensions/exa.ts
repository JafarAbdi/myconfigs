import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_BODY_MAX = 500;
const SEARCH_RESULTS_MAX = 10;
const FETCH_URLS_MAX = 5;
const PAGE_CHARACTERS_MAX = 20_000;

interface JsonRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

let nextRequestId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRpcResponse(body: string): JsonRpcResponse {
	const candidates = body.trimStart().startsWith("{")
		? [body]
		: body
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.filter((line) => line && line !== "[DONE]");

	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (isRecord(parsed)) return parsed as JsonRpcResponse;
		} catch {
			// A later SSE event may contain the JSON-RPC response.
		}
	}
	throw new Error("Exa returned no valid JSON-RPC response");
}

function extractText(response: JsonRpcResponse): string {
	if (response.error) {
		const code = response.error.code === undefined ? "unknown" : String(response.error.code);
		throw new Error(`Exa error ${code}: ${response.error.message ?? "unknown error"}`);
	}
	const text = response.result?.content
		?.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n\n")
		.trim();
	if (!text) throw new Error("Exa returned no text content");
	return text;
}

async function callExa(
	tool: "web_search_exa" | "web_fetch_exa",
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<string> {
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: nextRequestId++,
			method: "tools/call",
			params: { name: tool, arguments: args },
		}),
		signal: requestSignal,
	});
	const body = await response.text();
	if (!response.ok) {
		const detail = body.trim().slice(0, ERROR_BODY_MAX);
		throw new Error(
			`Exa HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
		);
	}
	return extractText(parseJsonRpcResponse(body));
}

function formatOutput(text: string): string {
	const truncation = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Exa output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown.]`;
}

function validateUrls(urls: string[]): void {
	for (const value of urls) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error(`Invalid URL: ${value}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`Unsupported URL protocol: ${url.protocol}`);
		}
	}
}

const exaSearch = defineTool({
	name: "exa_search",
	label: "Exa search",
	description: "Search the public web through Exa. Returns current sources with URLs and relevant text.",
	promptSnippet: "Search the public web through Exa",
	parameters: Type.Object(
		{
			query: Type.String({ minLength: 1, description: "Natural-language description of the information to find" }),
			numResults: Type.Optional(
				Type.Integer({ minimum: 1, maximum: SEARCH_RESULTS_MAX, description: "Number of results (default: 10)" }),
			),
		},
		{ additionalProperties: false },
	),
	async execute(_toolCallId, params, signal) {
		const query = params.query.trim();
		if (!query) throw new Error("Search query must not be empty");
		const text = await callExa(
			"web_search_exa",
			{
				query,
				...(params.numResults === undefined ? {} : { numResults: params.numResults }),
			},
			signal,
		);
		return {
			content: [{ type: "text", text: formatOutput(text) }],
			details: { query, numResults: params.numResults ?? 10 },
		};
	},
});

const exaFetch = defineTool({
	name: "exa_fetch",
	label: "Exa fetch",
	description: "Fetch clean Markdown content from one or more public web URLs through Exa.",
	promptSnippet: "Fetch readable content from public web URLs through Exa",
	parameters: Type.Object(
		{
			urls: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: FETCH_URLS_MAX,
				description: "HTTP or HTTPS URLs to fetch",
			}),
			maxCharacters: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: PAGE_CHARACTERS_MAX,
					description: "Maximum characters to extract per page (default: 3000)",
				}),
			),
		},
		{ additionalProperties: false },
	),
	async execute(_toolCallId, params, signal) {
		validateUrls(params.urls);
		const text = await callExa(
			"web_fetch_exa",
			{
				urls: params.urls,
				...(params.maxCharacters === undefined ? {} : { maxCharacters: params.maxCharacters }),
			},
			signal,
		);
		return {
			content: [{ type: "text", text: formatOutput(text) }],
			details: { urls: params.urls, maxCharacters: params.maxCharacters ?? 3000 },
		};
	},
});

export default function (pi: ExtensionAPI): void {
	pi.registerTool(exaSearch);
	pi.registerTool(exaFetch);
}
