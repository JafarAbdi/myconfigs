import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AUDIT_ROSTER } from "./audit-roster.ts";
import { parseReviewCommand } from "./review-command.ts";
import { reviewArgumentCompletions } from "./review-completion.ts";
import type {
	AuditProgress,
	AuditRequirement,
	AuditResult,
	RunAuditInput,
} from "./audit.ts";
import type {
	ReviewPatch,
	ReviewSelection,
	ReviewSnapshot,
	ReviewSource,
} from "./review-git.ts";
import type {
	CreateReviewServerOptions,
	ReviewServer,
	ReviewServerDecision,
} from "./review-server.ts";

const MAX_REQUIREMENT_BYTES = 1024 * 1024;
const READY_PREFIX = "Review ready  ";
const READY_LINK = "Open review ↗";
const PROGRESS_WIDGET = "review-progress";
const MAX_ACTIVITY_CHARS = 72;
const REVIEWER_COUNT = AUDIT_ROSTER.length;

function activityText(activity: string | undefined): string {
	const text = activity?.replaceAll(/\s+/gu, " ").trim() || "thinking";
	return text.length <= MAX_ACTIVITY_CHARS ? text : `${text.slice(0, MAX_ACTIVITY_CHARS - 1)}…`;
}

function modelName(model: string): string {
	return model.split("/").at(-1) ?? model;
}

function latestActivity(state: AuditProgress): string | undefined {
	const step = state.latestStep;
	if (step) return activityText(step.detail ? `${step.tool}(${step.detail})` : step.tool);
	return state.activity ? activityText(state.activity) : undefined;
}

function findingText(count: number): string {
	return count === 0 ? "no findings" : `${count} ${count === 1 ? "finding" : "findings"}`;
}

function selectionMatchesSnapshot(
	selection: ReviewSelection,
	snapshot: ReviewSnapshot,
): boolean {
	return selection.source === snapshot.source &&
		selection.paths.length === snapshot.paths.length &&
		selection.paths.every((path, index) => path === snapshot.paths[index]);
}

function renderProgress(
	ctx: ExtensionCommandContext,
	states: Map<string, AuditProgress>,
	expanded: boolean,
	progress?: AuditProgress,
): void {
	if (progress) states.set(progress.reviewer, progress);
	const complete = [...states.values()].filter(({ phase }) => phase === "complete").length;
	const theme = ctx.ui.theme;
	const lines = [
		`${theme.fg("accent", theme.bold("Review agents"))}${theme.fg("muted", ` · ${complete}/${REVIEWER_COUNT} complete`)}${theme.fg("dim", ` · Ctrl+O ${expanded ? "less" : "details"}`)}`,
	];
	for (const state of states.values()) {
		const count = state.findings ?? 0;
		const color = state.phase !== "complete" ? "accent" : count === 0 ? "success" : "warning";
		const mark = theme.fg(color, state.phase === "complete" ? "✓" : "•");
		const reviewer = theme.fg("toolTitle", theme.bold(state.reviewer));
		const model = theme.fg("muted", ` · ${modelName(state.model)}`);
		const label = `${mark} ${reviewer}${model}`;
		const status = state.phase === "complete"
			? findingText(count)
			: state.phase === "started"
				? "starting"
				: activityText(state.activity);
		const coloredStatus = theme.fg(
			state.phase === "complete" ? color : state.phase === "started" ? "dim" : "thinkingText",
			status,
		);
		if (!expanded) {
			lines.push(`${label}: ${coloredStatus}`);
			continue;
		}
		const latest = latestActivity(state);
		const detail = latest
			? `${theme.fg("dim", " · … ")}${theme.fg("toolOutput", latest)}`
			: state.phase === "started"
				? ` · ${coloredStatus}`
				: "";
		lines.push(
			`${label}${theme.fg("muted", ` · ${state.turns}t`)}${state.phase === "complete" ? ` · ${coloredStatus}` : ""}${detail}`,
		);
	}
	ctx.ui.setWidget(PROGRESS_WIDGET, lines);
}

type WaitResult =
	| ReviewServerDecision
	| { kind: "cancelled" }
	| { kind: "failed"; error: unknown };

type CancelWait = () => void;

export interface ReviewDependencies {
	resolveRepositoryRoot(repository: string): Promise<string>;
	readPatch(repository: string, selection: ReviewSelection): Promise<ReviewPatch>;
	listCandidatePaths(repository: string, source: ReviewSource): Promise<string[]>;
	listRequirementPaths(repository: string): Promise<string[]>;
	readRequirement(repositoryRoot: string, argument: string): Promise<AuditRequirement | undefined>;
	runAudit(input: RunAuditInput): Promise<AuditResult>;
	reviewSnapshotsEqual(left: ReviewSnapshot, right: ReviewSnapshot): boolean | Promise<boolean>;
	createServer(options: CreateReviewServerOptions): Promise<ReviewServer>;
}

