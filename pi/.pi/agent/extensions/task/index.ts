import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
	addWorktree,
	branchExists,
	discardWorktree,
	repositoryRoot,
	requireHead,
} from "./git.ts";
import { pickTask } from "./picker.ts";
import { implementationBrief, taskGenerationPrompt } from "./prompts.ts";
import {
	commitTaskCreation,
	discardTaskCreation,
	isSlug,
	listTasks,
	MAX_SLUG_LENGTH,
	MAX_TITLE_LENGTH,
	nextOpenPhase,
	prepareTaskCreation,
	readPlan,
	readPlanFile,
	readTask,
	taskDir,
	taskState,
	worktreePath,
	type Phase,
	type Task,
} from "./tasks.ts";
import {
	ADVANCE_TASK_COMMAND,
	FINISH_PHASE_TOOL,
	registerTaskTools,
	taskTools,
} from "./task-tools.ts";
import { taskStatus } from "./widget.ts";

const WIDGET = "task";
const TASK_MARKER = "task-context";
const MARKER_VERSION = 1;
const TASK_MODEL = { provider: "openai-codex", id: "gpt-5.6-luna" };
const TASK_THINKING = "low" as const;

const TASK_MARKER_SCHEMA = Type.Object({
	version: Type.Literal(MARKER_VERSION),
	slug: Type.String(),
	phase: Type.String(),
}, { additionalProperties: false });

const PHASE_INPUT_SCHEMA = Type.Object({
	name: Type.String({
		minLength: 1,
		maxLength: MAX_SLUG_LENGTH,
		description: "Short lower-case kebab-case phase name without a numeric prefix.",
	}),
	title: Type.String({
		minLength: 1,
		maxLength: MAX_TITLE_LENGTH,
		description: "Short single-line phase title.",
	}),
	body: Type.String({
		minLength: 1,
		description: "Self-contained implementation scope and verification criteria.",
	}),
}, { additionalProperties: false });

const DEFINE_TASK_TOOL = {
	name: "define_task",
	description: "Define the task slug and its ordered implementation phases.",
	parameters: Type.Object({
		slug: Type.String({
			minLength: 1,
			maxLength: MAX_SLUG_LENGTH,
			description: "Two or three lower-case words joined by dashes.",
		}),
		phases: Type.Array(PHASE_INPUT_SCHEMA, { minItems: 1 }),
	}, { additionalProperties: false }),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
} as const;

const FINISH_PHASE_DETAILS_SCHEMA = Type.Object({
	phase: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

type TaskMarker = Static<typeof TASK_MARKER_SCHEMA>;
type GeneratedTask = Static<typeof DEFINE_TASK_TOOL.parameters>;

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function entry(path: string) {
	return lstatSync(path, { throwIfNoEntry: false });
}

function readTaskMarker(entries: readonly SessionEntry[]): TaskMarker | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const item = entries[index];
		if (item.type !== "custom" || item.customType !== TASK_MARKER) continue;
		if (!Check(TASK_MARKER_SCHEMA, item.data)) {
			throw new Error(`invalid ${TASK_MARKER} session marker`);
		}
		if (!isSlug(item.data.slug)) {
			throw new Error(`invalid task slug in ${TASK_MARKER} session marker`);
		}
		return item.data;
	}
	return undefined;
}

function sessionMarker(ctx: ExtensionContext): TaskMarker | undefined {
	return readTaskMarker(ctx.sessionManager.getBranch());
}

function parsePlanArgument(argument: string): string {
	const value = argument.trim();
	if (!value) throw new Error("/task requires a plan file");
	if (!value.startsWith('"')) return value;
	if (value.length < 2 || !value.endsWith('"')) {
		throw new Error("quoted plan path is missing its closing quote");
	}
	const path = value.slice(1, -1);
	if (!path || path.includes('"')) throw new Error("quoted plan path is invalid");
	return path;
}

