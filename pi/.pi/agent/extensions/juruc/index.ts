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
import { taskOptions, type TaskChoice } from "./picker.ts";
import {
	confirmTaskPlan,
	planningPrompt,
	PLANNING_INSTRUCTION,
	PLANNING_TOOL_NAMES,
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
	drivePiReviewer,
	runReviewer,
	type ReviewerDriver,
} from "./reviewers.ts";
import { lifecycleLine } from "./status.ts";
import {
	activateTaskPlan,
	appendTaskSession,
	completeTaskResearch,
	completeTaskReviewer,
	currentTaskPhase,
	currentTaskReviewRound,
	findTaskSession,
	findTaskSessionByPath,
	loadTaskDocument,
	registerTaskReviewerStart,
	saveTaskDocument,
	type DiscoverySessionKind,
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
]);
const RESEARCH_AGENTS = new Set<string>(RESEARCH_AGENT_NAMES);
type CurrentSessionKind = DiscoverySessionKind | "implementation";
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
}

export function registerJuruc(pi: ExtensionAPI, dependencies: JurucDependencies = {}): void {
	const paths = runtimePaths(getAgentDir());
	const verificationOperations = createLocalBashOperations();
	const pendingSynthesis = new Map<string, { slug: string; session: string }>();
	let ordinaryTools: string[] | undefined;

	function taskForSession(ctx: ExtensionContext): StoredTask | undefined {
		const session = currentSessionPath(ctx);
		return session ? findTaskBySession(paths, session) : undefined;
	}

	function currentRun(task: TaskDocument, kind: CurrentSessionKind): TaskSessionRun | undefined {
		if (kind !== "implementation") return findTaskSession(task, { kind });
		return findTaskSession(task, {
			kind,
			phase: task.checkpoints.length + 1,
		});
	}

	function showStatus(ctx: ExtensionContext, task = taskForSession(ctx)): void {
		ctx.ui.setWidget("juruc", task ? [lifecycleLine(task.document)] : undefined);
	}

	function stageTools(task: TaskDocument): readonly string[] | undefined {
		switch (task.stage) {
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
			case "review":
				return [];
			case "done":
				return undefined;
		}
	}

	function activateTools(ctx: ExtensionContext, task = taskForSession(ctx)): void {
		const session = currentSessionPath(ctx);
		if (!ordinaryTools)
			ordinaryTools = pi.getActiveTools().filter((name) => !JURUC_TOOLS.has(name));
		if (!task || !session) {
			pi.setActiveTools(ordinaryTools);
			return;
		}
		const stage = task.document.stage;
		if (
			stage === "review" ||
			stage === "done" ||
			currentRun(task.document, stage)?.path !== session ||
			!sameWorkingDirectory(ctx, task)
		) {
			pi.setActiveTools([]);
			return;
		}
		const requested = stageTools(task.document)!;
		const registered = new Set(pi.getAllTools().map(({ name }) => name));
		const missing = requested.filter((name) => !registered.has(name));
		if (missing.length)
			throw new Error(`required ${stage} tools are unavailable: ${missing.join(", ")}`);
		pi.setActiveTools([...requested]);
	}

	function ownedTask(
		ctx: ExtensionContext,
		kind: CurrentSessionKind,
		stage: TaskDocument["stage"],
	): StoredTask {
		const task = taskForSession(ctx);
		const session = currentSessionPath(ctx);
		if (
			!task ||
			!session ||
			task.document.stage !== stage ||
			currentRun(task.document, kind)?.path !== session ||
			!sameWorkingDirectory(ctx, task)
		) throw new Error(
			`JURUC action requires the active ${stage} ${kind} session; run /juruc to resume it`,
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
		after?: (ctx: ReplacementContext) => Promise<void>,
	): Promise<void> {
		if (!regularFile(path)) throw new Error(`${path}: managed session is unavailable`);
		const first = !sessionHasUserMessage(path);
		const result = await ctx.switchSession(path, {
			withSession: async (replacement: ReplacementContext) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage !== stage || !findTaskSessionByPath(current.document, path))
					throw new Error(`${task.document.slug}: task changed during session switch`);
				await replacement.sendUserMessage(first ? prompt : resumePrompt);
				await after?.(replacement);
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
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage === "research") await openResearch(replacement, current);
			},
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
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage === "specification")
					await openSpecification(replacement, current);
			},
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
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage === "plan") await openPlan(replacement, current);
			},
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
			"Resume the immutable implementation plan and call juruc_set_plan only after explicit acceptance.",
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage === "implementation")
					await openImplementation(replacement, current);
			},
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
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (
					current.document.stage === "implementation" &&
					!currentRun(current.document, "implementation")
				) await openImplementation(replacement, current);
			},
		);
	}

	async function openReview(ctx: ExtensionCommandContext, selected: StoredTask): Promise<void> {
		let task = selected;
		if (task.document.stage !== "review")
			throw new Error(`${task.document.slug}: task is not in review`);
		const round = currentTaskReviewRound(task.document)!;
		if (Object.values(round.reviewers).some((slot) => !slot?.outcome)) {
			const parentSession = findTaskSession(task.document, {
				kind: "implementation",
				phase: task.document.plan!.phases.length,
			})?.path;
			await prepareReview({
				taskPath: join(task.directory, "task.json"),
				...(parentSession ? { parentSession } : {}),
				...dependencies,
			});
			task = loadTask(paths, task.document.slug);
		}
		showStatus(ctx, task);
		activateTools(ctx, task);
		ctx.ui.notify(`${task.document.slug}: review prepared`, "info");
	}

	async function viewDone(ctx: ExtensionCommandContext, task: StoredTask): Promise<void> {
		ctx.ui.notify(
			`${task.document.slug}: done · ${task.document.checkpoints.length} phases · ${task.document.repository.branch}`,
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
					description: `${task.slug} · ${task.stage} · ${age(task.modified)}`,
					search: `${task.slug} ${task.title} ${task.request} ${task.stage}`,
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

	async function removeTask(ctx: ExtensionCommandContext, slug: string): Promise<void> {
		let task: StoredTask;
		try {
			task = loadTask(paths, slug);
		} catch {
			try {
				const confirmed = await ctx.ui.confirm(
					`Delete invalid task ${slug}?`,
					"Remove only its invalid task state? Any managed worktree, branch, and session history will remain.",
				);
				if (!confirmed) return;
				removeInvalidTaskRecord(paths, slug);
				ctx.ui.notify(`${slug}: invalid task state removed; worktree and branch retained if present`, "info");
			} catch (error) {
				ctx.ui.notify(
					`${slug}: deletion failed — ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return;
		}
		try {
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
			if (!confirmed) return;
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
		if (!validTaskSlug(slug) || !(await validBranchName(ctx.cwd, slug)))
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
		while (true) {
			const choice = await pickTask(ctx, listTasks(paths));
			if (choice.action === "cancel") return;
			if (choice.action === "remove") {
				await removeTask(ctx, choice.slug);
				continue;
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
			const task = ownedTask(ctx, "questions", "questions");
			const updated = saveTask(task, setTaskQuestions(task.document, params));
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			return {
				content: [{ type: "text" as const, text: "Questions confirmed. Starting Research." }],
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
			const task = ownedTask(ctx, "specification", "specification");
			const updated = saveTask(task, setTaskSpecification(task.document, params));
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			return {
				content: [{ type: "text" as const, text: "Specification persisted. Starting Plan." }],
				details: { slug: updated.document.slug, stage: updated.document.stage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "juruc_set_plan",
		label: "Set JURUC plan",
		description: "Persist the explicitly accepted immutable plan and start implementation.",
		parameters: SET_PLAN_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: SetPlanInput, _signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "plan", "plan");
			const pending = saveTask(task, confirmTaskPlan(task.document, params));
			showStatus(ctx, pending);
			activateTools(ctx, pending);
			const updated = await activatePendingPlan(ctx, pending);
			return {
				content: [{ type: "text" as const, text: "Plan persisted and workspace activated. Starting implementation." }],
				details: { slug: updated.document.slug, stage: updated.document.stage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "juruc_run_verification",
		label: "Run JURUC verification",
		description: "Run one exact verification command declared by the active implementation phase.",
		parameters: RUN_VERIFICATION_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: RunVerificationInput, signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "implementation", "implementation");
			const result = await runDeclaredVerification(
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
			const task = ownedTask(ctx, "implementation", "implementation");
			const result = await finishCurrentPhase(
				task.document,
				params,
				verificationOperations,
				signal,
			);
			let updated = await persistCheckpointTask(task, result.task, {
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
			if (updated.document.stage === "review") {
				await prepareReview({
					taskPath: join(updated.directory, "task.json"),
					parentSession: currentSessionPath(ctx),
					...dependencies,
				});
				updated = loadTask(paths, updated.document.slug);
				showStatus(ctx, updated);
			}
			return {
				content: [{
					type: "text" as const,
					text: updated.document.stage === "review"
						? "Final phase verified and committed. Review prepared."
						: "Phase verified and committed. Starting the next phase.",
				}],
				details: { commit: result.commit, stage: updated.document.stage },
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
		const stage = task.document.stage;
		const active = stage !== "review" && stage !== "done" &&
			currentRun(task.document, stage)?.path === session &&
			sameWorkingDirectory(ctx, task);
		if (!active)
			return {
				block: true,
				reason: `This JURUC session is stale; run /juruc to resume the active ${stage} session`,
			};
		if (JURUC_TOOLS.has(event.toolName) && !isSoleCurrentToolCall(ctx, event))
			return { block: true, reason: `${event.toolName} must be the sole tool call in its assistant message` };
		if (stage === "research") {
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
		const allowed = stageTools(task.document) ?? [];
		if (!allowed.includes(event.toolName as never))
			return { block: true, reason: `${stage} sessions may not call ${event.toolName}` };
		const expectedTools =
			stage === "questions" ? ["juruc_set_questions"]
				: stage === "specification" ? ["juruc_set_specification"]
					: stage === "plan" ? ["juruc_set_plan"]
						: stage === "implementation"
							? ["juruc_run_verification", "juruc_finish_phase"]
							: [];
		if (JURUC_TOOLS.has(event.toolName) && !expectedTools.includes(event.toolName))
			return { block: true, reason: `${event.toolName} is unavailable while the task is ${stage}` };
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
			ctx.ui.notify(`${pending.slug}: research saved`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_shutdown", () => {
		pendingSynthesis.clear();
		ordinaryTools = undefined;
	});

	pi.registerCommand("juruc", {
		description: "Open the JURUC task picker",
		handler: handleJuruc,
	});
}

export default function juruc(pi: ExtensionAPI): void {
	registerJuruc(pi);
}
