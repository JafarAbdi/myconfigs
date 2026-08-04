import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { AuditFinding } from "./audit.ts";
import {
	readGitReviewPatch,
	reviewSnapshotsEqual,
	type ReviewPatch,
} from "./review-git.ts";
import {
	DEFAULT_REVIEW_VIEW_OPTIONS,
	ReviewRenderer,
	reviewViewSearch,
	type ReviewAutoLayout,
	type ReviewViewOptions,
} from "./review-renderer.ts";
import {
	formatReviewFeedback,
	ReviewStateError,
	ReviewStore,
	type ReviewState,
} from "./review-state.ts";

const MAX_BODY_BYTES = 64 * 1_024;
const BROWSER_SCRIPT = readFileSync(new URL("./review-browser.js", import.meta.url), "utf8");
const REVIEW_CSS = readFileSync(new URL("./review.css", import.meta.url), "utf8");
const CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"connect-src 'self'",
	"img-src 'none'",
	"font-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"manifest-src 'none'",
	"worker-src 'none'",
].join("; ");

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export type ReviewServerDecision =
	| { kind: "approve"; decidedAt: string }
	| { kind: "send-feedback"; decidedAt: string; feedbackMarkdown: string }
	| { kind: "stale"; error: string };

export interface ReviewServer {
	url: string;
	decision: Promise<ReviewServerDecision>;
	close(): Promise<void>;
}

export interface CreateReviewServerOptions {
	patch: ReviewPatch;
	auditFindings: readonly AuditFinding[];
	view?: ReviewViewOptions;
	readPatch?: (repository: string) => Promise<ReviewPatch>;
}

function commonHeaders(contentType: string): Record<string, string> {
	return {
		"cache-control": "no-store",
		"content-security-policy": CSP,
		"content-type": contentType,
		"cross-origin-opener-policy": "same-origin",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	};
}

function send(
	response: ServerResponse,
	status: number,
	contentType: string,
	body: string,
): void {
	response.writeHead(status, {
		...commonHeaders(contentType),
		"content-length": Buffer.byteLength(body).toString(),
	});
	response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	send(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json")
		throw new HttpError(415, "request body must be application/json");
	const declared = Number(request.headers["content-length"]);
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		request.resume();
		throw new HttpError(413, "request body is too large");
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_BODY_BYTES) {
			request.resume();
			throw new HttpError(413, "request body is too large");
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "request body is not valid JSON");
	}
}

function decisionKind(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new HttpError(400, "decision body must be an object");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).length !== 1 || !("kind" in input))
		throw new HttpError(400, "decision body has invalid fields");
	return input.kind;
}

const VIEW_PARAMETERS = new Set([
	"mode",
	"line-numbers",
	"wrap",
	"hunk-headers",
	"audit-findings",
	"auto-layout",
]);

function singleParameter(
	search: URLSearchParams,
	name: string,
): string | undefined {
	const values = search.getAll(name);
	if (values.length > 1)
		throw new HttpError(400, `${name} must be supplied at most once`);
	return values[0];
}

function booleanParameter(
	search: URLSearchParams,
	name: string,
	fallback: boolean,
): boolean {
	const value = singleParameter(search, name);
	if (value === undefined) return fallback;
	if (value === "on") return true;
	if (value === "off") return false;
	throw new HttpError(400, `${name} must be on or off`);
}