export default function taskExtension(pi: ExtensionAPI): void {
	const tasksRoot = (): string => join(getAgentDir(), "tasks");

	const showTask = (ctx: ExtensionContext, task: Task): void => {
		const status = taskStatus(task);
		ctx.ui.setWidget(WIDGET, (_tui, theme) => ({
			render: (width) => [truncateToWidth(
				status.tone === "complete"
					? theme.fg("success", `✓ ${status.text}`)
					: theme.fg("warning", `▶ ${status.text}`),
				width,
			)],
			invalidate() {},
		}));
	};

	const implementationFor = (
		ctx: ExtensionContext,
	): { marker: TaskMarker; task: Task; phase: Phase } | undefined => {
		const marker = sessionMarker(ctx);
		if (!marker) return undefined;
		const task = readTask(tasksRoot(), marker.slug);
		const state = taskState(task);
		if (state.kind !== "implementation" || state.phase.name !== marker.phase) return undefined;
		return { marker, task, phase: state.phase };
	};

	const syncTaskTools = (ctx: ExtensionContext): void => {
		const active = pi.getActiveTools();
		const next = taskTools(active, implementationFor(ctx) !== undefined);
		if (active.length === next.length && active.every((name, index) => name === next[index])) return;
		pi.setActiveTools(next);
	};

	registerTaskTools(pi, {
		resolveImplementation: (ctx) => {
			const implementation = implementationFor(ctx);
			if (!implementation) {
				const marker = sessionMarker(ctx);
				if (!marker) throw new Error("no task phase is active in this session");
				const task = readTask(tasksRoot(), marker.slug);
				const state = taskState(task);
				if (state.kind === "complete") throw new Error(`${task.slug} is complete`);
				throw new Error(`this session implements ${marker.phase}; the open phase is ${state.phase.name}`);
			}
			return { task: implementation.task, phase: implementation.phase };
		},
	});

	pi.on("session_start", (_event, ctx) => {
		syncTaskTools(ctx);
		const marker = sessionMarker(ctx);
		if (marker) showTask(ctx, readTask(tasksRoot(), marker.slug));
		else ctx.ui.setWidget(WIDGET, undefined);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		syncTaskTools(ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== FINISH_PHASE_TOOL || event.isError) return;
		if (!Check(FINISH_PHASE_DETAILS_SCHEMA, event.details)) {
			throw new Error(`invalid ${FINISH_PHASE_TOOL} result details`);
		}
		const marker = sessionMarker(ctx);
		if (!marker || marker.phase !== event.details.phase) {
			throw new Error(`${FINISH_PHASE_TOOL} result does not match its task session`);
		}
		showTask(ctx, readTask(tasksRoot(), marker.slug));
		syncTaskTools(ctx);
	});

	const generateTask = async (
		ctx: ExtensionContext,
		plan: string,
		excludedSlug?: string,
	): Promise<GeneratedTask> => {
		const found = ctx.modelRegistry.find(TASK_MODEL.provider, TASK_MODEL.id);
		if (!found) {
			throw new Error(`${TASK_MODEL.provider}/${TASK_MODEL.id} is unavailable; /task requires it`);
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
		if (!auth.ok) throw new Error(`${found.id}: ${auth.error}`);
		const { ok: _resolved, baseUrl, ...request } = auth;
		const model = baseUrl ? { ...found, baseUrl } : found;
		const response = await completeSimple(model, {
			systemPrompt: taskGenerationPrompt(excludedSlug),
			messages: [{
				role: "user",
				content: [{ type: "text", text: plan }],
				timestamp: Date.now(),
			}],
			tools: [DEFINE_TASK_TOOL],
		}, { ...request, reasoning: TASK_THINKING });
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(`${model.id}: ${response.errorMessage ?? response.stopReason}`);
		}
		const call = response.content.find(
			(content) => content.type === "toolCall" && content.name === DEFINE_TASK_TOOL.name,
		);
		if (call?.type !== "toolCall") {
			throw new Error(`${model.id} answered without calling ${DEFINE_TASK_TOOL.name}`);
		}
		if (!Check(DEFINE_TASK_TOOL.parameters, call.arguments) || !isSlug(call.arguments.slug)) {
			throw new Error(`${model.id} returned an invalid task definition`);
		}
		return call.arguments;
	};

	const collision = (repository: string, slug: string): string | undefined => {
		if (entry(taskDir(tasksRoot(), slug)) !== undefined) return "task";
		if (entry(worktreePath({ repository, slug })) !== undefined) return "worktree";
		if (branchExists(repository, slug)) return "branch";
		return undefined;
	};

	const generateAvailableTask = async (
		ctx: ExtensionContext,
		repository: string,
		plan: string,
	): Promise<GeneratedTask> => {
		const first = await generateTask(ctx, plan);
		const firstCollision = collision(repository, first.slug);
		if (!firstCollision) return first;
		const second = await generateTask(ctx, plan, first.slug);
		const secondCollision = collision(repository, second.slug);
		if (!secondCollision) return second;
		throw new Error(
			`generated task slugs ${first.slug} (${firstCollision}) and ` +
				`${second.slug} (${secondCollision}) are occupied`,
		);
	};

	const requireWorktree = (task: Task): string => {
		const path = worktreePath(task);
		const stats = entry(path);
		if (stats === undefined) throw new Error(`${task.slug}: worktree ${path} does not exist`);
		if (!stats.isDirectory()) throw new Error(`${task.slug}: worktree ${path} must be a directory`);
		return path;
	};

	const persistSeededSession = (
		manager: SessionManager,
		name: string,
		marker: TaskMarker | undefined,
	): string => {
		const file = manager.getSessionFile();
		const header = manager.getHeader();
		if (!file || !header) throw new Error("foreground task session has no persisted identity");
		const content = [header, ...manager.getEntries()]
			.map((item) => JSON.stringify(item))
			.join("\n") + "\n";
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
			linkSync(temporary, file);
			rmSync(temporary);
			const reopened = SessionManager.open(file);
			if (reopened.getCwd() !== manager.getCwd()) {
				throw new Error("persisted task session changed its working directory");
			}
			if (reopened.getSessionName() !== name) {
				throw new Error("persisted task session changed its name");
			}
			const reopenedMarker = readTaskMarker(reopened.getBranch());
			const markerMatches = marker === undefined
				? reopenedMarker === undefined
				: reopenedMarker?.version === marker.version &&
					reopenedMarker.slug === marker.slug &&
					reopenedMarker.phase === marker.phase;
			if (!markerMatches) throw new Error("persisted task session changed its task marker");
			return file;
		} catch (cause) {
			rmSync(temporary, { force: true });
			rmSync(file, { force: true });
			throw cause;
		}
	};

	const switchForegroundSession = async (
		ctx: ExtensionCommandContext,
		task: Task,
		name: string,
		marker?: TaskMarker,
		brief?: string,
	): Promise<void> => {
		const worktree = requireWorktree(task);
		if (!ctx.model) throw new Error("task session creation requires a selected model");
		const parentSession = ctx.sessionManager.getSessionFile();
		const manager = SessionManager.create(
			worktree,
			undefined,
			parentSession ? { parentSession } : undefined,
		);
		manager.appendModelChange(ctx.model.provider, ctx.model.id);
		manager.appendThinkingLevelChange(ctx.thinkingLevel ?? pi.getThinkingLevel());
		if (marker) manager.appendCustomEntry(TASK_MARKER, marker);
		manager.appendSessionInfo(name);
		const file = persistSeededSession(manager, name, marker);
		const result = await ctx.switchSession(file, {
			withSession: async (replacement) => {
				if (!brief) return;
				try {
					await replacement.sendUserMessage(brief);
				} catch (cause) {
					replacement.ui.notify(errorMessage(cause), "error");
				}
			},
		});
		if (!result.cancelled) return;
		rmSync(file, { force: true });
		ctx.ui.notify(`${name}: session switch cancelled`, "warning");
	};

	const openPhase = async (
		ctx: ExtensionCommandContext,
		task: Task,
		phase: Phase,
	): Promise<void> => {
		const plan = readPlan(task);
		const marker: TaskMarker = {
			version: MARKER_VERSION,
			slug: task.slug,
			phase: phase.name,
		};
		await switchForegroundSession(
			ctx,
			task,
			`${task.slug} · ${phase.name}`,
			marker,
			implementationBrief(task, phase, plan),
		);
	};

	const openTask = async (ctx: ExtensionCommandContext, task: Task): Promise<void> => {
		const phase = nextOpenPhase(task);
		if (phase) {
			await openPhase(ctx, task, phase);
			return;
		}
		await switchForegroundSession(ctx, task, `${task.slug} · complete`);
	};

	const createNewTask = async (
		ctx: ExtensionCommandContext,
		argument: string,
	): Promise<void> => {
		const planPath = resolve(ctx.cwd, parsePlanArgument(argument));
		const plan = readPlanFile(planPath);
		const repository = repositoryRoot(ctx.cwd);
		requireHead(repository);
		const generated = await generateAvailableTask(ctx, repository, plan);
		const prepared = prepareTaskCreation(
			tasksRoot(),
			generated.slug,
			planPath,
			repository,
			generated.phases,
		);
		const worktree = worktreePath(prepared.task);
		let added = false;
		try {
			addWorktree(repository, worktree, generated.slug);
			added = true;
			const task = commitTaskCreation(prepared);
			const firstPhase = task.phases[0];
			if (!firstPhase) throw new Error(`${task.slug}: generated task has no phases`);
			await openPhase(ctx, task, firstPhase);
		} catch (cause) {
			if (!added) {
				discardTaskCreation(prepared);
				throw cause;
			}
			if (entry(prepared.stagedDirectory) === undefined) throw cause;
			try {
				discardWorktree(repository, worktree, generated.slug);
				discardTaskCreation(prepared);
			} catch (rollbackCause) {
				throw new AggregateError([cause, rollbackCause], "task creation and rollback both failed");
			}
			throw cause;
		}
	};

	const openPicker = async (ctx: ExtensionCommandContext): Promise<void> => {
		const catalog = listTasks(tasksRoot());
		if (catalog.broken.length > 0) {
			ctx.ui.notify(`Unreadable tasks:\n${catalog.broken.join("\n")}`, "warning");
		}
		const selected = await pickTask(ctx, catalog.tasks);
		if (selected) await openTask(ctx, selected);
	};

	pi.registerCommand("task", {
		description: "Create a task from a plan file, or pick an existing task",
		argumentHint: "[plan-file]",
		handler: async (argument, ctx) => {
			try {
				if (ctx.mode !== "tui") throw new Error("/task requires the interactive TUI");
				await ctx.waitForIdle();
				if (argument.trim()) await createNewTask(ctx, argument);
				else await openPicker(ctx);
			} catch (cause) {
				ctx.ui.notify(errorMessage(cause), "error");
			}
		},
	});

	pi.registerCommand(ADVANCE_TASK_COMMAND, {
		description: "Continue after finish_phase completes the current task phase",
		handler: async (argument, ctx) => {
			try {
				if (argument.trim()) throw new Error(`/${ADVANCE_TASK_COMMAND} takes no arguments`);
				await ctx.waitForIdle();
				const marker = sessionMarker(ctx);
				if (!marker) throw new Error("no completed task phase is attached to this session");
				const task = readTask(tasksRoot(), marker.slug);
				const phase = task.phases.find((candidate) => candidate.name === marker.phase);
				if (!phase) throw new Error(`${task.slug}: unknown session phase ${marker.phase}`);
				if (phase.status !== "done") throw new Error(`${phase.name} is not complete`);
				const next = nextOpenPhase(task);
				if (next) {
					await openPhase(ctx, task, next);
					return;
				}
				showTask(ctx, task);
				syncTaskTools(ctx);
				ctx.ui.notify(`${task.slug} is complete`, "info");
			} catch (cause) {
				ctx.ui.notify(errorMessage(cause), "error");
			}
		},
	});
}
