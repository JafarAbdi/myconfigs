import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	AuditRequirement,
	AuditResult,
	RunAuditInput,
} from "./audit.ts";
import type {
	ReviewPatch,
	ReviewSnapshot,
} from "./review-git.ts";
import type {
	CreateReviewServerOptions,
	ReviewServer,
	ReviewServerDecision,
} from "./review-server.ts";

const MAX_REQUIREMENT_BYTES = 1024 * 1024;
const READY_PREFIX = "Review ready  ";
const READY_LINK = "Open review ↗";

type WaitResult =
	| ReviewServerDecision
	| { kind: "cancelled" }
	| { kind: "failed"; error: unknown };

type CancelWait = () => void;

export interface ReviewDependencies {
	readPatch(repository: string): Promise<ReviewPatch>;
	readRequirement(repositoryRoot: string, argument: string): Promise<AuditRequirement | undefined>;
	runAudit(input: RunAuditInput): Promise<AuditResult>;
	reviewSnapshotsEqual(left: ReviewSnapshot, right: ReviewSnapshot): boolean | Promise<boolean>;
	createServer(options: CreateReviewServerOptions): Promise<ReviewServer>;
}

const defaultDependencies: ReviewDependencies = {
	async readPatch(repository) {
		return (await import("./review-git.ts")).readGitReviewPatch(repository);
	},
	readRequirement: readReviewRequirement,
	async runAudit(input) {
		return (await import("./audit.ts")).runAudit(input);
	},
	async reviewSnapshotsEqual(left, right) {
		return (await import("./review-git.ts")).reviewSnapshotsEqual(left, right);
	},
	async createServer(options) {
		return (await import("./review-server.ts")).createReviewServer(options);
	},
};

function outsideRoot(path: string): boolean {
	return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export async function readReviewRequirement(
	repositoryRoot: string,
	argument: string,
): Promise<AuditRequirement | undefined> {
	const path = argument.trim();
	if (!path) return undefined;
	if (path.includes("\0")) throw new Error("Review requirement path must not contain NUL");
	if (isAbsolute(path)) throw new Error("Review requirement path must be repository-relative");
	if (!path.endsWith(".md")) throw new Error("Review requirement path must end in .md");

	const candidate = resolve(repositoryRoot, path);
	const repositoryRelative = relative(repositoryRoot, candidate);
	if (outsideRoot(repositoryRelative))
		throw new Error("Review requirement path escapes the repository root");
	const metadata = await lstat(candidate).catch(() => undefined);
	if (metadata?.isSymbolicLink()) throw new Error("Review requirement path must not be a symlink");
	if (!metadata?.isFile()) throw new Error("Review requirement path must name an existing file");

	const canonicalRoot = await realpath(repositoryRoot);
	const canonicalCandidate = await realpath(candidate);
	if (outsideRoot(relative(canonicalRoot, canonicalCandidate)))
		throw new Error("Review requirement path resolves outside the repository root");
	if (canonicalCandidate !== resolve(canonicalRoot, repositoryRelative))
		throw new Error("Review requirement path must not traverse a symlink");

	const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("Review requirement path must name a regular file");
		if (stat.size > MAX_REQUIREMENT_BYTES)
			throw new Error(`Review requirement exceeds ${MAX_REQUIREMENT_BYTES} bytes`);
		const bytes = Buffer.alloc(MAX_REQUIREMENT_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(bytes, length, bytes.length - length, null);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		if (length > MAX_REQUIREMENT_BYTES)
			throw new Error(`Review requirement exceeds ${MAX_REQUIREMENT_BYTES} bytes`);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
		} catch {
			throw new Error("Review requirement is not valid UTF-8");
		}
		return { path, content };
	} finally {
		await handle.close();
	}
}

