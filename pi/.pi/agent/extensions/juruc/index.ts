import {
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
import {
	lstatSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { runIndependentAudit } from "./audit.ts";
import {
	BLOCK_PHASE_SCHEMA,
	BUILD_INSTRUCTION,
	BUILD_TOOL_NAMES,
	blockCurrentPhase,
	FINISH_PHASE_SCHEMA,
	finishCurrentPhase,
	type FinishPhaseInput,
} from "./execution.ts";
import { taskOptions, type TaskChoice } from "./picker.ts";
import {
	confirmTaskPlan,
	planningPrompt,
	planningSessionInstruction,
	PLANNING_TOOL_NAMES,
	SET_PLAN_SCHEMA,
	type SetPlanInput,
} from "./planning.ts";
import { planningContextMetadata } from "./prompts.ts";
import {
	RESEARCH_AGENT_NAMES,
	RESEARCH_INSTRUCTION,
	RESEARCH_TOOL_NAMES,
	researchKickoff,
	saveResearchBrief,
	successfulResearchSynthesis,
} from "./research.ts";
import { runtimePaths } from "./runtime.ts";
import { lifecycleLine } from "./status.ts";
import {
	extendTask,
	finishTaskResearch,
	recordTaskSession,
	resumeTaskPhase,
	returnTaskToPlanning,
	returnTaskToResearch,
	type SessionKind,
	type TaskDocument,
} from "./task.ts";
import {
	createTask,
	listTasks,
	loadTask,
	removeTaskRecord,
	saveTask,
	scanTasks,
	slugify,
	type StoredTask,
	type TaskSummary,
	uniqueSlug,
	validTaskSlug,
} from "./tasks.ts";
import {
	createTaskWorktree,
	inspectTaskWorktree,
	prepareRepository,
	removeTaskWorktree,
	validBranchName,
} from "./workspace.ts";

const JURUC_TOOLS = new Set([
	"juruc_set_plan",
	"juruc_finish_phase",
	"juruc_block_phase",
]);
const RESEARCH_AGENTS = new Set<string>(RESEARCH_AGENT_NAMES);

type Activity = "auditing" | "synthesizing";
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

function sameWorkingDirectory(ctx: ExtensionContext, task: TaskDocument): boolean {
	try {
		return realpathSync(ctx.cwd) === realpathSync(task.repository.worktree);
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

function phasePrompt(task: StoredTask): string {
	const plan = task.document.plan;
	const phase = plan?.remaining[0];
	if (!plan || !phase) throw new Error("task has no active phase");
	const position = plan.completed.length + 1;
	const total = position + plan.remaining.length - 1;
	const section = (title: string, values: readonly string[]): string[] =>
		values.length ? [title, ...values.map((value) => `- ${value}`)] : [];
	return [
		`Build phase ${position}/${total}: ${phase.title}`,
		"",
		`Task objective: ${plan.objective}`,
		...section("Constraints:", plan.constraints),
		...section("Assumptions:", plan.assumptions),
		...section("Non-goals:", plan.nonGoals),
		"Overall success criteria:",
		...plan.successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
		"",
		`Phase objective: ${phase.objective}`,
		"Phase success criteria:",
		...phase.successCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
		...section("Hints:", phase.hints),
		...(plan.remaining.length === 1
			? ["", "This is the final phase; its one audit also judges every overall criterion."]
			: []),
		"",
		`Research evidence: ${join(task.directory, "research.md")} (non-authoritative)`,
		`Task state: ${join(task.directory, "task.json")} (authoritative)`,
		"Inspect current code, implement only this phase, verify it, then call juruc_finish_phase. Do not call an audit delegate yourself and do not commit.",
	].join("\n");
}

function planningSubject(task: TaskDocument): string {
	return task.blockReason
		? `Replan the remaining work after this blocked phase.\n\nBlock reason: ${task.blockReason}\n\nOriginal request: ${task.request}`
		: task.request;
}

function researchSubject(task: TaskDocument): string {
	return task.blockReason
		? `Research facts needed to resolve this blocked task.\n\nBlock reason: ${task.blockReason}\n\nOriginal request: ${task.request}`
		: task.request;
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
			typeof content === "object" &&
			content !== null &&
			content.type === "toolCall",
	);
	return calls.length === 1 &&
		calls[0].id === event.toolCallId &&
		calls[0].name === event.toolName;
}

export interface JurucDependencies {
	runAudit: typeof runIndependentAudit;
}

export function registerJuruc(
	pi: ExtensionAPI,
	dependencies: JurucDependencies = { runAudit: runIndependentAudit },
): void {
	const paths = runtimePaths(getAgentDir());
	const activity = new Map<string, Activity>();
	const pendingSynthesis = new Map<
		string,
		{ slug: string; session: string }
	>();
	let ordinaryTools: string[] | undefined;

	function taskForSession(ctx: ExtensionContext): StoredTask | undefined {
		const session = currentSessionPath(ctx);
		if (!session) return undefined;
		const matches = scanTasks(paths).flatMap(({ task }) => {
			if (!task) return [];
			return Object.values(task.document.sessions).includes(session) ? [task] : [];
		});
		if (matches.length > 1)
			throw new Error("current session belongs to multiple JURUC tasks");
		return matches[0];
	}

	function showStatus(ctx: ExtensionContext, task = taskForSession(ctx)): void {
		ctx.ui.setWidget(
			"juruc",
			task ? [lifecycleLine(task.document, activity.get(task.document.slug))] : undefined,
		);
	}

	function activateTools(ctx: ExtensionContext, task = taskForSession(ctx)): void {
		const session = currentSessionPath(ctx);
		let requested: readonly string[] | undefined;
		if (task && session && sameWorkingDirectory(ctx, task.document)) {
			const { document } = task;
			if (document.stage === "research" && document.sessions.research === session)
				requested = RESEARCH_TOOL_NAMES;
			else if (document.stage === "planning" && document.sessions.planning === session)
				requested = PLANNING_TOOL_NAMES;
			else if (document.stage === "building" && document.sessions.build === session)
				requested = BUILD_TOOL_NAMES;
		}
		if (!ordinaryTools)
			ordinaryTools = pi.getActiveTools().filter((name) => !JURUC_TOOLS.has(name));
		if (!requested) {
			pi.setActiveTools(ordinaryTools);
			return;
		}
		const registered = new Set(pi.getAllTools().map(({ name }) => name));
		for (const required of requested.filter((name) => JURUC_TOOLS.has(name) || name === "delegate" || name === "read"))
			if (!registered.has(required))
				throw new Error(`required JURUC tool is unavailable: ${required}`);
		pi.setActiveTools(requested.filter((name) => registered.has(name)));
	}

	function ownedTask(
		ctx: ExtensionContext,
		kind: SessionKind,
		stage: TaskDocument["stage"],
	): StoredTask {
		const task = taskForSession(ctx);
		const session = currentSessionPath(ctx);
		if (
			!task ||
			!session ||
			task.document.stage !== stage ||
			task.document.sessions[kind] !== session ||
			!sameWorkingDirectory(ctx, task.document)
		)
			throw new Error(
				`JURUC action requires the active ${stage} ${kind} session; run /juruc to resume it`,
			);
		return task;
	}

	function saveSession(
		task: StoredTask,
		kind: SessionKind,
		path: string,
	): StoredTask {
		return saveTask(task, recordTaskSession(task.document, kind, path));
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
				if (current.document.stage !== stage || !Object.values(current.document.sessions).includes(path))
					throw new Error(`${task.document.slug}: task changed during session switch`);
				await replacement.sendUserMessage(first ? prompt : resumePrompt);
				await after?.(replacement);
			},
		});
		if (result.cancelled)
			ctx.ui.notify(`${task.document.slug}: session switch cancelled`, "warning");
	}

	async function openResearch(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "research")
			throw new Error(`${task.document.slug}: task is not researching`);
		let session = task.document.sessions.research;
		if (!session) {
			session = createManagedSession(
				task.document.repository.worktree,
				`${task.document.slug} · research`,
				"juruc-research-instruction",
				RESEARCH_INSTRUCTION,
				ctx.sessionManager.getSessionFile(),
			);
			task = saveSession(task, "research", session);
		}
		const commands = pi.getCommands();
		await switchAndSend(
			ctx,
			task,
			session,
			"research",
			researchKickoff(researchSubject(task.document)),
			"Resume proportional research. Gather only facts needed for planning, then produce the factual synthesis.",
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage === "planning")
					await openPlanning(replacement, current, commands);
			},
		);
	}

	async function openPlanning(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
		commands = pi.getCommands(),
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "planning")
			throw new Error(`${task.document.slug}: task is not planning`);
		let session = task.document.sessions.planning;
		if (!session) {
			session = createManagedSession(
				task.document.repository.worktree,
				`${task.document.slug} · plan`,
				"juruc-planning-instruction",
				planningSessionInstruction(task.directory),
				task.document.sessions.research ?? ctx.sessionManager.getSessionFile(),
			);
			task = saveSession(task, "planning", session);
		}
		const prompt = planningPrompt(commands, planningSubject(task.document));
		await switchAndSend(
			ctx,
			task,
			session,
			"planning",
			prompt,
			"Resume planning from the current task.json and research.md. Continue the canonical /grill process and call juruc_set_plan only after confirmation.",
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage === "building")
					await openBuild(replacement, current);
			},
		);
	}

	async function openBuild(
		ctx: ExtensionCommandContext,
		selected: StoredTask,
	): Promise<void> {
		let task = selected;
		if (task.document.stage !== "building")
			throw new Error(`${task.document.slug}: task is not building`);
		let session = task.document.sessions.build;
		if (!session) {
			const plan = task.document.plan;
			if (!plan?.remaining.length) throw new Error("task has no remaining phase");
			const position = plan.completed.length + 1;
			session = createManagedSession(
				task.document.repository.worktree,
				`${task.document.slug} · phase ${position}`,
				"juruc-build-instruction",
				BUILD_INSTRUCTION,
				task.document.sessions.planning ?? ctx.sessionManager.getSessionFile(),
			);
			task = saveSession(task, "build", session);
		}
		await switchAndSend(
			ctx,
			task,
			session,
			"building",
			phasePrompt(task),
			"Resume the active phase from task.json and the current dirty worktree. Verify it, then call juruc_finish_phase or juruc_block_phase.",
			async (replacement) => {
				const current = loadTask(paths, task.document.slug);
				if (current.document.stage === "building" && !current.document.sessions.build)
					await openBuild(replacement, current);
			},
		);
	}

	async function viewDone(
		ctx: ExtensionCommandContext,
		task: StoredTask,
	): Promise<void> {
		const session = task.document.sessions.planning;
		if (!session || !regularFile(session)) {
			ctx.ui.notify(`${task.document.slug}: done`, "info");
			return;
		}
		const result = await ctx.switchSession(session, {
			withSession: async (replacement: ReplacementContext) => {
				replacement.ui.notify(
					`${task.document.slug}: done · ${task.document.plan?.completed.length ?? 0} phases`,
					"info",
				);
			},
		});
		if (result.cancelled) ctx.ui.notify(`${task.document.slug}: session switch cancelled`, "warning");
	}

	async function openBlocked(
		ctx: ExtensionCommandContext,
		task: StoredTask,
	): Promise<void> {
		const choice = await ctx.ui.select("Blocked phase", [
			"Resume active phase",
			"Continue planning",
			"Research the blocker",
		]);
		if (!choice) return;
		if (choice === "Resume active phase") {
			const resumed = saveTask(task, resumeTaskPhase(task.document));
			await openBuild(ctx, resumed);
			return;
		}
		if (choice === "Continue planning") {
			const planning = saveTask(task, returnTaskToPlanning(task.document));
			await openPlanning(ctx, planning);
			return;
		}
		const research = saveTask(task, returnTaskToResearch(task.document));
		await openResearch(ctx, research);
	}

	async function openTask(
		ctx: ExtensionCommandContext,
		slug: string,
	): Promise<void> {
		const task = loadTask(paths, slug);
		switch (task.document.stage) {
			case "research":
				await openResearch(ctx, task);
				return;
			case "planning":
				await openPlanning(ctx, task);
				return;
			case "building":
				await openBuild(ctx, task);
				return;
			case "blocked":
				await openBlocked(ctx, task);
				return;
			case "done": {
				const choice = await ctx.ui.select("Completed task", ["View completion", "Extend task"]);
				if (choice === "View completion") await viewDone(ctx, task);
				else if (choice === "Extend task") {
					const planning = saveTask(task, extendTask(task.document));
					await openPlanning(ctx, planning);
				}
			}
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

	async function removeTask(
		ctx: ExtensionCommandContext,
		slug: string,
	): Promise<void> {
		try {
			const task = loadTask(paths, slug);
			const present = lstatSync(task.document.repository.worktree, { throwIfNoEntry: false });
			const status = present ? await inspectTaskWorktree(task.document.repository) : undefined;
			const changes = status?.paths.length
				? `\n\nThis discards uncommitted worktree changes:\n${status.paths.map((path) => `- ${path}`).join("\n")}`
				: "";
			const confirmed = await ctx.ui.confirm(
				`Delete ${slug}?`,
				`Remove its JURUC task state and managed worktree? Branch ${task.document.repository.branch} and its commits will remain. Session history will remain.${changes}`,
			);
			if (!confirmed) return;
			await removeTaskWorktree(task.document.repository);
			removeTaskRecord(task);
			ctx.ui.notify(`${slug}: task and worktree removed; branch retained`, "info");
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
		const identity = await createTaskWorktree(
			repository,
			slug,
			join(paths.worktrees, slug),
		);
		const task = createTask(paths, {
			slug,
			title,
			request,
			repository: identity,
		});
		await openResearch(ctx, task);
	}

	async function handleJuruc(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!ctx.hasUI)
			throw new Error("/juruc requires TUI or RPC extension-UI support");
		await ctx.waitForIdle();
		if (args.trim())
			ctx.ui.notify("/juruc does not accept arguments", "warning");
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
		name: "juruc_set_plan",
		label: "Set JURUC plan",
		description: "Persist the human-confirmed remaining plan and start its first phase.",
		parameters: SET_PLAN_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: SetPlanInput, _signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "planning", "planning");
			const updated = saveTask(task, confirmTaskPlan(task.document, params));
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			return {
				content: [{ type: "text" as const, text: "Plan persisted. Starting the active phase." }],
				details: { slug: updated.document.slug, stage: updated.document.stage },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "juruc_finish_phase",
		label: "Finish JURUC phase",
		description: "Stage the complete candidate, run one independent audit, and commit only on pass.",
		parameters: FINISH_PHASE_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: FinishPhaseInput, signal, onUpdate, ctx) {
			const task = ownedTask(ctx, "build", "building");
			activity.set(task.document.slug, "auditing");
			showStatus(ctx, task);
			try {
				const result = await finishCurrentPhase(
					task.document,
					params,
					(request) =>
						dependencies.runAudit(request, ctx, signal, (progress) => {
							onUpdate?.({
								content: [{ type: "text", text: progress.activity ?? "auditing" }],
								details: { activity: progress.activity ?? "auditing" },
							});
						}),
				);
				if (result.kind === "audit-failed") {
					return {
						content: [{ type: "text" as const, text: `Audit failed. Fix every finding, then call juruc_finish_phase again.\n\n${result.feedback}` }],
						details: { verdict: "fail", findings: result.audit.findings.length },
					};
				}
				const updated = saveTask(task, result.task);
				showStatus(ctx, updated);
				activateTools(ctx, updated);
				return {
					content: [{
						type: "text" as const,
						text: result.task.stage === "done"
							? "Final phase audited and completed. Task done."
							: "Phase audited and completed. Starting the next phase.",
					}],
					details: { verdict: "pass", commit: result.commit, stage: result.task.stage },
					terminate: true,
				};
			} finally {
				activity.delete(task.document.slug);
				showStatus(ctx);
			}
		},
	});

	pi.registerTool({
		name: "juruc_block_phase",
		label: "Block JURUC phase",
		description: "Persist the blocker without discarding dirty work.",
		parameters: BLOCK_PHASE_SCHEMA as never,
		executionMode: "sequential",
		async execute(_id, params: { reason: string }, _signal, _onUpdate, ctx) {
			const task = ownedTask(ctx, "build", "building");
			const updated = saveTask(
				task,
				await blockCurrentPhase(task.document, params.reason),
			);
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			return {
				content: [{ type: "text" as const, text: "Phase blocked. Run /juruc to resume, plan, or research." }],
				details: { blocked: true },
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
			pi.setActiveTools(pi.getActiveTools().filter((name) => !JURUC_TOOLS.has(name)));
			ctx.ui.setWidget("juruc", undefined);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const task = taskForSession(ctx);
		const session = currentSessionPath(ctx);
		if (
			!task ||
			!session ||
			task.document.stage !== "planning" ||
			task.document.sessions.planning !== session
		)
			return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${planningContextMetadata(event.systemPromptOptions)}`,
		};
	});

	pi.on("tool_call", (event, ctx) => {
		const task = taskForSession(ctx);
		const session = currentSessionPath(ctx);
		if (!task || !session) {
			if (JURUC_TOOLS.has(event.toolName))
				return { block: true, reason: `${event.toolName} requires an active JURUC session` };
			return;
		}
		const research = task.document.stage === "research" && task.document.sessions.research === session;
		const planning = task.document.stage === "planning" && task.document.sessions.planning === session;
		const building = task.document.stage === "building" && task.document.sessions.build === session;
		if (JURUC_TOOLS.has(event.toolName) && !isSoleCurrentToolCall(ctx, event))
			return { block: true, reason: `${event.toolName} must be the sole tool call in its assistant message` };
		if (research) {
			if (event.toolName !== "delegate")
				return { block: true, reason: "Research coordinators may only delegate" };
			const input = event.input as Record<string, unknown>;
			if (typeof input.agent !== "string" || !RESEARCH_AGENTS.has(input.agent))
				return { block: true, reason: "Research may delegate only to scout, researcher, or synthesizer" };
			if (input.agent === "synthesizer" && event.toolCallId) {
				pendingSynthesis.set(event.toolCallId, { slug: task.document.slug, session });
				activity.set(task.document.slug, "synthesizing");
				showStatus(ctx, task);
			}
			return;
		}
		if (planning && !PLANNING_TOOL_NAMES.includes(event.toolName as never))
			return { block: true, reason: "Planning sessions are read-only" };
		if (
			building &&
			event.toolName === "delegate" &&
			(event.input as Record<string, unknown>).agent === "audit"
		)
			return { block: true, reason: "Call juruc_finish_phase; JURUC owns the independent audit" };
		if (JURUC_TOOLS.has(event.toolName)) {
			const allowed =
				(event.toolName === "juruc_set_plan" && planning) ||
				((event.toolName === "juruc_finish_phase" || event.toolName === "juruc_block_phase") && building);
			if (!allowed)
				return { block: true, reason: `${event.toolName} is unavailable while the task is ${task.document.stage}` };
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!event.toolCallId) return;
		const pending = pendingSynthesis.get(event.toolCallId);
		if (!pending) return;
		pendingSynthesis.delete(event.toolCallId);
		activity.delete(pending.slug);
		const result = (event.result as { details?: unknown } | undefined)?.details ?? event.result;
		const output = event.isError ? undefined : successfulResearchSynthesis(result);
		if (!output) {
			showStatus(ctx);
			return;
		}
		try {
			const task = loadTask(paths, pending.slug);
			if (
				task.document.stage !== "research" ||
				task.document.sessions.research !== pending.session
			)
				throw new Error(`${pending.slug}: research task changed before synthesis persistence`);
			saveResearchBrief(task.directory, output);
			const updated = saveTask(task, finishTaskResearch(task.document));
			showStatus(ctx, updated);
			activateTools(ctx, updated);
			ctx.ui.notify(`${pending.slug}: research saved`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_shutdown", () => {
		pendingSynthesis.clear();
		activity.clear();
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