function parseReviewView(
	search: URLSearchParams,
	defaults: ReviewViewOptions,
): { options: ReviewViewOptions; autoLayout?: ReviewAutoLayout } {
	for (const name of search.keys())
		if (!VIEW_PARAMETERS.has(name))
			throw new HttpError(400, `unknown review option: ${name}`);
	const modeValue = singleParameter(search, "mode") ?? defaults.mode;
	if (modeValue !== "auto" && modeValue !== "split" && modeValue !== "stack")
		throw new HttpError(400, "mode must be auto, split, or stack");
	const autoLayoutValue = singleParameter(search, "auto-layout");
	if (
		autoLayoutValue !== undefined &&
		autoLayoutValue !== "split" &&
		autoLayoutValue !== "stack"
	) throw new HttpError(400, "auto-layout must be split or stack");
	if (autoLayoutValue !== undefined && modeValue !== "auto")
		throw new HttpError(400, "auto-layout is valid only when mode is auto");
	return {
		options: {
			mode: modeValue,
			lineNumbers: booleanParameter(search, "line-numbers", defaults.lineNumbers),
			wrap: booleanParameter(search, "wrap", defaults.wrap),
			hunkHeaders: booleanParameter(search, "hunk-headers", defaults.hunkHeaders),
			auditFindings: booleanParameter(search, "audit-findings", defaults.auditFindings),
		},
		...(autoLayoutValue === undefined
			? {}
			: { autoLayout: autoLayoutValue as ReviewAutoLayout }),
	};
}

function publicState(store: ReviewStore, patch: ReviewPatch): {
	state: ReviewState;
	files: Array<{
		filePath: string;
		previousPath?: string;
		type: string;
		changed: { additions: number[]; deletions: number[] };
	}>;
} {
	return {
		state: store.snapshot(),
		files: patch.files.map(({ filePath, previousPath, type, changed }) => ({
			filePath,
			...(previousPath === undefined ? {} : { previousPath }),
			type,
			changed,
		})),
	};
}

function commentId(pathname: string, commentsPath: string): string | undefined {
	if (!pathname.startsWith(`${commentsPath}/`)) return undefined;
	const suffix = pathname.slice(commentsPath.length + 1);
	if (!suffix || suffix.includes("/")) return undefined;
	try {
		return decodeURIComponent(suffix);
	} catch {
		throw new HttpError(400, "comment id is malformed");
	}
}

function staleMessage(original: ReviewPatch, current: ReviewPatch): string {
	if (original.snapshot.headOid !== current.snapshot.headOid)
		return "Review is stale: HEAD changed; run /review again.";
	if (!original.snapshot.raw.equals(current.snapshot.raw))
		return "Review is stale: staged patch bytes changed; run /review again.";
	return "Review is stale: the staged candidate repository changed; run /review again.";
}