function linkedReadyLine(url: string, width: number): string {
	if (width <= 0) return "";
	const prefix = READY_PREFIX.slice(0, width);
	if (prefix.length < READY_PREFIX.length) return prefix;
	const text = READY_LINK.slice(0, Math.max(0, width - READY_PREFIX.length));
	if (!text) return prefix;
	return `${prefix}\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function waitForDecision(
	ctx: ExtensionCommandContext,
	server: ReviewServer,
	pending: Set<CancelWait>,
): Promise<WaitResult> {
	let cancel: CancelWait | undefined;
	const result = ctx.ui.custom<WaitResult>((_tui, _theme, keybindings, done) => {
		let finished = false;
		const finish = (value: WaitResult): void => {
			if (finished) return;
			finished = true;
			done(value);
		};
		cancel = () => finish({ kind: "cancelled" });
		pending.add(cancel);
		void server.decision.then(
			(decision) => finish(decision),
			(error: unknown) => finish({ kind: "failed", error }),
		);
		return {
			render: (width: number) => [linkedReadyLine(server.url, width)],
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) cancel?.();
			},
			invalidate() {},
		};
	});
	return result.finally(() => {
		if (cancel) pending.delete(cancel);
	});
}

export interface ReviewController {
	run(argument: string, ctx: ExtensionCommandContext): Promise<void>;
	shutdown(): Promise<void>;
}

export function createReviewController(
	dependencies: ReviewDependencies = defaultDependencies,
): ReviewController {
	const liveServers = new Set<ReviewServer>();
	const pendingWaits = new Set<CancelWait>();
	const activeAudits = new Set<AbortController>();
	const activeRuns = new Set<Promise<void>>();
	let shuttingDown = false;

	return {
		async run(argument, ctx) {
			let settleRun!: () => void;
			const runSettled = new Promise<void>((resolve) => { settleRun = resolve; });
			activeRuns.add(runSettled);
			try {
				if (shuttingDown) throw new Error("Review session is shutting down");
				if (ctx.mode !== "tui") throw new Error("/review requires TUI mode");
				await ctx.waitForIdle();
				if (shuttingDown) throw new Error("Review session is shutting down");
				const parentSession = {
					directory: ctx.sessionManager.getSessionDir(),
					id: ctx.sessionManager.getSessionId(),
				};

				const patch = await dependencies.readPatch(ctx.cwd);
				if (patch.empty) throw new Error("/review requires a non-empty staged patch");
				const requirement = await dependencies.readRequirement(
					patch.snapshot.repositoryRoot,
					argument.trim(),
				);
				if (shuttingDown) throw new Error("Review session is shutting down");
				ctx.ui.notify("Auditing staged changes…", "info");
				const auditController = new AbortController();
				activeAudits.add(auditController);
				let audit: AuditResult;
				try {
					audit = await dependencies.runAudit({
						repositoryRoot: patch.snapshot.repositoryRoot,
						patch,
						parentSession,
						signal: auditController.signal,
						...(requirement ? { requirement } : {}),
					});
				} finally {
					activeAudits.delete(auditController);
				}
				if (shuttingDown) throw new Error("Review session is shutting down");
				const current = await dependencies.readPatch(patch.snapshot.repositoryRoot);
				if (!(await dependencies.reviewSnapshotsEqual(patch.snapshot, current.snapshot)))
					throw new Error("Staged changes changed during audit; run /review again");

				const server = await dependencies.createServer({
					patch,
					auditFindings: audit.findings,
				});
				if (shuttingDown) {
					await server.close();
					throw new Error("Review session is shutting down");
				}
				liveServers.add(server);
				let decision: WaitResult;
				try {
					decision = await waitForDecision(ctx, server, pendingWaits);
				} finally {
					try {
						await server.close();
					} finally {
						liveServers.delete(server);
					}
				}

				switch (decision.kind) {
					case "approve":
						ctx.ui.notify("Review approved.", "info");
						return;
					case "stale":
						ctx.ui.notify(decision.error, "error");
						return;
					case "send-feedback":
						ctx.ui.setEditorText(decision.feedbackMarkdown);
						ctx.ui.notify("Review feedback loaded into the editor.", "info");
						return;
					case "cancelled":
						ctx.ui.notify("Review cancelled.", "info");
						return;
					case "failed":
						throw decision.error;
				}
			} finally {
				settleRun();
				activeRuns.delete(runSettled);
			}
		},

		async shutdown() {
			shuttingDown = true;
			for (const audit of activeAudits) audit.abort(new Error("Review session shut down"));
			activeAudits.clear();
			for (const cancel of pendingWaits) cancel();
			pendingWaits.clear();
			await Promise.allSettled([...liveServers].map((server) => server.close()));
			liveServers.clear();
			await Promise.allSettled([...activeRuns]);
		},
	};
}

export function registerReview(
	pi: ExtensionAPI,
	dependencies: ReviewDependencies = defaultDependencies,
): void {
	const controller = createReviewController(dependencies);
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.abort();
		await controller.shutdown();
	});
	pi.registerCommand("review", {
		description: "Audit and review the exact staged Git patch",
		async handler(argument, ctx) {
			try {
				await controller.run(argument, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export default function review(pi: ExtensionAPI): void {
	registerReview(pi);
}
