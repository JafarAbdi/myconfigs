import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type AutocompleteItem, type TUI } from "@earendil-works/pi-tui";
import { activityLabel } from "../subagent/runtimes.ts";
import { AUDIT_ROSTER } from "./audit-roster.ts";
import { isAuditResultChild, registerAuditResultTool } from "./audit-output.ts";
import {
	isReviewIntentChild,
	registerReviewIntentResultTool,
	REVIEW_INTENT_MODEL,
	type ResolvedReviewIntent,
	type RunReviewIntentInput,
} from "./review-intent.ts";
import {
	resolveCheckedOutPullRequest,
	resolveGithubToken,
} from "./review-forge.ts";
import { registerWiffResolveTool, type FixTurn } from "./review-fix.ts";
import type {
	ReviewSynthesisResult,
	RunReviewSynthesisInput,
} from "./review-synthesis.ts";
import {
	addWiffComment,
	addWiffReply,
	createWiffSession,
	deriveWiffDataDir,
	hasWiffSession,
	pullWiffReview,
	pushWiffReview,
	readWiffState,
	refreshWiffSession,
	removeWiffSession,
	renderWiffMarkdown,
	resolveWiffComment,
	resumeWiff,
	synthesisWiffComments,
} from "./review-wiff.ts";
import type {
	AuditFinding,
	AuditProgress,
	AuditResult,
	RunAuditInput,
} from "./audit.ts";
import type {
	ReviewPatch,
	ReviewSelection,
	ReviewSnapshot,
} from "./review-git.ts";
import type {
	AddWiffCommentOptions,
	AddWiffReplyOptions,
	CreateWiffSessionOptions,
	PullWiffReviewOptions,
	PushWiffReviewOptions,
	RefreshWiffSessionOptions,
	RemoveWiffSessionOptions,
	ResolveWiffCommentOptions,
	ResumeWiffOptions,
	WiffAuthor,
	WiffBaseOptions,
	WiffPinnedOptions,
	WiffState,
	WiffTui,
} from "./review-wiff.ts";

const PROGRESS_WIDGET = "review-progress";
const DIAGNOSTIC_WIDGET = "review-diagnostic";
const STATUS_KEY = "review";
const PUBLICATION_FAILED_STATUS = "review: publication failed";
const MAX_ACTIVITY_CHARS = 72;
const REVIEWER_COUNT = AUDIT_ROSTER.length;
export const REVIEW_SCOPE_ENTRY = "review-scope";

const REVIEW_ACTIONS = [
	{ name: "pull", description: "import the checked-out pull request" },
	{ name: "audit", description: "audit exact local Git changes" },
	{ name: "open", description: "open the private Wiff review" },
	{ name: "discuss", description: "discuss feedback read-only" },
	{ name: "fix", description: "address unresolved feedback" },
	{ name: "push", description: "publish one review author" },
	{ name: "remove", description: "remove the private review" },
] as const;

type ReviewAction = typeof REVIEW_ACTIONS[number]["name"];

interface RoutedReviewAction {
	action: ReviewAction;
	scope: string;
}

export interface ReviewScopeEntryData {
	model: string;
	view: ReviewSelection["view"];
	selection: "whole view" | "selected subset";
	paths: string[];
}

function reviewAction(name: string): name is ReviewAction {
	return REVIEW_ACTIONS.some((action) => action.name === name);
}

function routeReviewArgument(argument: string): RoutedReviewAction | undefined {
	const input = argument.trim();
	if (!input) return undefined;
	const separator = input.search(/\s/u);
	const first = separator < 0 ? input : input.slice(0, separator);
	const remainder = separator < 0 ? "" : input.slice(separator).trim();
	if (!reviewAction(first)) return { action: "audit", scope: input };
	if (first === "audit") return { action: first, scope: remainder };
	if (remainder) throw new Error(`/review ${first} accepts no arguments`);
	return { action: first, scope: "" };
}

function completeReviewAction(prefix: string): AutocompleteItem[] | null {
	const input = prefix.trimStart();
	if (/\s/u.test(input)) return null;
	const matches = REVIEW_ACTIONS
		.filter(({ name }) => name.startsWith(input))
		.map(({ name, description }) => ({ value: name, label: name, description }));
	return matches.length > 0 ? matches : null;
}

function activityText(activity: string | undefined): string {
	const text = activity?.replaceAll("\n", " ").replaceAll("\r", " ").trim() || "thinking";
	return text.length <= MAX_ACTIVITY_CHARS ? text : `${text.slice(0, MAX_ACTIVITY_CHARS - 1)}…`;
}

function modelName(model: string): string {
	return model.split("/").at(-1) ?? model;
}

function latestActivity(state: AuditProgress): string | undefined {
	const step = state.latestStep;
	if (step) return activityText(step.detail ? `${step.tool}(${step.detail})` : step.tool);
	return state.activity ? activityText(activityLabel(state.activity)) : undefined;
}