export async function createReviewServer(
	options: CreateReviewServerOptions,
): Promise<ReviewServer> {
	const {
		patch,
		auditFindings,
		view: initialView = DEFAULT_REVIEW_VIEW_OPTIONS,
		readPatch = readGitReviewPatch,
	} = options;
	const store = new ReviewStore(patch, auditFindings);
	const renderer = new ReviewRenderer(patch);
	const capability = randomBytes(24).toString("base64url");
	const basePath = `/${capability}/`;
	const apiPath = `${basePath}api`;
	const commentsPath = `${apiPath}/comments`;
	let expectedHost = "";
	let terminalScheduled = false;
	let resolveDecision!: (decision: ReviewServerDecision) => void;
	const decision = new Promise<ReviewServerDecision>((resolve) => {
		resolveDecision = resolve;
	});
	const scheduleDecision = (
		response: ServerResponse,
		value: ReviewServerDecision,
	): void => {
		terminalScheduled = true;
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			response.off("finish", settle);
			response.off("close", settle);
			resolveDecision(value);
		};
		response.once("finish", settle);
		response.once("close", settle);
		if (response.destroyed) queueMicrotask(settle);
	};

	const server = createServer((request, response) => {
		void (async () => {
			if (request.headers.host !== expectedHost)
				throw new HttpError(404, "Not found");
			const expectedOrigin = `http://${expectedHost}`;
			if (request.headers.origin && request.headers.origin !== expectedOrigin)
				throw new HttpError(403, "Forbidden origin");
			const url = new URL(request.url ?? "/", expectedOrigin);
			if (!url.pathname.startsWith(basePath)) throw new HttpError(404, "Not found");

			if (request.method === "GET" && url.pathname === basePath) {
				const { options: view, autoLayout } = parseReviewView(
					url.searchParams,
					initialView,
				);
				const html = await renderer.render(store.snapshot(), view, basePath, autoLayout);
				send(response, 200, "text/html; charset=utf-8", html);
				return;
			}
			if (url.search)
				throw new HttpError(400, "query parameters are valid only on the review page");
			if (request.method === "GET" && url.pathname === `${basePath}review.js`) {
				send(response, 200, "text/javascript; charset=utf-8", BROWSER_SCRIPT);
				return;
			}
			if (request.method === "GET" && url.pathname === `${basePath}review.css`) {
				send(response, 200, "text/css; charset=utf-8", REVIEW_CSS);
				return;
			}
			if (request.method === "GET" && url.pathname === `${apiPath}/state`) {
				sendJson(response, 200, publicState(store, patch));
				return;
			}
			if (request.method === "POST" && url.pathname === commentsPath) {
				if (terminalScheduled)
					throw new ReviewStateError("review already has a terminal result", 409);
				const state = store.addComment(await readJson(request));
				sendJson(response, 201, { state });
				return;
			}
			const id = commentId(url.pathname, commentsPath);
			if (id && request.method === "PATCH") {
				if (terminalScheduled)
					throw new ReviewStateError("review already has a terminal result", 409);
				const state = store.updateComment(id, await readJson(request));
				sendJson(response, 200, { state });
				return;
			}
			if (id && request.method === "DELETE") {
				if (terminalScheduled)
					throw new ReviewStateError("review already has a terminal result", 409);
				const state = store.deleteComment(id);
				sendJson(response, 200, { state });
				return;
			}
			if (request.method === "POST" && url.pathname === `${apiPath}/decision`) {
				if (terminalScheduled)
					throw new ReviewStateError("review already has a terminal result", 409);
				const kind = decisionKind(await readJson(request));
				let current: ReviewPatch;
				try {
					current = await readPatch(patch.snapshot.repositoryRoot);
				} catch {
					if (terminalScheduled)
						throw new ReviewStateError("review already has a terminal result", 409);
					const error = "Review is stale: the staged candidate could not be reread; run /review again.";
					scheduleDecision(response, { kind: "stale", error });
					sendJson(response, 409, { error });
					return;
				}
				if (terminalScheduled)
					throw new ReviewStateError("review already has a terminal result", 409);
				if (!reviewSnapshotsEqual(patch.snapshot, current.snapshot)) {
					const error = staleMessage(patch, current);
					scheduleDecision(response, { kind: "stale", error });
					sendJson(response, 409, { error });
					return;
				}
				const state = store.decide(kind);
				const recorded = state.decision!;
				const result: ReviewServerDecision = recorded.kind === "approve"
					? { kind: "approve", decidedAt: recorded.decidedAt }
					: {
						kind: "send-feedback",
						decidedAt: recorded.decidedAt,
						feedbackMarkdown: formatReviewFeedback(state),
					};
				scheduleDecision(response, result);
				sendJson(response, 200, { state });
				return;
			}
			throw new HttpError(404, "Not found");
		})().catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			if (error instanceof HttpError || error instanceof ReviewStateError) {
				sendJson(response, error.status, { error: error.message });
				return;
			}
			sendJson(response, 500, { error: "Internal review server error" });
		});
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo | null;
	if (!address || address.address !== "127.0.0.1") {
		server.close();
		throw new Error("review server did not bind to 127.0.0.1");
	}
	expectedHost = `127.0.0.1:${address.port}`;
	const url = `http://${expectedHost}${basePath}?${reviewViewSearch(initialView)}`;
	let closed = false;
	return {
		url,
		decision,
		async close() {
			if (closed) return;
			closed = true;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeIdleConnections();
			});
		},
	};
}