const defaultDependencies: ReviewDependencies = {
	async resolveRepositoryRoot(repository) {
		return (await import("./review-git.ts")).resolveGitRepositoryRoot(repository);
	},
	async readPatch(repository, selection) {
		return (await import("./review-git.ts")).readGitReviewPatch(repository, selection);
	},
	async listCandidatePaths(repository, source) {
		return (await import("./review-git.ts")).listGitReviewPaths(repository, source);
	},
	async listRequirementPaths(repository) {
		return (await import("./review-git.ts")).listGitReviewRequirements(repository);
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
	/** Submits feedback inside the shutdown-tracked run when a callback is provided. */
	run(
		argument: string,
		ctx: ExtensionCommandContext,
		submitFeedback?: (feedback: string) => void,
	): Promise<string | undefined>;
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
		async run(argument, ctx, submitFeedback) {
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

				const repositoryRoot = await dependencies.resolveRepositoryRoot(ctx.cwd);
				const command = parseReviewCommand(argument, repositoryRoot);
				const patch = await dependencies.readPatch(repositoryRoot, command.selection);
				if (patch.snapshot.repositoryRoot !== repositoryRoot)
					throw new Error("Review capture returned a different repository root");
				if (!selectionMatchesSnapshot(command.selection, patch.snapshot))
					throw new Error("Review capture did not preserve the requested source and path selection");
				if (patch.empty) {
					const scope = command.selection.paths.length === 0
						? ""
						: ` in the selected ${command.selection.paths.length === 1 ? "path" : "paths"}`;
					throw new Error(`/review found no ${command.selection.source} changes${scope}.`);
				}
				const requirement = await dependencies.readRequirement(
					patch.snapshot.repositoryRoot,
					command.requirementPath ?? "",
				);
				if (shuttingDown) throw new Error("Review session is shutting down");
				ctx.ui.notify(`Review started: ${REVIEWER_COUNT} agents.`, "info");
				const auditController = new AbortController();
				const progress = new Map<string, AuditProgress>();
				let progressActive = true;
				let expanded = ctx.ui.getToolsExpanded();
				const stopWatchingInput = ctx.ui.onTerminalInput(() => {
					queueMicrotask(() => {
						if (!progressActive) return;
						const next = ctx.ui.getToolsExpanded();
						if (next === expanded) return;
						expanded = next;
						renderProgress(ctx, progress, expanded);
					});
					return undefined;
				});
				activeAudits.add(auditController);
				let audit: AuditResult;
				try {
					audit = await dependencies.runAudit({
						repositoryRoot: patch.snapshot.repositoryRoot,
						patch,
						parentSession,
						signal: auditController.signal,
						onProgress: (update) => renderProgress(ctx, progress, expanded, update),
						...(requirement ? { requirement } : {}),
					});
				} finally {
					progressActive = false;
					stopWatchingInput();
					activeAudits.delete(auditController);
					ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
				}
				if (shuttingDown) throw new Error("Review session is shutting down");
				const current = await dependencies.readPatch(
					patch.snapshot.repositoryRoot,
					command.selection,
				);
				if (!(await dependencies.reviewSnapshotsEqual(patch.snapshot, current.snapshot)))
					throw new Error("Selected candidate changed during audit; run /review again");

				const server = await dependencies.createServer({
					patch,
					auditFindings: audit.findings,
					readPatch: (repository) => dependencies.readPatch(repository, command.selection),
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
					case "approve": {
						const findings = audit.findings.length === 0
							? "no findings"
							: `${audit.findings.length} ${audit.findings.length === 1 ? "finding" : "findings"}`;
						ctx.ui.notify(`Review approved: ${REVIEWER_COUNT} agents, ${findings}. Candidate: ${patch.snapshot.source}.`, "info");
						return;
					}
					case "stale":
						ctx.ui.notify(decision.error, "error");
						return;
					case "send-feedback":
						if (!submitFeedback) return decision.feedbackMarkdown;
						submitFeedback(decision.feedbackMarkdown);
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
	const completionCache = new Map<string, { expiresAt: number; value: Promise<string[]> }>();
	let completionRepository = process.cwd();
	const cachedCompletion = (key: string, load: () => Promise<string[]>): Promise<string[]> => {
		const now = Date.now();
		const cached = completionCache.get(key);
		if (cached && cached.expiresAt > now) return cached.value;
		const value = load().catch((error) => {
			completionCache.delete(key);
			throw error;
		});
		completionCache.set(key, { expiresAt: now + 1_000, value });
		return value;
	};
	pi.on("session_start", (_event, ctx) => {
		completionRepository = ctx.cwd;
		completionCache.clear();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		completionCache.clear();
		ctx.abort();
		await controller.shutdown();
	});
	pi.registerCommand("review", {
		description: "Audit staged, worktree, or untracked Git changes",
		getArgumentCompletions: (prefix) => reviewArgumentCompletions(prefix, {
			listCandidatePaths: (source) => cachedCompletion(
				`${completionRepository}\0${source}`,
				() => dependencies.listCandidatePaths(completionRepository, source),
			),
			listRequirementPaths: () => cachedCompletion(
				`${completionRepository}\0requirements`,
				() => dependencies.listRequirementPaths(completionRepository),
			),
		}),
		async handler(argument, ctx) {
			try {
				await controller.run(argument, ctx, (feedback) => {
					pi.sendUserMessage(feedback);
					ctx.ui.notify("Feedback submitted to Pi.", "info");
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export default function review(pi: ExtensionAPI): void {
	registerReview(pi);
}