function findingText(count: number): string {
	return count === 0 ? "no findings" : `${count} ${count === 1 ? "finding" : "findings"}`;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function scopeEntryData(intent: ResolvedReviewIntent): ReviewScopeEntryData {
	return {
		model: REVIEW_INTENT_MODEL,
		view: intent.selection.view,
		selection: intent.selection.paths.length === 0 ? "whole view" : "selected subset",
		paths: [...intent.resolvedPaths],
	};
}

function scopeEntryText(data: ReviewScopeEntryData, expanded: boolean): string {
	const files = `${data.paths.length} ${data.paths.length === 1 ? "file" : "files"}`;
	const summary = `Luna scope · ${data.model} · ${data.view} · ${data.selection} · ${files}`;
	if (!expanded) return `${summary} · Ctrl+O details`;
	return [
		summary,
		`Model: ${data.model}`,
		`View: ${data.view}`,
		`Selection: ${data.selection}`,
		`Exact paths (${data.paths.length}):`,
		...data.paths.map((path) => `  ${JSON.stringify(path)}`),
	].join("\n");
}

function selectionMatchesSnapshot(
	selection: ReviewSelection,
	snapshot: ReviewSnapshot,
): boolean {
	return selection.view === snapshot.view &&
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
				: activityText(state.activity ? activityLabel(state.activity) : undefined);
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

interface BorderedLoaderLike {
	signal: AbortSignal;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

type BorderedLoaderFactory = (
	tui: TUI,
	theme: Theme,
	message: string,
) => BorderedLoaderLike;

export interface ReviewDependencies {
	loadBorderedLoader(): Promise<BorderedLoaderFactory>;
	deriveWiffDataDir(piSessionId: string): string;
	resolveRepositoryRoot(repository: string, signal?: AbortSignal): Promise<string>;
	resolveIntent(input: Omit<RunReviewIntentInput, "inventory">): Promise<ResolvedReviewIntent>;
	readPatch(
		repository: string,
		selection: ReviewSelection,
		signal?: AbortSignal,
	): Promise<ReviewPatch>;
	runAudit(input: RunAuditInput): Promise<AuditResult>;
	runReviewSynthesis(input: RunReviewSynthesisInput): Promise<ReviewSynthesisResult>;
	reviewSnapshotsEqual(left: ReviewSnapshot, right: ReviewSnapshot): boolean | Promise<boolean>;
	hasWiffSession(options: WiffBaseOptions): Promise<boolean>;
	createWiffSession(options: CreateWiffSessionOptions): Promise<void>;
	refreshWiffSession(options: RefreshWiffSessionOptions): Promise<void>;
	readWiffState(options: WiffBaseOptions | WiffPinnedOptions): Promise<WiffState>;
	renderWiffMarkdown(options: WiffBaseOptions | WiffPinnedOptions): Promise<string>;
	addWiffComment(options: AddWiffCommentOptions): Promise<void>;
	addWiffReply(options: AddWiffReplyOptions): Promise<void>;
	resolveWiffComment(options: ResolveWiffCommentOptions): Promise<void>;
	removeWiffSession(options: RemoveWiffSessionOptions): Promise<void>;
	resumeWiff(options: ResumeWiffOptions): Promise<void>;
	pullWiffReview(options: PullWiffReviewOptions): Promise<void>;
	pushWiffReview(options: PushWiffReviewOptions): Promise<void>;
	resolveCheckedOutPullRequest(
		repositoryRoot: string,
		signal?: AbortSignal,
	): Promise<{ number: number; githubToken: string }>;
	resolveGithubToken(repositoryRoot: string, signal?: AbortSignal): Promise<string>;
}

const defaultDependencies: ReviewDependencies = {
	async loadBorderedLoader() {
		const { BorderedLoader } = await import("@earendil-works/pi-coding-agent");
		return (tui, theme, message) => new BorderedLoader(tui, theme, message);
	},
	deriveWiffDataDir(piSessionId) {
		return deriveWiffDataDir(getAgentDir(), piSessionId);
	},
	async resolveRepositoryRoot(repository, signal) {
		return (await import("./review-git.ts")).resolveGitRepositoryRoot(repository, signal);
	},
	async resolveIntent(input) {
		const git = await import("./review-git.ts");
		const intent = await import("./review-intent.ts");
		const [staged, unstaged, untracked, overall] = await Promise.all([
			git.listGitReviewPaths(input.repositoryRoot, "staged", input.signal),
			git.listGitReviewPaths(input.repositoryRoot, "unstaged", input.signal),
			git.listGitReviewPaths(input.repositoryRoot, "untracked", input.signal),
			git.listGitReviewPaths(input.repositoryRoot, "overall", input.signal),
		]);
		return intent.runReviewIntent({
			...input,
			inventory: { staged, unstaged, untracked, overall },
		});
	},
	async readPatch(repository, selection, signal) {
		return (await import("./review-git.ts")).readGitReviewPatch(repository, selection, signal);
	},
	async runAudit(input) {
		return (await import("./audit.ts")).runAudit(input);
	},
	async runReviewSynthesis(input) {
		return (await import("./review-synthesis.ts")).runReviewSynthesis(input);
	},
	async reviewSnapshotsEqual(left, right) {
		return (await import("./review-git.ts")).reviewSnapshotsEqual(left, right);
	},
	hasWiffSession,
	createWiffSession,
	refreshWiffSession,
	readWiffState,
	renderWiffMarkdown,
	addWiffComment,
	addWiffReply,
	resolveWiffComment,
	removeWiffSession,
	resumeWiff,
	pullWiffReview,
	pushWiffReview,
	resolveCheckedOutPullRequest,
	resolveGithubToken,
};

/** Human-readable only: Review never parses this description back. */
export function describeCandidate(
	piSessionId: string,
	snapshot: ReviewSnapshot,
): string {
	return [
		`Pi review ${piSessionId}`,
		"",
		`View: ${snapshot.view}`,
		`Scope: ${snapshot.paths.length === 0 ? "all paths in the view" : snapshot.paths.join(" ")}`,
		`Repository: ${snapshot.repositoryRoot}`,
	].join("\n");
}

/** Compact operator summary of Wiff's own state. */
export function summarizeWiffState(state: WiffState): string {
	const human = state.verdicts.filter(({ author }) => author.kind === "human");
	const visible = state.comments.filter(({ deleted }) => !deleted);
	const open = visible.filter(({ resolved }) => !resolved).length;
	return [
		`Wiff review ${state.session.id}`,
		...(human.length === 0
			? ["Human verdicts: 0"]
			: [
				"Human verdicts:",
				...human.map(({ author, disposition }) => `  ${author.name}: ${disposition}`),
			]),
		`Comments: ${visible.length} total, ${open} open`,
	].join("\n");
}

function discussMessage(
	wiffDataDir: string,
	state: WiffState,
	markdown: string,
): string {
	return [
		`Discuss the feedback in Wiff session \`${state.session.id}\`, project \`${state.session.project}\`.`,
		`Its private Wiff data directory is \`${wiffDataDir}\`.`,
		"This turn is strictly read-only: do not edit files, run tests, mutate Wiff, or resolve comments.",
		"Investigate read-only evidence and help the user understand the unresolved feedback and options.",
		"",
		markdown,
	].join("\n");
}

function fixMessage(state: WiffState, markdown: string): string {
	const { id, project } = state.session;
	return [
		`Fix the unresolved feedback in Wiff session \`${id}\`, project \`${project}\`.`,
		"Edit the code, fix each root cause, and run relevant tests before changing comment state.",
		"Keep changes scoped to supported findings and ignore resolved or outdated comments.",
		"Then call `wiff_resolve` once for each comment completely addressed by this turn.",
		"Leave partially addressed or unclear comments unchanged.",
		"Do not launch the Wiff TUI or set a human verdict.",
		"",
		markdown,
	].join("\n");
}

interface PublicationFailure {
	readonly finding: AuditFinding;
	readonly published: number;
	readonly error: unknown;
}

function findingAuthor(finding: AuditFinding): string {
	return `review/${finding.category}`;
}

async function publishFindings(
	dependencies: ReviewDependencies,
	wiff: WiffPinnedOptions,
	findings: readonly AuditFinding[],
): Promise<PublicationFailure | undefined> {
	let published = 0;
	for (const finding of findings) {
		try {
			await dependencies.addWiffComment({
				...wiff,
				author: findingAuthor(finding),
				file: finding.filePath,
				line: finding.line,
				side: finding.side === "deletions" ? "before" : undefined,
				body: finding.message,
			});
		} catch (error) {
			return { finding, published, error };
		}
		published += 1;
	}
	return undefined;
}

function clearDiagnostics(ctx: ExtensionCommandContext): void {
	ctx.ui.setWidget(DIAGNOSTIC_WIDGET, undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function reportPublicationFailure(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	wiff: WiffPinnedOptions,
	created: boolean,
	total: number,
	failure: PublicationFailure,
): Promise<void> {
	const detail = errorMessage(failure.error);
	const author = findingAuthor(failure.finding);
	const side = failure.finding.side === "deletions" ? "before" : "after";
	ctx.ui.notify(
		`Review could not publish the ${failure.finding.category} finding for ${failure.finding.filePath}:${failure.finding.line}: ${detail}`,
		"error",
	);
	const cleanup = {
		repositoryRoot: wiff.repositoryRoot,
		wiffDataDir: wiff.wiffDataDir,
		session: wiff.session,
		project: wiff.project,
	};
	const remainder = created
		? await dependencies.removeWiffSession(cleanup).then(
			() => "Removed the newly created Wiff session.",
			(cause: unknown) =>
				`Failed to remove the newly created Wiff session: ${errorMessage(cause)}`,
		)
		: `Retained the refreshed Wiff session and its ${failure.published} published ${failure.published === 1 ? "comment" : "comments"}.`;
	ctx.ui.setWidget(DIAGNOSTIC_WIDGET, [
		"Review publication failed",
		`Wiff session: ${wiff.session} (project ${wiff.project})`,
		`Published: ${failure.published}/${total} findings`,
		`Failed finding: ${author} ${failure.finding.filePath}:${failure.finding.line} (${side})`,
		"Command: wiff comment add",
		`Error: ${detail}`,
		remainder,
	]);
	ctx.ui.setStatus(STATUS_KEY, PUBLICATION_FAILED_STATUS);
}

type LoaderOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: unknown; readonly cancelled: boolean };

async function withLoader<T>(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	message: string,
	cancelledMessage: string,
	parentSignal: AbortSignal,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const createLoader = await dependencies.loadBorderedLoader();
	const outcome = await ctx.ui.custom<LoaderOutcome<T>>((tui, theme, _keybindings, done) => {
		const loader = createLoader(tui, theme, message);
		const signal = AbortSignal.any([parentSignal, loader.signal]);
		void Promise.resolve().then(() => operation(signal)).then(
			(value) => {
				if (signal.aborted) {
					done({
						ok: false,
						error: signal.reason ?? new Error(cancelledMessage),
						cancelled: loader.signal.aborted && !parentSignal.aborted,
					});
					return;
				}
				done({ ok: true, value });
			},
			(cause: unknown) => done({
				ok: false,
				error: cause,
				cancelled: loader.signal.aborted && !parentSignal.aborted,
			}),
		);
		return loader;
	});
	parentSignal.throwIfAborted();
	if (outcome.ok) return outcome.value;
	if (outcome.cancelled) throw new Error(cancelledMessage);
	throw outcome.error;
}

type TuiOutcome = { readonly failed: false } | { readonly failed: true; readonly error: unknown };

async function handOverToWiff(
	ctx: ExtensionCommandContext,
	parentSignal: AbortSignal,
	operation: (tui: WiffTui) => Promise<void>,
): Promise<void> {
	const outcome = await ctx.ui.custom<TuiOutcome>((tui, _theme, _keybindings, done) => {
		void operation(tui).then(
			() => done({ failed: false }),
			(cause: unknown) => done({ failed: true, error: cause }),
		);
		return {
			render: () => [],
			handleInput() {},
			invalidate() {},
		};
	});
	parentSignal.throwIfAborted();
	if (outcome.failed) throw outcome.error;
}

interface ResolvedExistingReview {
	readonly base: WiffBaseOptions;
	readonly pinned: WiffPinnedOptions;
	readonly state: WiffState;
}

function pinWiffState(base: WiffBaseOptions, state: WiffState): WiffPinnedOptions {
	return {
		...base,
		session: state.session.id,
		project: state.session.project,
	};
}

async function readPrivateReviewState(
	dependencies: ReviewDependencies,
	base: WiffBaseOptions,
): Promise<WiffState> {
	try {
		return await dependencies.readWiffState(base);
	} catch (error) {
		throw new Error(
			"This Pi session has a private Wiff review, but it is unavailable from the current repository; return to the review's repository to open or remove it, or use a new Pi session here. " +
			`Wiff reported: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}

async function resolveExistingReview(
	dependencies: ReviewDependencies,
	repository: string,
	wiffDataDir: string,
	signal: AbortSignal,
): Promise<ResolvedExistingReview> {
	const repositoryRoot = await dependencies.resolveRepositoryRoot(repository, signal);
	const base = { repositoryRoot, wiffDataDir, signal };
	if (!(await dependencies.hasWiffSession(base))) {
		throw new Error(
			"No private Wiff review exists for this Pi session; use /review pull or /review audit.",
		);
	}
	const state = await readPrivateReviewState(dependencies, base);
	return { base, pinned: pinWiffState(base, state), state };
}

async function inspectPinnedReview(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	base: WiffBaseOptions,
	pinned: WiffPinnedOptions,
	parentSignal: AbortSignal,
): Promise<WiffState | undefined> {
	return await withLoader(
		ctx,
		dependencies,
		"Reading Wiff review…",
		"Wiff review inspection cancelled",
		parentSignal,
		async (signal) => {
			const exactBase = { ...base, signal };
			if (!(await dependencies.hasWiffSession(exactBase))) return undefined;
			return await dependencies.readWiffState({ ...pinned, signal });
		},
	);
}

function uniqueAuthors(state: WiffState): WiffAuthor[] {
	const authors = [
		...(state.description ? [state.description.author] : []),
		...state.comments.map(({ author }) => author),
		...state.verdicts.map(({ author }) => author),
	];
	const seen = new Set<string>();
	return authors.filter((author) => {
		const key = `${author.name}\0${author.kind}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function runPull(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	wiffDataDir: string,
	parentSignal: AbortSignal,
): Promise<void> {
	const resolved = await withLoader(
		ctx,
		dependencies,
		"Finding pull request…",
		"Pull request lookup cancelled",
		parentSignal,
		async (signal) => {
			const repositoryRoot = await dependencies.resolveRepositoryRoot(ctx.cwd, signal);
			const base = { repositoryRoot, wiffDataDir, signal };
			if (await dependencies.hasWiffSession(base)) {
				throw new Error(
					"A private Wiff review already exists for this Pi session; use /review open (Ctrl-R syncs forge reviews), /review remove, or a new Pi session.",
				);
			}
			const pullRequest = await dependencies.resolveCheckedOutPullRequest(repositoryRoot, signal);
			return { base, pullRequest };
		},
	);
	ctx.ui.notify(
		`Wiff is syncing pull request #${resolved.pullRequest.number}; handing over the terminal.`,
		"info",
	);
	await handOverToWiff(ctx, parentSignal, async (tui) => {
		await dependencies.pullWiffReview({
			...resolved.base,
			pullRequestNumber: resolved.pullRequest.number,
			githubToken: resolved.pullRequest.githubToken,
			tui,
		});
	});
	const state = await withLoader(
		ctx,
		dependencies,
		"Reading Wiff review…",
		"Wiff review inspection cancelled",
		parentSignal,
		async (signal) => {
			const base = { ...resolved.base, signal };
			if (!(await dependencies.hasWiffSession(base))) return undefined;
			return await dependencies.readWiffState(base);
		},
	);
	ctx.ui.notify(
		state
			? summarizeWiffState(state)
			: `No private Wiff review remains after pull request #${resolved.pullRequest.number}.`,
		"info",
	);
}

interface AuditCapture {
	readonly repositoryRoot: string;
	readonly intent: ResolvedReviewIntent;
	readonly patch: ReviewPatch;
}

async function runLocalAudit(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	piSessionId: string,
	wiffDataDir: string,
	scope: string,
	parentSignal: AbortSignal,
	recordScope?: (scope: ReviewScopeEntryData) => void,
): Promise<string | undefined> {
	const directory = ctx.sessionManager.getSessionDir();
	if (!directory) throw new Error("/review audit requires a Pi session directory for child agents");
	const parentSession = { directory, id: piSessionId };
	const capture = await withLoader(
		ctx,
		dependencies,
		"Luna is resolving review scope…",
		"Review scope resolution cancelled",
		parentSignal,
		async (signal): Promise<AuditCapture> => {
			const repositoryRoot = await dependencies.resolveRepositoryRoot(ctx.cwd, signal);
			const intent = await dependencies.resolveIntent({
				repositoryRoot,
				request: scope,
				parentSession,
				signal,
			});
			const capturedPatch = await dependencies.readPatch(repositoryRoot, intent.selection, signal);
			return { repositoryRoot, intent, patch: capturedPatch };
		},
	);
	recordScope?.(scopeEntryData(capture.intent));
	const { intent, patch, repositoryRoot } = capture;
	if (patch.snapshot.repositoryRoot !== repositoryRoot)
		throw new Error("Review capture returned a different repository root");
	if (!selectionMatchesSnapshot(intent.selection, patch.snapshot))
		throw new Error("Review capture did not preserve the resolved view and path selection");
	if (patch.empty) {
		const selected = intent.selection.paths.length === 0
			? ""
			: ` in the selected ${intent.selection.paths.length === 1 ? "path" : "paths"}`;
		throw new Error(`/review found no ${intent.selection.view} changes${selected}.`);
	}
	const requireFreshCandidate = async (signal: AbortSignal): Promise<void> => {
		const current = await dependencies.readPatch(repositoryRoot, intent.selection, signal);
		if (!(await dependencies.reviewSnapshotsEqual(patch.snapshot, current.snapshot))) {
			throw new Error("Selected candidate changed during audit; run /review again");
		}
	};

	parentSignal.throwIfAborted();
	ctx.ui.notify(`Review started: ${REVIEWER_COUNT} agents.`, "info");
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
	let audit: AuditResult;
	try {
		audit = await dependencies.runAudit({
			repositoryRoot,
			patch,
			parentSession,
			signal: parentSignal,
			onProgress: (update) => renderProgress(ctx, progress, expanded, update),
			guidance: scope || undefined,
		});
	} finally {
		progressActive = false;
		stopWatchingInput();
		ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
	}
	parentSignal.throwIfAborted();
	const synthesis = await withLoader(
		ctx,
		dependencies,
		"Synthesizing review findings…",
		"Review synthesis cancelled",
		parentSignal,
		async (signal) => {
			const base: WiffBaseOptions = { repositoryRoot, wiffDataDir, signal };
			const existing = await dependencies.hasWiffSession(base);
			if (existing) {
				const state = await readPrivateReviewState(dependencies, base);
				if (state.session.source !== "stdin") {
					throw new Error(
						`Wiff review ${state.session.id} has source ${JSON.stringify(state.session.source)}, not stdin; use /review open, /review remove, or a new Pi session.`,
					);
				}
				const pinned = pinWiffState(base, state);
				const findings = await dependencies.runReviewSynthesis({
					repositoryRoot,
					patch,
					candidates: audit.findings,
					openComments: synthesisWiffComments(state),
					parentSession,
					signal,
				});
				return { existing: true as const, state, pinned, findings };
			}
			const findings = await dependencies.runReviewSynthesis({
				repositoryRoot,
				patch,
				candidates: audit.findings,
				openComments: [],
				parentSession,
				signal,
			});
			return { existing: false as const, findings };
		},
	);
	const published = await withLoader(
		ctx,
		dependencies,
		"Publishing review to Wiff…",
		"Review publication cancelled",
		parentSignal,
		async (signal) => {
			await requireFreshCandidate(signal);
			const base: WiffBaseOptions = { repositoryRoot, wiffDataDir, signal };
			let state: WiffState;
			let pinned: WiffPinnedOptions;
			if (synthesis.existing) {
				state = synthesis.state;
				pinned = {
					...base,
					session: synthesis.pinned.session,
					project: synthesis.pinned.project,
				};
				await dependencies.refreshWiffSession({
					...pinned,
					patch: patch.snapshot.raw,
				});
			} else {
				await dependencies.createWiffSession({
					...base,
					patch: patch.snapshot.raw,
					description: describeCandidate(piSessionId, patch.snapshot),
				});
				state = await dependencies.readWiffState(base);
				pinned = pinWiffState(base, state);
			}
			const failure = await publishFindings(dependencies, pinned, synthesis.findings);
			if (failure && signal.aborted && !synthesis.existing) {
				await dependencies.removeWiffSession({
					repositoryRoot,
					wiffDataDir,
					session: pinned.session,
					project: pinned.project,
				}).catch(() => undefined);
			}
			return { existing: synthesis.existing, state, failure };
		},
	);
	const base: WiffBaseOptions = { repositoryRoot, wiffDataDir, signal: parentSignal };
	const pinned = pinWiffState(base, published.state);
	if (published.failure) {
		await reportPublicationFailure(
			ctx,
			dependencies,
			pinned,
			!published.existing,
			synthesis.findings.length,
			published.failure,
		);
		return;
	}
	ctx.ui.notify(
		`Review published ${findingText(synthesis.findings.length)} to Wiff review ${pinned.session}.`,
		"info",
	);
	ctx.ui.notify(`Opening Wiff review ${pinned.session}; handing over the terminal.`, "info");
	await handOverToWiff(ctx, parentSignal, async (tui) => {
		await dependencies.resumeWiff({ ...pinned, tui });
	});
	const after = await withLoader(
		ctx,
		dependencies,
		"Reading Wiff review…",
		"Wiff review inspection cancelled",
		parentSignal,
		async (signal) => {
			const exactBase = { ...base, signal };
			if (!(await dependencies.hasWiffSession(exactBase))) return undefined;
			const state = await dependencies.readWiffState({ ...pinned, signal });
			const markdown = await dependencies.renderWiffMarkdown({ ...pinned, signal });
			return { state, markdown };
		},
	);
	ctx.ui.notify(
		after
			? summarizeWiffState(after.state)
			: `Wiff removed review ${pinned.session}; run /review again to start a new one.`,
		"info",
	);
	return after ? discussMessage(wiffDataDir, after.state, after.markdown) : undefined;
}

async function runOpen(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	wiffDataDir: string,
	parentSignal: AbortSignal,
): Promise<void> {
	const resolved = await withLoader(
		ctx,
		dependencies,
		"Opening Wiff review…",
		"Wiff review lookup cancelled",
		parentSignal,
		(signal) => resolveExistingReview(dependencies, ctx.cwd, wiffDataDir, signal),
	);
	ctx.ui.notify(`Opening Wiff review ${resolved.pinned.session}; handing over the terminal.`, "info");
	await handOverToWiff(ctx, parentSignal, async (tui) => {
		await dependencies.resumeWiff({ ...resolved.pinned, tui });
	});
	const state = await inspectPinnedReview(
		ctx,
		dependencies,
		resolved.base,
		resolved.pinned,
		parentSignal,
	);
	ctx.ui.notify(
		state
			? summarizeWiffState(state)
			: `Wiff removed review ${resolved.pinned.session}.`,
		"info",
	);
}

interface FeedbackSubmission {
	readonly feedback: string;
	readonly fixTurn?: FixTurn;
}

async function runFeedback(
	mode: "discuss" | "fix",
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	wiffDataDir: string,
	parentSignal: AbortSignal,
): Promise<FeedbackSubmission> {
	const resolved = await withLoader(
		ctx,
		dependencies,
		"Reading Wiff review…",
		"Wiff review reading cancelled",
		parentSignal,
		async (signal) => {
			const review = await resolveExistingReview(dependencies, ctx.cwd, wiffDataDir, signal);
			const markdown = await dependencies.renderWiffMarkdown(review.pinned);
			return { state: review.state, pinned: review.pinned, markdown };
		},
	);
	if (mode === "discuss") {
		return { feedback: discussMessage(wiffDataDir, resolved.state, resolved.markdown) };
	}
	const feedback = fixMessage(resolved.state, resolved.markdown);
	const { repositoryRoot, wiffDataDir: dataDir, session, project } = resolved.pinned;
	return {
		feedback,
		fixTurn: {
			prompt: feedback,
			target: { repositoryRoot, wiffDataDir: dataDir, session, project },
		},
	};
}

async function runPush(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	wiffDataDir: string,
	parentSignal: AbortSignal,
): Promise<void> {
	const resolved = await withLoader(
		ctx,
		dependencies,
		"Reading Wiff review…",
		"Wiff review reading cancelled",
		parentSignal,
		(signal) => resolveExistingReview(dependencies, ctx.cwd, wiffDataDir, signal),
	);
	const authors = uniqueAuthors(resolved.state);
	if (authors.length === 0) throw new Error(`Wiff review ${resolved.pinned.session} has no authors to push`);
	const labels = authors.map(({ name, kind }) => `${name} (${kind})`);
	const choice = await ctx.ui.select("Push review author", labels, { signal: parentSignal });
	parentSignal.throwIfAborted();
	if (!choice) return;
	const author = authors[labels.indexOf(choice)];
	if (!author) throw new Error("Selected Wiff author is no longer available");
	const verdict = resolved.state.verdicts.find(({ author: candidate }) =>
		candidate.name === author.name && candidate.kind === author.kind
	)?.disposition;
	const confirmed = await ctx.ui.confirm(
		`Publish ${author.name} (${author.kind})?`,
		[
			`Session: ${resolved.pinned.session}`,
			`Project: ${resolved.pinned.project}`,
			`Author: ${author.name}`,
			`Kind: ${author.kind}`,
			`Verdict: ${verdict ? `${verdict} (may be submitted)` : "none"}`,
			"",
			"This publishes review feedback, not Git commits.",
		].join("\n"),
		{ signal: parentSignal },
	);
	parentSignal.throwIfAborted();
	if (!confirmed) return;
	await withLoader(
		ctx,
		dependencies,
		"Publishing Wiff review…",
		"Wiff review publication cancelled",
		parentSignal,
		async (signal) => {
			const githubToken = await dependencies.resolveGithubToken(
				resolved.pinned.repositoryRoot,
				signal,
			);
			await dependencies.pushWiffReview({
				...resolved.pinned,
				signal,
				author: author.name,
				agent: author.kind === "agent",
				githubToken,
			});
		},
	);
	ctx.ui.notify(
		`Published ${author.name} (${author.kind}) from Wiff review ${resolved.pinned.session}.`,
		"info",
	);
}

async function runRemove(
	ctx: ExtensionCommandContext,
	dependencies: ReviewDependencies,
	wiffDataDir: string,
	parentSignal: AbortSignal,
): Promise<void> {
	const resolved = await withLoader(
		ctx,
		dependencies,
		"Reading Wiff review…",
		"Wiff review reading cancelled",
		parentSignal,
		(signal) => resolveExistingReview(dependencies, ctx.cwd, wiffDataDir, signal),
	);
	const openComments = resolved.state.comments
		.filter(({ deleted, resolved: isResolved }) => !deleted && !isResolved)
		.length;
	const confirmed = await ctx.ui.confirm(
		`Remove Wiff review ${resolved.pinned.session}?`,
		[
			`Session: ${resolved.pinned.session}`,
			`Project: ${resolved.pinned.project}`,
			...(resolved.state.description?.title
				? [`Title: ${resolved.state.description.title}`]
				: []),
			`Open comments: ${openComments}`,
		].join("\n"),
		{ signal: parentSignal },
	);
	parentSignal.throwIfAborted();
	if (!confirmed) return;
	await withLoader(
		ctx,
		dependencies,
		"Removing Wiff review…",
		"Wiff review removal cancelled",
		parentSignal,
		async (signal) => {
			await dependencies.removeWiffSession({ ...resolved.pinned, signal });
		},
	);
	ctx.ui.notify(`Removed Wiff review ${resolved.pinned.session}.`, "info");
}

export interface ReviewController {
	/** Submits feedback inside the shutdown-tracked run when a callback is provided. */
	run(
		argument: string,
		ctx: ExtensionCommandContext,
		submitFeedback?: (
			feedback: string,
			fixTurn?: FixTurn,
		) => void | Promise<void>,
		recordScope?: (scope: ReviewScopeEntryData) => void,
	): Promise<string | undefined>;
	shutdown(): Promise<void>;
}

export function createReviewController(
	dependencies: ReviewDependencies = defaultDependencies,
): ReviewController {
	const activeAborts = new Set<AbortController>();
	const activeRuns = new Set<Promise<void>>();
	let shuttingDown = false;

	return {
		async run(argument, ctx, submitFeedback, recordScope) {
			let settleRun!: () => void;
			const runSettled = new Promise<void>((resolve) => { settleRun = resolve; });
			activeRuns.add(runSettled);
			const aborts = new AbortController();
			activeAborts.add(aborts);
			try {
				if (shuttingDown) throw new Error("Review session is shutting down");
				if (ctx.mode !== "tui") throw new Error("/review requires TUI mode");
				await ctx.waitForIdle();
				if (shuttingDown) throw new Error("Review session is shutting down");
				clearDiagnostics(ctx);
				const piSessionId = ctx.sessionManager.getSessionId();
				if (!piSessionId) throw new Error("/review requires a non-empty Pi session ID");
				const wiffDataDir = dependencies.deriveWiffDataDir(piSessionId);
				let routed = routeReviewArgument(argument);
				if (!routed) {
					const choice = await ctx.ui.select(
						"Review action",
						REVIEW_ACTIONS.map(({ name }) => name),
						{ signal: aborts.signal },
					);
					aborts.signal.throwIfAborted();
					if (!choice) return;
					routed = routeReviewArgument(choice);
					if (!routed) return;
				}
				switch (routed.action) {
					case "pull":
						await runPull(ctx, dependencies, wiffDataDir, aborts.signal);
						break;
					case "audit": {
						const feedback = await runLocalAudit(
							ctx,
							dependencies,
							piSessionId,
							wiffDataDir,
							routed.scope,
							aborts.signal,
							recordScope,
						);
						if (!feedback) break;
						if (!submitFeedback) return feedback;
						await submitFeedback(feedback);
						break;
					}
					case "open":
						await runOpen(ctx, dependencies, wiffDataDir, aborts.signal);
						break;
					case "discuss":
					case "fix": {
						const submission = await runFeedback(
							routed.action,
							ctx,
							dependencies,
							wiffDataDir,
							aborts.signal,
						);
						if (!submitFeedback) return submission.feedback;
						await submitFeedback(submission.feedback, submission.fixTurn);
						break;
					}
					case "push":
						await runPush(ctx, dependencies, wiffDataDir, aborts.signal);
						break;
					case "remove":
						await runRemove(ctx, dependencies, wiffDataDir, aborts.signal);
						break;
				}
				return undefined;
			} finally {
				activeAborts.delete(aborts);
				settleRun();
				activeRuns.delete(runSettled);
			}
		},

		async shutdown() {
			shuttingDown = true;
			for (const aborts of activeAborts) aborts.abort(new Error("Review session shut down"));
			activeAborts.clear();
			await Promise.allSettled([...activeRuns]);
		},
	};
}

export function registerReview(
	pi: ExtensionAPI,
	dependencies: ReviewDependencies = defaultDependencies,
): void {
	const controller = createReviewController(dependencies);
	const fixController = registerWiffResolveTool(pi, dependencies);
	pi.registerEntryRenderer<ReviewScopeEntryData>(REVIEW_SCOPE_ENTRY, (entry, { expanded }, theme) => {
		if (!entry.data) return undefined;
		return {
			render: (width) => scopeEntryText(entry.data!, expanded).split("\n")
				.map((line) => theme.fg("accent", truncateToWidth(line, width))),
			invalidate() {},
		};
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.abort();
		await controller.shutdown();
	});
	pi.registerCommand("review", {
		description: "Manage this Pi session's private Wiff review",
		getArgumentCompletions: completeReviewAction,
		async handler(argument, ctx) {
			try {
				await controller.run(argument, ctx, async (feedback, fixTurn) => {
					await ctx.waitForIdle();
					if (fixTurn) fixController.arm(fixTurn);
					else fixController.clear();
					try {
						pi.sendUserMessage(feedback);
					} catch (error) {
						fixController.clear();
						throw error;
					}
					ctx.ui.notify("Review queued for Pi.", "info");
				}, (scope) => pi.appendEntry(REVIEW_SCOPE_ENTRY, scope));
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}

export default function review(pi: ExtensionAPI): void {
	if (isAuditResultChild()) {
		registerAuditResultTool(pi);
		return;
	}
	if (isReviewIntentChild()) {
		registerReviewIntentResultTool(pi);
		return;
	}
	registerReview(pi);
}
