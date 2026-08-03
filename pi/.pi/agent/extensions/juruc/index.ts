import {
	createLocalBashOperations,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	keyHint,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { lstatSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	BUILD_INSTRUCTION,
	BUILD_TOOL_NAMES,
	expectedTaskHead,
	FINISH_PHASE_SCHEMA,
	finishCurrentPhase,
	persistCheckpointTask,
	RUN_VERIFICATION_SCHEMA,
	runDeclaredVerification,
	type FinishPhaseInput,
	type RunVerificationInput,
} from "./execution.ts";
import {
	CORRECTION_INSTRUCTION,
	CORRECTION_TOOL_NAMES,
	correctionPrompt,
	FINISH_CORRECTION_SCHEMA,
	finishCorrection,
	runCorrectionVerification,
	type FinishCorrectionInput,
} from "./correction.ts";
import { taskOptions, type TaskChoice } from "./picker.ts";
import {
	confirmTaskPlan,
	PLAN_DECISION_TITLE,
	PLAN_DECISION_UNRESOLVED,
	PLAN_DECISIONS,
	PLAN_REVISION_TITLE,
	planningPrompt,
	PLANNING_INSTRUCTION,
	PLANNING_RESUME_INSTRUCTION,
	PLANNING_TOOL_NAMES,
	planRevisionRequest,
	SET_PLAN_SCHEMA,
	type SetPlanInput,
} from "./planning.ts";
import {
	questionsPrompt,
	QUESTIONS_INSTRUCTION,
	QUESTIONS_TOOL_NAMES,
	SET_QUESTIONS_SCHEMA,
	setTaskQuestions,
	type SetQuestionsInput,
} from "./questions.ts";
import {
	loadResearchBrief,
	RESEARCH_AGENT_NAMES,
	RESEARCH_INSTRUCTION,
	RESEARCH_TOOL_NAMES,
	researchKickoff,
	saveResearchBrief,
	successfulResearchSynthesis,
} from "./research.ts";
import { runtimePaths } from "./runtime.ts";
import {
	SET_SPECIFICATION_SCHEMA,
	setTaskSpecification,
	SPECIFICATION_INSTRUCTION,
	SPECIFICATION_TOOL_NAMES,
	specificationPrompt,
	type SetSpecificationInput,
} from "./specification.ts";
import { readGitReviewPatch, type ReviewPatch } from "./review-git.ts";
import { acquireTaskReviewLock } from "./review-lock.ts";
import {
	activeReviewServer,
	openSystemBrowser,
	type ReviewServerIdentity,
} from "./review-server.ts";
import {
	drivePiReviewer,
	runReviewer,
	type ReviewerDriver,
} from "./reviewers.ts";
import { lifecycleLine } from "./status.ts";
import { statusWidget } from "./status-widget.ts";
import {
	activateTaskPlan,
	appendTaskSession,
	completeTaskResearch,
	completeTaskReviewer,
	currentTaskCorrectionRound,
	currentTaskPhase,
	currentTaskReviewRound,
	findTaskSession,
	findTaskSessionByPath,
	loadTaskDocument,
	registerTaskCorrectionStart,
	registerTaskReviewerStart,
	saveTaskDocument,
	type DiscoverySessionKind,
	type ReviewDecision,
	type ReviewerKind,
	type TaskDocument,
	type TaskReviewRound,
	type TaskSessionRun,
} from "./task.ts";
import {
	createTask,
	findTaskBySession,
	listTasks,
	loadTask,
	removeInvalidTaskRecord,
	removeTaskRecord,
	saveTask,
	slugify,
	type StoredTask,
	type TaskSummary,
	uniqueSlug,
	validTaskSlug,
} from "./tasks.ts";
import {
	copyTaskLocalFiles,
	ensureTaskWorktree,
	hasTaskWorktreeRegistration,
	inspectTaskWorktree,
	prepareRepository,
	recoverUnrecordedTaskCommits,
	removeTaskWorktree,
	validBranchName,
} from "./workspace.ts";

const JURUC_TOOLS = new Set([
	"juruc_set_questions",
	"juruc_set_specification",
	"juruc_set_plan",
	"juruc_run_verification",
	"juruc_finish_phase",
	"juruc_finish_correction",
]);
const RESEARCH_AGENTS = new Set<string>(RESEARCH_AGENT_NAMES);
type CurrentSessionKind = DiscoverySessionKind | "implementation" | "correction";

/** The one task-owned session kind that may act right now, if any. */
function activeSessionKind(task: TaskDocument): CurrentSessionKind | undefined {
	switch (task.stage) {
		// An accepted plan ends the Plan session even while its workspace activation is pending.
		case "plan":
			return task.plan ? undefined : "plan";
		case "questions":
		case "research":
		case "specification":
		case "implementation":
			return task.stage;
		case "review":
			return currentTaskCorrectionRound(task) ? "correction" : undefined;
		case "done":
			return undefined;
	}
}
type ReplacementContext = Parameters<
	NonNullable<
		NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]
	>
>[0];

