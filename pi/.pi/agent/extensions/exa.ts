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

const webSearch = defineTool({
	name: "web_search",
	label: "Web search",
	description: "Search the public web through Exa. Prefer 2–4 varied queries for broad research.",
	promptSnippet: "Search the public web; prefer {queries:[...]} with varied research angles",
	parameters: Type.Object(
		{
			query: Type.Optional(Type.String({ minLength: 1, description: "One search query" })),
			queries: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					minItems: 1,
					maxItems: 4,
					description: "Two to four varied search queries",
				}),
			),
			numResults: Type.Optional(
				Type.Integer({ minimum: 1, maximum: SEARCH_RESULTS_MAX, description: "Results per query (default: 10)" }),
			),
			workflow: Type.Optional(Type.String({ description: "Use 'none'; Exa returns raw results without curation" })),
		},
		{ additionalProperties: false },
	),
	async execute(_toolCallId, params, signal) {
		if (params.workflow !== undefined && params.workflow !== "none") {
			throw new Error("web_search supports only workflow: 'none'");
		}
		const rawQueries = params.queries ?? (params.query === undefined ? [] : [params.query]);
		const queries = rawQueries.map((query) => query.trim()).filter(Boolean);
		if (queries.length === 0) throw new Error("Provide query or queries");

		const sections: string[] = [];
		for (const query of queries) {
			const text = await callExa(
				"web_search_exa",
				{
					query,
					...(params.numResults === undefined ? {} : { numResults: params.numResults }),
				},
				signal,
			);
			sections.push(queries.length === 1 ? text : `## Query: ${query}\n\n${text}`);
		}
		return {
			content: [{ type: "text", text: formatOutput(sections.join("\n\n---\n\n")) }],
			details: { queries, numResults: params.numResults ?? 10 },
		};
	},
});

const fetchContent = defineTool({
	name: "fetch_content",
	label: "Fetch content",
	description: "Fetch clean Markdown content from one or more public web URLs through Exa.",
	promptSnippet: "Fetch readable content from public web URLs",
	parameters: Type.Object(
		{
			url: Type.Optional(Type.String({ minLength: 1, description: "One HTTP or HTTPS URL" })),
			urls: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					minItems: 1,
					maxItems: FETCH_URLS_MAX,
					description: "HTTP or HTTPS URLs to fetch",
				}),
			),
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
		const urls = params.urls ?? (params.url === undefined ? [] : [params.url]);
		if (urls.length === 0) throw new Error("Provide url or urls");
		validateUrls(urls);
		const text = await callExa(
			"web_fetch_exa",
			{
				urls,
				...(params.maxCharacters === undefined ? {} : { maxCharacters: params.maxCharacters }),
			},
			signal,
		);
		return {
			content: [{ type: "text", text: formatOutput(text) }],
			details: { urls, maxCharacters: params.maxCharacters ?? 3000 },
		};
	},
});

export default function (pi: ExtensionAPI): void {
	pi.registerTool(webSearch);
	pi.registerTool(fetchContent);
}
