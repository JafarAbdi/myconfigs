import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type { AgentAnnotation, ReviewState } from "./review-state.ts";
import { ReviewStateError, ReviewStore } from "./review-state.ts";
import type { ReviewPatch } from "./review-git.ts";
import {
	DEFAULT_REVIEW_VIEW_OPTIONS,
	ReviewRenderer,
	reviewViewSearch,
	type ReviewAutoLayout,
	type ReviewViewOptions,
} from "./review-renderer.ts";

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

export interface ReviewServer {
	url: string;
	statePath: string;
	close(): Promise<void>;
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
	"agent-notes",
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
	const mode = modeValue;
	const autoLayoutValue = singleParameter(search, "auto-layout");
	if (
		autoLayoutValue !== undefined &&
		autoLayoutValue !== "split" &&
		autoLayoutValue !== "stack"
	)
		throw new HttpError(400, "auto-layout must be split or stack");
	if (autoLayoutValue !== undefined && mode !== "auto")
		throw new HttpError(400, "auto-layout is valid only when mode is auto");
	return {
		options: {
			mode,
			lineNumbers: booleanParameter(search, "line-numbers", defaults.lineNumbers),
			wrap: booleanParameter(search, "wrap", defaults.wrap),
			hunkHeaders: booleanParameter(search, "hunk-headers", defaults.hunkHeaders),
			agentNotes: booleanParameter(search, "agent-notes", defaults.agentNotes),
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

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function acquireStateLock(statePath: string): () => void {
	mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
	const path = `${statePath}.lock`;
	const token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let descriptor: number;
		try {
			descriptor = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let owner: { pid?: unknown };
			try {
				owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
			} catch {
				throw new Error(`review lock is invalid; remove ${path} after confirming no server is running`);
			}
			if (
				typeof owner.pid === "number" &&
				Number.isSafeInteger(owner.pid) &&
				owner.pid > 0 &&
				processExists(owner.pid)
			)
				throw new Error(`another review server already owns ${statePath}`);
			try {
				unlinkSync(path);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
			}
			continue;
		}
		try {
			writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
		} catch (error) {
			closeSync(descriptor);
			try {
				unlinkSync(path);
			} catch {}
			throw error;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			closeSync(descriptor);
			try {
				const owner = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
				if (owner.token === token) unlinkSync(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		};
	}
	throw new Error(`could not acquire review lock for ${statePath}`);
}

export async function createReviewServer(options: {
	patch: ReviewPatch;
	statePath: string;
	agentAnnotations?: readonly AgentAnnotation[];
	view?: ReviewViewOptions;
}): Promise<ReviewServer> {
	const {
		patch,
		statePath,
		agentAnnotations = [],
		view: initialView = DEFAULT_REVIEW_VIEW_OPTIONS,
	} = options;
	const releaseStateLock = acquireStateLock(statePath);
	let store: ReviewStore;
	try {
		store = new ReviewStore(statePath, patch, agentAnnotations);
	} catch (error) {
		releaseStateLock();
		throw error;
	}
	const renderer = new ReviewRenderer(patch);
	const capability = randomBytes(24).toString("base64url");
	const basePath = `/${capability}/`;
	const apiPath = `${basePath}api`;
	const commentsPath = `${apiPath}/comments`;
	let expectedHost = "";

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
				const html = await renderer.render(
					store.snapshot(),
					view,
					basePath,
					autoLayout,
				);
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
				const state = store.addComment(await readJson(request));
				sendJson(response, 201, { state });
				return;
			}
			const id = commentId(url.pathname, commentsPath);
			if (id && request.method === "PATCH") {
				const state = store.updateComment(id, await readJson(request));
				sendJson(response, 200, { state });
				return;
			}
			if (id && request.method === "DELETE") {
				const state = store.deleteComment(id);
				sendJson(response, 200, { state });
				return;
			}
			if (request.method === "POST" && url.pathname === `${apiPath}/decision`) {
				const state = store.decide(decisionKind(await readJson(request)));
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
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		releaseStateLock();
		throw error;
	}
	const address = server.address() as AddressInfo | null;
	if (!address || address.address !== "127.0.0.1") {
		server.close();
		releaseStateLock();
		throw new Error("review server did not bind to 127.0.0.1");
	}
	expectedHost = `127.0.0.1:${address.port}`;
	const url = `http://${expectedHost}${basePath}?${reviewViewSearch(initialView)}`;
	let closed = false;
	return {
		url,
		statePath,
		async close() {
			if (closed) return;
			closed = true;
			try {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeIdleConnections();
				});
			} finally {
				releaseStateLock();
			}
		},
	};
}