function currentSessionPath(ctx: ExtensionContext): string | undefined {
	const path = ctx.sessionManager.getSessionFile();
	if (!path || !isAbsolute(path)) return undefined;
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function regularFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Offers the next stage to the operator by pre-filling the command one Enter away.
 * Terminal-only, because editor text is pure presentation: JURUC never reads it back,
 * never persists it, and never overwrites a draft the operator is already writing.
 */
function offerNextStage(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" || ctx.ui.getEditorText().trim()) return false;
	ctx.ui.setEditorText("/juruc");
	return true;
}

/** Truthful boundary text: what JURUC persisted, what is ready, and what it now costs. */
function readyText(ctx: ExtensionContext, persisted: string, next: string): string {
	return `${persisted} ${next} ready.${offerNextStage(ctx) ? " Press Enter to continue." : ""}`;
}

function expectedCwd(task: StoredTask): string {
	if (task.document.stage === "implementation" || task.document.stage === "review")
		return task.document.repository.worktree;
	if (task.document.stage === "specification") return task.directory;
	return task.document.repository.sourceRoot;
}

function sameWorkingDirectory(ctx: ExtensionContext, task: StoredTask): boolean {
	try {
		return realpathSync(ctx.cwd) === realpathSync(expectedCwd(task));
	} catch {
		return false;
	}
}

function sessionHasUserMessage(path: string): boolean {
	return SessionManager.open(path).getBranch().some(
		(entry) => entry.type === "message" && entry.message.role === "user",
	);
}

function createManagedSession(
	cwd: string,
	label: string,
	customType: string,
	instruction: string,
	parentSession?: string,
): string {
	const manager = SessionManager.create(
		cwd,
		undefined,
		parentSession ? { parentSession } : undefined,
	);
	manager.appendSessionInfo(label);
	manager.appendCustomMessageEntry(customType, instruction, false);
	const path = manager.getSessionFile();
	const header = manager.getHeader();
	if (!path || !header || !isAbsolute(path))
		throw new Error("JURUC could not initialize a managed session");
	try {
		writeFileSync(
			path,
			`${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		return realpathSync(path);
	} catch (error) {
		try {
			unlinkSync(path);
		} catch {}
		throw error;
	}
}

function implementationPrompt(task: StoredTask): string {
	const phase = currentTaskPhase(task.document);
	const specification = task.document.specification;
	const plan = task.document.plan;
	if (!phase || !specification || !plan) throw new Error("task has no active implementation phase");
	const position = task.document.checkpoints.length + 1;
	return [
		`Implementation phase ${position}/${plan.phases.length}: ${phase.title}`,
		"",
		"Validated Specification:",
		JSON.stringify(specification, null, 2),
		"",
		"Authoritative current phase:",
		JSON.stringify(phase, null, 2),
		"",
		"Prior checkpoint facts:",
		task.document.checkpoints.length
			? task.document.checkpoints
				.map((checkpoint, index) => `${index + 1}. ${checkpoint.id} · ${checkpoint.commit}`)
				.join("\n")
			: "None.",
		"",
		"Implement only this phase, run its declared verification exactly, and report structured evidence. Do not commit.",
	].join("\n");
}

function age(when: Date): string {
	const minutes = Math.round((Date.now() - when.getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return days < 7 ? `${days}d ago` : `${Math.round(days / 7)}w ago`;
}

function isSoleCurrentToolCall(
	ctx: ExtensionContext,
	event: { toolName: string; toolCallId?: string },
): boolean {
	if (!event.toolCallId) return false;
	const entry = ctx.sessionManager.getBranch().at(-1);
	if (entry?.type !== "message" || entry.message.role !== "assistant") return false;
	const calls = entry.message.content.filter(
		(content): content is Extract<typeof content, { type: "toolCall" }> =>
			typeof content === "object" && content !== null && content.type === "toolCall",
	);
	return calls.length === 1 && calls[0].id === event.toolCallId && calls[0].name === event.toolName;
}

export type ReviewPatchReader = (
	repository: string,
	baseCommit: string,
	headCommit: string,
) => Promise<ReviewPatch>;

export interface PrepareReviewInput {
	taskPath: string;
	parentSession?: string;
	readPatch?: ReviewPatchReader;
	reviewerDriver?: ReviewerDriver;
}

function reviewRoundIdentity(task: StoredTask, round: TaskReviewRound): ReviewServerIdentity {
	return {
		taskPath: join(task.directory, "task.json"),
		baseCommit: round.baseCommit,
		headCommit: round.headCommit,
	};
}

/** The live capability URL of this task's own open review round, or none. */
function liveReviewUrl(task: StoredTask): string | undefined {
	const round = currentTaskReviewRound(task.document);
	return task.document.stage === "review" && round && !round.decision
		? activeReviewServer.liveUrl(reviewRoundIdentity(task, round))
		: undefined;
}

function requireSameReviewRound(task: TaskDocument, expected: TaskReviewRound): TaskReviewRound {
	const round = currentTaskReviewRound(task);
	if (
		task.stage !== "review" ||
		!round ||
		round.number !== expected.number ||
		round.baseCommit !== expected.baseCommit ||
		round.headCommit !== expected.headCommit
	) throw new Error("authoritative review round changed during preparation");
	return round;
}

async function prepareReviewLocked(input: PrepareReviewInput): Promise<TaskDocument> {
	const readPatch = input.readPatch ?? readGitReviewPatch;
	const reviewerDriver = input.reviewerDriver ?? drivePiReviewer;
	let task = loadTaskDocument(input.taskPath);
	const expected = currentTaskReviewRound(task);
	if (task.stage !== "review" || !expected || !task.specification || !task.plan)
		throw new Error("task is not ready for review preparation");
	const patch = await readPatch(
		task.repository.worktree,
		expected.baseCommit,
		expected.headCommit,
	);
	if (
		patch.identity.baseOid !== expected.baseCommit ||
		patch.identity.headOid !== expected.headCommit
	) throw new Error("review patch identity differs from the persisted review round");

	for (const kind of ["deviation", "correctness"] as const satisfies readonly ReviewerKind[]) {
		task = loadTaskDocument(input.taskPath);
		let round = requireSameReviewRound(task, expected);
		const slot = round.reviewers[kind];
		if (slot?.outcome) continue;
		if (slot) {
			task = completeTaskReviewer(task, kind, {
				status: "failed",
				failureKind: "session-error",
				message: "reviewer session was interrupted before a terminal outcome was persisted",
			});
			saveTaskDocument(input.taskPath, task);
			continue;
		}
		if (!task.specification || !task.plan)
			throw new Error("authoritative review artifacts changed during preparation");

		const reviewerInput = {
			worktree: task.repository.worktree,
			patch,
			specification: task.specification,
			checkpoints: task.checkpoints,
			...(input.parentSession ? { parentSession: input.parentSession } : {}),
			onSessionCreated: async (sessionPath: string) => {
				const current = loadTaskDocument(input.taskPath);
				requireSameReviewRound(current, expected);
				saveTaskDocument(
					input.taskPath,
					registerTaskReviewerStart(current, kind, sessionPath),
				);
			},
		};
		const result = kind === "deviation"
			? await runReviewer({ ...reviewerInput, kind, plan: task.plan }, reviewerDriver)
			: await runReviewer({ ...reviewerInput, kind }, reviewerDriver);
		task = loadTaskDocument(input.taskPath);
		round = requireSameReviewRound(task, expected);
		if (round.reviewers[kind]?.sessionPath !== result.sessionPath)
			throw new Error(`${kind} reviewer session differs from authoritative task.json`);
		task = completeTaskReviewer(task, kind, result.outcome);
		saveTaskDocument(input.taskPath, task);
	}
	return loadTaskDocument(input.taskPath);
}

export async function prepareReview(input: PrepareReviewInput): Promise<TaskDocument> {
	const releaseReviewLock = acquireTaskReviewLock(input.taskPath);
	try {
		return await prepareReviewLocked(input);
	} finally {
		releaseReviewLock();
	}
}

export interface JurucDependencies {
	readPatch?: ReviewPatchReader;
	reviewerDriver?: ReviewerDriver;
	/** Best-effort handoff of the local capability URL to the operator's browser. */
	openBrowser?: (url: string) => Promise<void>;
}

export function registerJuruc(pi: ExtensionAPI, dependencies: JurucDependencies = {}): void {
	const paths = runtimePaths(getAgentDir());
	const verificationOperations = createLocalBashOperations();
	const readPatch = dependencies.readPatch ?? readGitReviewPatch;
	const openBrowser = dependencies.openBrowser ?? openSystemBrowser;
	const pendingSynthesis = new Map<string, { slug: string; session: string }>();
	let ordinaryTools: string[] | undefined;

	function taskForSession(ctx: ExtensionContext): StoredTask | undefined {
		const session = currentSessionPath(ctx);
		return session ? findTaskBySession(paths, session) : undefined;
	}

	function currentRun(task: TaskDocument, kind: CurrentSessionKind): TaskSessionRun | undefined {
		if (kind === "implementation")
			return findTaskSession(task, { kind, phase: task.checkpoints.length + 1 });
		if (kind === "correction") {
			const round = currentTaskCorrectionRound(task);
			return round ? findTaskSession(task, { kind, round: round.number }) : undefined;
		}
		return findTaskSession(task, { kind });
	}

	function showStatus(ctx: ExtensionContext, task = taskForSession(ctx)): void {
		if (!task) {
			ctx.ui.setWidget("juruc", undefined);
			return;
		}
		// Only the TUI renders a width-aware widget factory, so only it can show the review
		// link; every other mode gets the same lifecycle line as plain text.
		if (ctx.mode === "tui")
			ctx.ui.setWidget("juruc", statusWidget(task.document, liveReviewUrl(task)));
		else ctx.ui.setWidget("juruc", [lifecycleLine(task.document)]);
	}

	function sessionTools(kind: CurrentSessionKind, task: TaskDocument): readonly string[] {
		switch (kind) {
			case "questions":
				return QUESTIONS_TOOL_NAMES;
			case "research":
				return RESEARCH_TOOL_NAMES;
			case "specification":
				return SPECIFICATION_TOOL_NAMES;
			case "plan":
				return task.plan ? [] : PLANNING_TOOL_NAMES;
			case "implementation":
				return BUILD_TOOL_NAMES;
			case "correction":
				return CORRECTION_TOOL_NAMES;
		}
	}

	function activeSession(
		ctx: ExtensionContext,
		task: StoredTask | undefined,
	): CurrentSessionKind | undefined {
		if (!task) return undefined;
		const kind = activeSessionKind(task.document);
		const session = currentSessionPath(ctx);
		return kind &&
				session &&
				currentRun(task.document, kind)?.path === session &&
				sameWorkingDirectory(ctx, task)
			? kind
			: undefined;
	}

	function activateTools(ctx: ExtensionContext, task = taskForSession(ctx)): void {
		if (!ordinaryTools)
			ordinaryTools = pi.getActiveTools().filter((name) => !JURUC_TOOLS.has(name));
		if (!task || !currentSessionPath(ctx)) {
			pi.setActiveTools(ordinaryTools);
			return;
		}
		const kind = activeSession(ctx, task);
		if (!kind) {
			pi.setActiveTools([]);
			return;
		}
		const requested = sessionTools(kind, task.document);
		const registered = new Set(pi.getAllTools().map(({ name }) => name));
		const missing = requested.filter((name) => !registered.has(name));
		if (missing.length)
			throw new Error(`required ${kind} tools are unavailable: ${missing.join(", ")}`);
		pi.setActiveTools([...requested]);
	}

	function ownedTask(ctx: ExtensionContext, kind: CurrentSessionKind): StoredTask {
		const task = taskForSession(ctx);
		if (!task || activeSession(ctx, task) !== kind)
			throw new Error(
				`JURUC action requires the active ${kind} session; run /juruc to resume it`,
			);
		return task;
	}

	function saveSession(task: StoredTask, run: TaskSessionRun): StoredTask {
		return saveTask(task, appendTaskSession(task.document, run));
	}

	async function switchAndSend(
		ctx: ExtensionCommandContext,
		task: StoredTask,
		path: string,
		stage: TaskDocument["stage"],
		prompt: string,
		resumePrompt: string,
	): Promise<void> {
		if (!regularFile(path)) throw new Error(`${path}: managed session is unavailable`);
		const first = !sessionHasUserMessage(path);
		const result = await ctx.switchSession(path, {
			withSession: async (replacement: ReplacementContext) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage !== stage || !findTaskSessionByPath(current.document, path))
					throw new Error(`${task.document.slug}: task changed during session switch`);
				await replacement.sendUserMessage(first ? prompt : resumePrompt);
			},
		});
		if (result.cancelled)
			ctx.ui.notify(`${task.document.slug}: session switch cancelled`, "warning");
	}

	async function openQuestions(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "questions")
			throw new Error(`${task.document.slug}: task is not asking questions`);
		let session = findTaskSession(task.document, { kind: "questions" })?.path;
		if (!session) {
			session = createManagedSession(
				task.document.repository.sourceRoot,
				`${task.document.slug} · questions`,
				"juruc-questions-instruction",
				QUESTIONS_INSTRUCTION,
				ctx.sessionManager.getSessionFile(),
			);
			task = saveSession(task, { kind: "questions", path: session });
		}
		await switchAndSend(
			ctx,
			task,
			session,
			"questions",
			questionsPrompt(task.document.request),
			"Resume the one-choice-at-a-time interview and call juruc_set_questions only after explicit confirmation.",
		);
	}

	async function openResearch(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "research" || !task.document.questions)
			throw new Error(`${task.document.slug}: task is not ready for research`);
		const questions = task.document.questions;
		let session = findTaskSession(task.document, { kind: "research" })?.path;
		if (!session) {
			session = createManagedSession(
				task.document.repository.sourceRoot,
				`${task.document.slug} · research`,
				"juruc-research-instruction",
				RESEARCH_INSTRUCTION,
				findTaskSession(task.document, { kind: "questions" })?.path,
			);
			task = saveSession(task, { kind: "research", path: session });
		}
		await switchAndSend(
			ctx,
			task,
			session,
			"research",
			researchKickoff(
				task.document.request,
				questions,
				task.document.repository.sourceRoot,
			),
			"Resume proportional factual research and finish with a tool-free synthesizer report.",
		);
	}

	async function openSpecification(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "specification" || !task.document.questions)
			throw new Error(`${task.document.slug}: task is not ready for specification`);
		const questions = task.document.questions;
		const researchText = loadResearchBrief(task.directory);
		let session = findTaskSession(task.document, { kind: "specification" })?.path;
		if (!session) {
			session = createManagedSession(
				task.directory,
				`${task.document.slug} · specification`,
				"juruc-specification-instruction",
				SPECIFICATION_INSTRUCTION,
				findTaskSession(task.document, { kind: "research" })?.path,
			);
			task = saveSession(task, { kind: "specification", path: session });
		}
		await switchAndSend(
			ctx,
			task,
			session,
			"specification",
			specificationPrompt(task.document.request, questions, researchText),
			"Resume the implementation-neutral specification and call juruc_set_specification as the sole tool call.",
		);
	}

	async function activatePendingPlan(
		ctx: ExtensionContext,
		task: StoredTask,
	): Promise<StoredTask> {
		if (task.document.stage !== "plan" || !task.document.plan)
			throw new Error(`${task.document.slug}: task has no accepted plan pending activation`);
		showStatus(ctx, task);
		if (taskForSession(ctx)?.document.slug === task.document.slug)
			activateTools(ctx, task);
		try {
			await ensureTaskWorktree(task.document.repository);
			await copyTaskLocalFiles(task.document.repository);
			return saveTask(task, activateTaskPlan(task.document));
		} catch (error) {
			throw new Error(
				`${task.document.slug}: plan accepted but workspace activation failed; run /juruc to retry — ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async function openPlan(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "plan" || !task.document.specification)
			throw new Error(`${task.document.slug}: task is not ready for planning`);
		const specification = task.document.specification;
		if (task.document.plan) {
			task = await activatePendingPlan(ctx, task);
			await openImplementation(ctx, task);
			return;
		}
		let session = findTaskSession(task.document, { kind: "plan" })?.path;
		if (!session) {
			session = createManagedSession(
				task.document.repository.sourceRoot,
				`${task.document.slug} · plan`,
				"juruc-plan-instruction",
				PLANNING_INSTRUCTION,
				findTaskSession(task.document, { kind: "specification" })?.path,
			);
			task = saveSession(task, { kind: "plan", path: session });
		}
		await switchAndSend(
			ctx,
			task,
			session,
			"plan",
			planningPrompt(specification),
			PLANNING_RESUME_INSTRUCTION,
		);
	}

	async function openImplementation(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "implementation" || !currentTaskPhase(task.document))
			throw new Error(`${task.document.slug}: task has no active implementation phase`);
		if (await recoverUnrecordedTaskCommits(
			task.document.repository,
			expectedTaskHead(task.document),
		)) ctx.ui.notify(`${task.document.slug}: recovered an unrecorded implementation commit`, "warning");
		const phase = task.document.checkpoints.length + 1;
		let session = findTaskSession(task.document, { kind: "implementation", phase })?.path;
		if (!session) {
			session = createManagedSession(
				task.document.repository.worktree,
				`${task.document.slug} · phase ${phase}`,
				"juruc-implementation-instruction",
				BUILD_INSTRUCTION,
				phase === 1
					? findTaskSession(task.document, { kind: "plan" })?.path
					: findTaskSession(task.document, { kind: "implementation", phase: phase - 1 })?.path,
			);
			task = saveSession(task, { kind: "implementation", phase, path: session });
		}
		await switchAndSend(
			ctx,
			task,
			session,
			"implementation",
			implementationPrompt(task),
			"Resume only the authoritative active phase and its dirty worktree; verify it and call juruc_finish_phase when all evidence is zero.",
		);
	}

	/** Routes the persisted decision once the deciding response and its server are done. */
	function routeReviewDecision(
		ctx: ExtensionCommandContext,
		slug: string,
		decision: ReviewDecision,
	): void {
		void (async () => {
			try {
				await activeReviewServer.close();
				const task = loadTask(paths, slug);
				showStatus(ctx, task);
				if (decision.kind === "approve") {
					await viewDone(ctx, task);
					return;
				}
				await ctx.waitForIdle();
				await openReview(ctx, task);
			} catch (error) {
				try {
					ctx.ui.notify(
						`${slug}: decision recorded but JURUC could not continue automatically; run /juruc — ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				} catch {}
			}
		})();
	}

	async function serveReview(ctx: ExtensionCommandContext, task: StoredTask): Promise<void> {
		const round = currentTaskReviewRound(task.document)!;
		const slug = task.document.slug;
		const identity = reviewRoundIdentity(task, round);
		const onDecision = (decision: ReviewDecision) => routeReviewDecision(ctx, slug, decision);
		// A live server keeps its capability URL and routes its decision to this session;
		// only a closed one issues a fresh URL.
		const url = activeReviewServer.reuse(identity, onDecision) ?? (await activeReviewServer.serve({
			patch: await readPatch(
				task.document.repository.worktree,
				round.baseCommit,
				round.headCommit,
			),
			taskPath: identity.taskPath,
			onDecision,
		})).url;
		// Never touch the captured `pi` here: a routed decision runs this after session
		// replacement, where the old extension instance's tool handle is already stale.
		showStatus(ctx, task);
		try {
			await openBrowser(url);
		} catch (error) {
			ctx.ui.notify(
				`${slug}: could not open a browser automatically — ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	async function openReview(ctx: ExtensionCommandContext, selected: StoredTask): Promise<void> {
		let task = selected;
		if (task.document.stage !== "review")
			throw new Error(`${task.document.slug}: task is not in review`);
		const round = currentTaskReviewRound(task.document)!;
		if (round.decision?.kind === "send-feedback") {
			await activeReviewServer.close();
			showStatus(ctx, task);
			await openCorrection(ctx, task);
			return;
		}
		if (Object.values(round.reviewers).some((slot) => !slot?.outcome)) {
			await activeReviewServer.close();
			showStatus(ctx, task);
			const parentSession = round.number === 1
				? findTaskSession(task.document, {
					kind: "implementation",
					phase: task.document.plan!.phases.length,
				})?.path
				: findTaskSession(task.document, { kind: "correction", round: round.number - 1 })?.path;
			await prepareReview({
				taskPath: join(task.directory, "task.json"),
				...(parentSession ? { parentSession } : {}),
				readPatch,
				reviewerDriver: dependencies.reviewerDriver,
			});
			task = loadTask(paths, task.document.slug);
		}
		await serveReview(ctx, task);
	}

	async function openCorrection(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		const round = currentTaskReviewRound(task.document)!;
		if (round.decision?.kind !== "send-feedback" || round.correction?.result)
			throw new Error(`${task.document.slug}: task has no pending correction`);
		if (await recoverUnrecordedTaskCommits(
			task.document.repository,
			expectedTaskHead(task.document),
		)) ctx.ui.notify(`${task.document.slug}: recovered an unrecorded correction commit`, "warning");
		let session = round.correction?.sessionPath;
		if (!session) {
			session = createManagedSession(
				task.document.repository.worktree,
				`${task.document.slug} · correction ${round.number}`,
				"juruc-correction-instruction",
				CORRECTION_INSTRUCTION,
				findTaskSession(task.document, { kind: "correctness-review", round: round.number })?.path,
			);
			task = saveTask(task, registerTaskCorrectionStart(task.document, session));
		}
		await switchAndSend(
			ctx,
			task,
			session,
			"review",
			correctionPrompt(task.document, currentTaskReviewRound(task.document)!),
			"Resume only the saved human comments for this round; verify with accepted Plan commands and call juruc_finish_correction when all evidence is zero.",
		);
	}

	/** The read-only completed-task summary: no session switch and no reopened Plan. */
	async function viewDone(ctx: ExtensionCommandContext, task: StoredTask): Promise<void> {
		const { branch, worktree } = task.document.repository;
		ctx.ui.notify(
			`${task.document.slug}: done · ${branch} · ${worktree} · ${expectedTaskHead(task.document).slice(0, 12)}`,
			"info",
		);
	}

	async function openTask(ctx: ExtensionCommandContext, slug: string): Promise<void> {
		const task = loadTask(paths, slug);
		switch (task.document.stage) {
			case "questions":
				await openQuestions(ctx, task);
				return;
			case "research":
				await openResearch(ctx, task);
				return;
			case "specification":
				await openSpecification(ctx, task);
				return;
			case "plan":
				await openPlan(ctx, task);
				return;
			case "implementation":
				await openImplementation(ctx, task);
				return;
			case "review":
				await openReview(ctx, task);
				return;
			case "done":
				await viewDone(ctx, task);
		}
	}

	async function pickTask(
		ctx: ExtensionCommandContext,
		tasks: TaskSummary[],
	): Promise<TaskChoice> {
		if (ctx.mode !== "tui") {
			const options = taskOptions(tasks);
			const label = await ctx.ui.select("JURUC tasks", options.map((option) => option.label));
			return label
				? options.find((option) => option.label === label)?.choice ?? { action: "cancel" }
				: { action: "cancel" };
		}
		return ctx.ui.custom<TaskChoice>((tui, theme, keybindings, done) => {
			const border = new DynamicBorder((text: string) => theme.fg("border", text));
			const input = new Input();
			let list: SelectList;
			const choose = (item: SelectItem) => {
				if (item.value === "new:") done({ action: "new" });
				else done({ action: "select", slug: item.value.slice("task:".length) });
			};
			const rebuild = () => {
				const choices = tasks.map((task) => ({
					value: `task:${task.slug}`,
					label: task.title,
					description: `${task.slug} · ${task.context} · ${age(task.modified)}`,
					search: `${task.slug} ${task.title} ${task.request} ${task.stage} ${task.context}`,
				}));
				list = new SelectList(
					[
						{ value: "new:", label: "New task…", description: "" },
						...fuzzyFilter(choices, input.getValue(), (choice) => choice.search),
					],
					10,
					{
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("dim", text),
						scrollInfo: (text) => theme.fg("muted", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				);
				list.onSelect = choose;
				list.onCancel = () => done({ action: "cancel" });
			};
			rebuild();
			return {
				get focused() {
					return input.focused;
				},
				set focused(value: boolean) {
					input.focused = value;
				},
				render(width: number) {
					const help = [
						theme.fg("dim", "type to search"),
						theme.fg("dim", "↑↓ select"),
						keyHint("tui.select.confirm", "open"),
						keyHint("app.session.delete", "delete"),
						keyHint("tui.select.cancel", "cancel"),
					].join(theme.fg("dim", " · "));
					return [
						...border.render(width),
						truncateToWidth(theme.bold("JURUC Tasks"), width, ""),
						...input.render(width),
						"",
						...list.render(width),
						"",
						truncateToWidth(help, width, ""),
						...border.render(width),
					];
				},
				handleInput(data: string) {
					if (keybindings.matches(data, "app.session.delete")) {
						const item = list.getSelectedItem();
						if (item?.value.startsWith("task:"))
							done({ action: "remove", slug: item.value.slice("task:".length) });
						return;
					}
					if (
						keybindings.matches(data, "tui.select.up") ||
						keybindings.matches(data, "tui.select.down") ||
						keybindings.matches(data, "tui.select.pageUp") ||
						keybindings.matches(data, "tui.select.pageDown") ||
						keybindings.matches(data, "tui.select.confirm") ||
						keybindings.matches(data, "tui.select.cancel")
					) list.handleInput(data);
					else {
						input.handleInput(data);
						rebuild();
					}
					tui.requestRender();
				},
				invalidate() {
					input.invalidate();
					list.invalidate();
				},
			};
		});
	}

	/** True when deleting this task would remove the current session's own cwd. */
	function ownsCurrentWorktree(ctx: ExtensionContext, task: StoredTask): boolean {
		const session = currentSessionPath(ctx);
		if (!session || !findTaskSessionByPath(task.document, session)) return false;
		try {
			return realpathSync(ctx.cwd) === realpathSync(task.document.repository.worktree);
		} catch {
			return false;
		}
	}

	/**
	 * The task's own Questions session, which is rooted at the source repository and so
	 * stays usable once the managed worktree is gone.
	 */
	function safeLandingSession(task: StoredTask): string {
		const { sourceRoot } = task.document.repository;
		const path = findTaskSession(task.document, { kind: "questions" })?.path;
		if (!path || !regularFile(path))
			throw new Error("its Questions session is unavailable");
		const stat = lstatSync(sourceRoot, { throwIfNoEntry: false });
		if (!stat?.isDirectory() || stat.isSymbolicLink() || realpathSync(sourceRoot) !== sourceRoot)
			throw new Error(`${sourceRoot}: source repository is not an exact directory`);
		if (realpathSync(SessionManager.open(path).getCwd()) !== sourceRoot)
			throw new Error("its Questions session is not rooted at the source repository");
		return path;
	}

	/**
	 * Deletes the task that owns this session from its safe landing session, so nothing
	 * afterwards runs from the removed working directory. Only plain task data and pure
	 * filesystem/Git helpers cross the switch; every session-bound object is the
	 * replacement's own.
	 */
	async function removeCurrentTask(
		ctx: ExtensionCommandContext,
		task: StoredTask,
		landing: string,
	): Promise<void> {
		const slug = task.document.slug;
		const result = await ctx.switchSession(landing, {
			withSession: async (replacement: ReplacementContext) => {
				try {
					const removed = await removeTaskWorktree(task.document.repository);
					removeTaskRecord(task);
					replacement.ui.setWidget("juruc", undefined);
					replacement.ui.notify(
						removed
							? `${slug}: task and worktree removed; branch retained`
							: `${slug}: task removed; branch retained if present`,
						"info",
					);
					offerNextStage(replacement);
				} catch (error) {
					replacement.ui.notify(
						`${slug}: deletion failed — ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});
		if (result.cancelled) ctx.ui.notify(`${slug}: session switch cancelled`, "warning");
	}

	/** Deletes a task and reports whether the picker may continue afterwards. */
	async function removeTask(ctx: ExtensionCommandContext, slug: string): Promise<boolean> {
		let task: StoredTask;
		try {
			task = loadTask(paths, slug);
		} catch {
			try {
				const confirmed = await ctx.ui.confirm(
					`Delete invalid task ${slug}?`,
					"Remove only its invalid task state? Any managed worktree, branch, and session history will remain.",
				);
				if (!confirmed) return true;
				removeInvalidTaskRecord(paths, slug);
				ctx.ui.notify(`${slug}: invalid task state removed; worktree and branch retained if present`, "info");
			} catch (error) {
				ctx.ui.notify(
					`${slug}: deletion failed — ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return true;
		}
		try {
			// Resolve the landing session before asking, so a refusal never follows a confirmation.
			const landing = ownsCurrentWorktree(ctx, task) ? safeLandingSession(task) : undefined;
			const registered = await hasTaskWorktreeRegistration(task.document.repository);
			const present = registered &&
				lstatSync(task.document.repository.worktree, { throwIfNoEntry: false });
			const status = present ? await inspectTaskWorktree(task.document.repository) : undefined;
			const changes = status?.paths.length
				? `\n\nThis discards uncommitted worktree changes:\n${status.paths.map((path) => `- ${path}`).join("\n")}`
				: "";
			const workspaceText = registered
				? "task state and managed worktree"
				: "task state (no managed worktree exists)";
			const confirmed = await ctx.ui.confirm(
				`Delete ${slug}?`,
				`Remove its ${workspaceText}? Branch ${task.document.repository.branch}, if present, will remain. Session history will remain.${changes}`,
			);
			if (!confirmed) return true;
			if (landing) {
				await removeCurrentTask(ctx, task, landing);
				return false;
			}
			if (registered) await removeTaskWorktree(task.document.repository);
			removeTaskRecord(task);
			ctx.ui.notify(
				registered
					? `${slug}: task and worktree removed; branch retained`
					: `${slug}: task removed; branch retained if present`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`${slug}: deletion failed — ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		return true;
	}

	async function createNewTask(ctx: ExtensionCommandContext): Promise<void> {
		const request = (await ctx.ui.editor("New task — what do you want to do?"))?.trim();
		if (!request) return;
		let title = request.split(/\r?\n/u, 1)[0].trim().slice(0, 80);
		let base = slugify(title);
		if (!base) {
			const name = (await ctx.ui.input("Task name — e.g. simplify-juruc"))?.trim();
			if (!name) return;
			title = name;
			base = slugify(name);
		}
		const slug = uniqueSlug(paths.tasks, base);
		// Ask Git from a directory JURUC owns, never from a candidate repository cwd.
		if (!validTaskSlug(slug) || !(await validBranchName(paths.tasks, slug)))
			throw new Error(`${slug}: invalid Git branch name`);
		const repository = await prepareRepository(
			ctx.cwd,
			(title, detail) => ctx.ui.confirm(title, detail),
			(message) => ctx.ui.notify(message, "info"),
		);
		if (!repository) return;
		const task = createTask(paths, {
			slug,
			title,
			request,
			repository: {
				sourceRoot: repository.root,
				baseBranch: repository.branch,
				sourceHead: repository.head,
				branch: slug,
				worktree: join(paths.worktrees, slug),
			},
		});
		await openQuestions(ctx, task);
	}

	async function handleJuruc(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) throw new Error("/juruc requires TUI or RPC extension-UI support");
		await ctx.waitForIdle();
		if (args.trim()) ctx.ui.notify("/juruc does not accept arguments", "warning");
		// A managed session whose own run is finished resumes its own authoritative task, so
		// one Enter crosses one stage boundary. A completed task still opens the picker: done
		// has no next stage, and its final session must stay able to delete it.
		const owner = taskForSession(ctx);
		if (owner && owner.document.stage !== "done" && !activeSession(ctx, owner)) {
			await openTask(ctx, owner.document.slug);
			return;
		}
		while (true) {
			const choice = await pickTask(ctx, listTasks(paths));
			if (choice.action === "cancel") return;
			if (choice.action === "remove") {
				if (await removeTask(ctx, choice.slug)) continue;
				return;
			}
			if (choice.action === "new") await createNewTask(ctx);
			else await openTask(ctx, choice.slug);
			return;
		}
	}

	pi.registerTool({
		name: "juruc_set_questions",
		label: "Confirm JURUC questions",
		description: "Persist the explicitly confirmed Questions result and start Research.",
		parameters: SET_QUESTIONS_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: SetQuestionsInput, _signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "questions");
			const updated = saveTask(task, setTaskQuestions(task.document, params));
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			return {
				content: [{
					type: "text" as const,
					text: readyText(ctx, "Questions confirmed.", "Research"),
				}],
				details: { slug: updated.document.slug, stage: updated.document.stage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "juruc_set_specification",
		label: "Set JURUC specification",
		description: "Persist the validated implementation-neutral Specification and start Plan.",
		parameters: SET_SPECIFICATION_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: SetSpecificationInput, _signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "specification");
			const updated = saveTask(task, setTaskSpecification(task.document, params));
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			return {
				content: [{
					type: "text" as const,
					text: readyText(ctx, "Specification persisted.", "Plan"),
				}],
				details: { slug: updated.document.slug, stage: updated.document.stage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "juruc_set_plan",
		label: "Decide JURUC plan",
		description:
			"Offer the proposed plan to JURUC's plan decision selector, which owns human acceptance. Accepting persists the immutable plan and starts implementation; revising returns operator feedback; cancelling changes nothing. Never ask the operator to type an acceptance phrase.",
		parameters: SET_PLAN_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: SetPlanInput, _signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "plan");
			if (!ctx.hasUI) throw new Error("plan acceptance requires TUI or RPC extension-UI support");
			// Validate the whole proposal before the operator decides, so Accept can only ever
			// persist a plan JURUC already knows it accepts, and a rejected one leaves no trace.
			const accepted = confirmTaskPlan(task.document, params);
			const decision = await ctx.ui.select(PLAN_DECISION_TITLE, Object.values(PLAN_DECISIONS));
			if (decision === PLAN_DECISIONS.revise) {
				const feedback = await ctx.ui.input(PLAN_REVISION_TITLE);
				// The run continues so the model revises and reopens the selector; an abandoned
				// feedback dialog decided nothing, so it stops exactly like Cancel.
				if (feedback?.trim())
					return {
						content: [{ type: "text" as const, text: planRevisionRequest(feedback) }],
						details: { slug: task.document.slug, stage: task.document.stage },
					};
			}
			if (decision !== PLAN_DECISIONS.accept)
				return {
					content: [{ type: "text" as const, text: PLAN_DECISION_UNRESOLVED }],
					details: { slug: task.document.slug, stage: task.document.stage },
					terminate: true,
				};
			const pending = saveTask(task, accepted);
			showStatus(ctx, pending);
			activateTools(ctx, pending);
			const updated = await activatePendingPlan(ctx, pending);
			return {
				content: [{
					type: "text" as const,
					text: readyText(ctx, "Plan persisted and workspace activated.", "Implementation phase 1"),
				}],
				details: { slug: updated.document.slug, stage: updated.document.stage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "juruc_run_verification",
		label: "Run JURUC verification",
		description: "Run one exact verification command the active implementation phase or accepted Plan declared.",
		parameters: RUN_VERIFICATION_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: RunVerificationInput, signal, _onUpdate, ctx) {
			const correcting = activeSession(ctx, taskForSession(ctx)) === "correction";
			const task = ownedTask(ctx, correcting ? "correction" : "implementation");
			const result = correcting
				? await runCorrectionVerification(
					task.document,
					params.command,
					verificationOperations,
					signal,
				)
				: await runDeclaredVerification(
					task.document,
					params.command,
					verificationOperations,
					signal,
				);
			const status = result.cancelled
				? "Verification cancelled"
				: result.timedOut
					? "Verification timed out"
					: `Verification exited with code ${result.exitCode}`;
			return {
				content: [{
					type: "text" as const,
					text: `${status}.\n${JSON.stringify(result, null, 2)}`,
				}],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "juruc_finish_phase",
		label: "Finish JURUC phase",
		description: "Validate phase evidence, stage the candidate, and create its checkpoint commit.",
		parameters: FINISH_PHASE_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: FinishPhaseInput, signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "implementation");
			const result = await finishCurrentPhase(
				task.document,
				params,
				verificationOperations,
				signal,
			);
			const updated = await persistCheckpointTask(task, result.task, {
				save: saveTask,
				reload: () => loadTask(paths, task.document.slug),
				recover: async () => {
					await recoverUnrecordedTaskCommits(
						task.document.repository,
						expectedTaskHead(task.document),
					);
				},
			});
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			// Reviewers, the server, and the browser belong to opening Review, not to
			// committing the last phase.
			const review = updated.document.stage === "review"
				? currentTaskReviewRound(updated.document)!.number
				: undefined;
			return {
				content: [{
					type: "text" as const,
					text: review
						? readyText(ctx, "Final phase verified and committed.", `Review ${review}`)
						: readyText(
							ctx,
							"Phase verified and committed.",
							`Phase ${updated.document.checkpoints.length + 1}`,
						),
				}],
				details: { commit: result.commit, stage: updated.document.stage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "juruc_finish_correction",
		label: "Finish JURUC correction",
		description: "Validate correction evidence, stage the candidate, and create its correction commit.",
		parameters: FINISH_CORRECTION_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: FinishCorrectionInput, signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "correction");
			const result = await finishCorrection(
				task.document,
				params,
				verificationOperations,
				signal,
			);
			const updated = await persistCheckpointTask(task, result.task, {
				save: saveTask,
				reload: () => loadTask(paths, task.document.slug),
				recover: async () => {
					await recoverUnrecordedTaskCommits(
						task.document.repository,
						expectedTaskHead(task.document),
					);
				},
			});
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			const round = currentTaskReviewRound(updated.document)!;
			return {
				content: [{
					type: "text" as const,
					text: readyText(
						ctx,
						"Correction verified and committed.",
						`Fresh cumulative review ${round.number}`,
					),
				}],
				details: { commit: result.commit, round: round.number },
				terminate: true,
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			const task = taskForSession(ctx);
			activateTools(ctx, task);
			showStatus(ctx, task);
		} catch (error) {
			pi.setActiveTools(taskForSession(ctx)
				? []
				: pi.getActiveTools().filter((name) => !JURUC_TOOLS.has(name)));
			ctx.ui.setWidget("juruc", undefined);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const task = taskForSession(ctx);
		const session = currentSessionPath(ctx);
		if (!task || !session) {
			if (JURUC_TOOLS.has(event.toolName))
				return { block: true, reason: `${event.toolName} requires an active JURUC session` };
			return;
		}
		const kind = activeSession(ctx, task);
		// The stale session cannot know which stage is ready now, only that this one is over.
		if (!kind)
			return {
				block: true,
				reason: "This JURUC session is stale; run /juruc to resume this task",
			};
		if (JURUC_TOOLS.has(event.toolName) && !isSoleCurrentToolCall(ctx, event))
			return { block: true, reason: `${event.toolName} must be the sole tool call in its assistant message` };
		if (kind === "research") {
			if (event.toolName !== "delegate")
				return { block: true, reason: "Research coordinators may only delegate" };
			const input = event.input as Record<string, unknown>;
			if (typeof input.agent !== "string" || !RESEARCH_AGENTS.has(input.agent))
				return { block: true, reason: "Research may delegate only to scout, researcher, or synthesizer" };
			if (input.agent === "synthesizer") {
				if (!isSoleCurrentToolCall(ctx, event))
					return { block: true, reason: "A synthesizer delegate must be the sole tool call in its assistant message" };
				pendingSynthesis.set(event.toolCallId!, { slug: task.document.slug, session });
			}
			return;
		}
		const allowed = sessionTools(kind, task.document);
		if (!allowed.includes(event.toolName as never))
			return { block: true, reason: `${kind} sessions may not call ${event.toolName}` };
		const expectedTools =
			kind === "questions" ? ["juruc_set_questions"]
				: kind === "specification" ? ["juruc_set_specification"]
					: kind === "plan" ? ["juruc_set_plan"]
						: kind === "implementation"
							? ["juruc_run_verification", "juruc_finish_phase"]
							: ["juruc_run_verification", "juruc_finish_correction"];
		if (JURUC_TOOLS.has(event.toolName) && !expectedTools.includes(event.toolName))
			return { block: true, reason: `${event.toolName} is unavailable in a ${kind} session` };
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!event.toolCallId) return;
		const pending = pendingSynthesis.get(event.toolCallId);
		if (!pending) return;
		pendingSynthesis.delete(event.toolCallId);
		const result = (event.result as { details?: unknown } | undefined)?.details ?? event.result;
		const output = event.isError ? undefined : successfulResearchSynthesis(result);
		if (!output) return;
		try {
			const task = loadTask(paths, pending.slug);
			if (
				task.document.stage !== "research" ||
				currentRun(task.document, "research")?.path !== pending.session
			) throw new Error(`${pending.slug}: research task changed before synthesis persistence`);
			saveResearchBrief(task.directory, output);
			const updated = saveTask(task, completeTaskResearch(task.document));
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			ctx.ui.notify(
				`${pending.slug}: ${readyText(ctx, "research saved.", "Specification")}`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_shutdown", async (event) => {
		pendingSynthesis.clear();
		ordinaryTools = undefined;
		// Session replacement keeps the process-owned server; only leaving this process must close it.
		if (event.reason === "quit" || event.reason === "reload")
			await activeReviewServer.close().catch(() => {});
	});

	pi.registerCommand("juruc", {
		description: "Open the JURUC task picker",
		handler: handleJuruc,
	});
}

export default function juruc(pi: ExtensionAPI): void {
	registerJuruc(pi);
}
