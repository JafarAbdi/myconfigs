/**
 * /task — one verb from idea to merged phases.
 *
 * No model orchestrates this. `/task` advances a state machine derived entirely from the task
 * directory: whichever artifact is missing names the stage, and once the worktree exists the open
 * phases are run one at a time. Models appear only as leaves — the stage conversation, with the
 * operator present and every tool call held to reading the repository, and one fresh implementer
 * child per phase, which cannot delegate further because its runner never grants it `delegate`.
 *
 * Every gate is a keypress. The extension performs exactly two Git writes, each behind a
 * confirmation: `worktree add` when a plan becomes a workspace, and `worktree remove` behind the
 * picker's delete — never a branch, never a commit. It runs no lint or test, and has no opinion
 * whatsoever about what happens between phases.
 *
 * See ./AGENTS.md for the contract, ./tasks.ts for the state, ./prompts.ts for the two briefs.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	rawKeyHint,
	SessionManager,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import { type AutocompleteItem, Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadAgent } from "../subagent/agents.ts";
import { runAgent } from "../subagent/run-agent.ts";
import { childSessionDir, classifyResult, type RunResult } from "../subagent/runtimes.ts";
import { writeReason } from "./bash-guard.ts";
import {
	addWorktree,
	branchExists,
	currentBranch,
	removeWorktree,
	repositoryRoot,
	worktreeChanges,
} from "./git.ts";
import { PHASE_TOOL, registerPhaseTool } from "./phase-tool.ts";
import { pickTask, taskSummary } from "./picker.ts";
import { implementerBrief, RESEARCH_AGENTS, stageBrief } from "./prompts.ts";
import {
	createTask,
	currentStage,
	notesDir,
	isSlug,
	isStage,
	listTasks,
	MAX_SLUG_LENGTH,
	nextOpenPhase,
	hasWorktree,
	readTask,
	readTaskRef,
	removeTaskDir,
	STAGES,
	taskDir,
	taskProgress,
	worktreePath,
	type Phase,
	type Stage,
	type Task,
	type TaskRef,
} from "./tasks.ts";

const WIDGET = "task";

/** Structured identity for one persistent planning-stage session. */
const STAGE_MARK = "task-stage";

interface StageMarkDetails {
	slug: string;
	stage: Stage;
	workspace: true;
}

function stageMark(entries: readonly unknown[]): StageMarkDetails | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== STAGE_MARK) continue;
		const data = entry.data as Partial<StageMarkDetails> | undefined;
		if (
			!data ||
			data.workspace !== true ||
			typeof data.slug !== "string" ||
			typeof data.stage !== "string" ||
			!isStage(data.stage)
		) return undefined;
		return { slug: data.slug, stage: data.stage, workspace: true };
	}
	return undefined;
}

function stageSessionName(slug: string, stage: Stage): string {
	return `${slug} · ${stage}`;
}

/** pi truncates a widget at ten lines, so the live run shows this many steps and counts the rest. */
const RUN_WIDGET_STEPS = 6;

/**
 * The planning stage's capability, not its instructions. Everything here is held to reading the
 * repository by the gate below: `write` and `edit` are confined to the task's `notes/`, `bash` to
 * commands that do not obviously write, and `delegate` to the research roles.
 */
const PLANNING_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit", "delegate", PHASE_TOOL];

/** Naming a task is two words of work, so it runs on a small model rather than the session's own. */
const SLUG_MODEL = { provider: "openai-codex", id: "gpt-5.6-luna" };
const SLUG_THINKING = "low" as const;

/** One constrained call, one field. Strict sampling requires `additionalProperties: false`. */
const SLUG_TOOL = {
	name: "task_slug",
	description: "Name the task with a short lower-case kebab-case slug, two or three words.",
	parameters: Type.Object({
		slug: Type.String({
			maxLength: MAX_SLUG_LENGTH,
			description: "For example joint-rail or lifecycle-broker.",
		}),
	}, { additionalProperties: false }),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
} as const;

const SLUG_PROMPT =
	"Name a software task from its description. Answer only by calling task_slug with two or three " +
	"lower-case words joined by dashes, naming the change itself rather than the act of changing it.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The path as the filesystem sees it, symlinks followed. A file that does not exist yet is resolved
 * through its directory, which does — so a link inside the notes directory cannot smuggle a write
 * out of it by pointing somewhere else.
 */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		try {
			return join(realpathSync(parent), basename(path));
		} catch {
			return path;
		}
	}
}

/** `/task` arguments: a task name, then optionally a stage to redo. */
function words(argument: string): string[] {
	return argument.split(" ").filter(Boolean);
}

export default function taskExtension(pi: ExtensionAPI): void {
	const activeRuns = new Set<AbortController>();

	const tasksRoot = (): string => join(getAgentDir(), "tasks");

	/**
	 * Reads a task that exists; a task that exists but is broken throws rather than disappearing.
	 * Header only: resolution and the gate run on every tool call, and neither has any use for the
	 * phases — reading them there would let one malformed phase file fail every tool in the session.
	 */
	const taskIfPresent = (slug: string): TaskRef | undefined => {
		if (!isSlug(slug)) return undefined;
		return existsSync(taskDir(tasksRoot(), slug)) ? readTaskRef(tasksRoot(), slug) : undefined;
	};

	const drives = (task: TaskRef, root: string | undefined): boolean =>
		root !== undefined && (root === task.header.repository || root === worktreePath(task));

	/**
	 * Which task this session drives: a planning workspace carries a structured session entry and an
	 * implementation workspace is named by its Git branch. The structured entry exists before the
	 * replacement runtime starts, so its tool gate is active from the first event in a fresh stage.
	 */
	const activeTask = (cwd: string, entries: readonly unknown[] = []): TaskRef | undefined => {
		const marked = stageMark(entries);
		const byMark = marked ? taskIfPresent(marked.slug) : undefined;
		if (byMark) return byMark;
		const root = repositoryRoot(cwd);
		const branch = currentBranch(cwd);
		const byBranch = branch ? taskIfPresent(branch) : undefined;
		return byBranch && drives(byBranch, root) ? byBranch : undefined;
	};

	registerPhaseTool(pi, {
		resolveTask: (ctx) => {
			const task = activeTask(ctx.cwd, ctx.sessionManager.getEntries());
			if (!task) throw new Error(`no task is active in ${ctx.cwd}; the phase tool works inside a task only`);
			return readTask(tasksRoot(), task.slug);
		},
	});

	// ── the widget: the whole state of the task, always the next thing to do ──────────────────────

	/** One compact rail for planning; implementation adds only the phase currently under the key. */
	const widgetLines = (ctx: ExtensionContext, task: Task): string[] => {
		const theme = ctx.ui.theme;
		const stage = currentStage(task);
		const stageIndex = STAGES.indexOf(stage);
		const complete = stage === "implement" && task.phases.every((phase) => phase.status === "done");
		const rail = STAGES.map((name, index) => {
			if (index < stageIndex || (complete && index === stageIndex)) {
				return theme.fg("success", `✓ ${name}`);
			}
			if (index === stageIndex) return theme.fg("accent", theme.bold(`● ${name}`));
			return theme.fg("dim", `○ ${name}`);
		}).join(theme.fg("dim", " › "));
		if (stage !== "implement") return [rail];

		const phase = nextOpenPhase(task);
		if (!phase) return [rail, theme.fg("success", `phases ${task.phases.length}/${task.phases.length} complete`)];
		const position = task.phases.findIndex((candidate) => candidate.name === phase.name) + 1;
		return [
			rail,
			`${theme.fg("accent", `phase ${position}/${task.phases.length}`)}` +
			`${theme.fg("muted", ` · ${phase.name} — ${phase.title}`)}`,
		];
	};

	const showTask = (ctx: ExtensionContext, task: Task): void => {
		ctx.ui.setWidget(WIDGET, widgetLines(ctx, task));
	};

	/** The identity of this planning workspace, persisted in the session before it starts. */
	const enteredStage = (ctx: ExtensionContext): StageMarkDetails | undefined =>
		stageMark(ctx.sessionManager.getEntries());

	/** `edit src/a.ts`, `bash cargo test` — what the child is doing, as it does it. */
	const stepLine = (step: RunResult["steps"][number], theme: ExtensionContext["ui"]["theme"]): string => {
		const glyph = !step.outcome
			? theme.fg("accent", "⋯")
			: step.outcome === "failed"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		return `${glyph} ${theme.fg("toolTitle", step.tool)}${step.detail ? theme.fg("dim", ` ${step.detail}`) : ""}`;
	};

	/**
	 * The run while it runs. pi caps a widget at ten lines, so the live view is the last few steps
	 * and a count; the complete list goes into the report, which is a transcript entry and keeps.
	 */
	const showRun = (ctx: ExtensionContext, task: Task, phase: Phase, run: RunResult): void => {
		const theme = ctx.ui.theme;
		const recent = run.steps.slice(-RUN_WIDGET_STEPS);
		const skipped = run.steps.length - recent.length;
		const position = task.phases.findIndex((candidate) => candidate.name === phase.name) + 1;
		const model = ctx.model ? `${ctx.model.id}/${ctx.thinkingLevel ?? "off"}` : "unknown model";
		ctx.ui.setWidget(WIDGET, [
			`${theme.fg("accent", theme.bold("implement"))}` +
			`${theme.fg("muted", ` · phase ${position}/${task.phases.length} · ${phase.name} · ${model} · ${run.turns} turns · ${run.steps.length} steps`)}` +
			`${theme.fg("dim", ` · ${rawKeyHint(Key.escape, "stop")}`)}`,
			...(skipped > 0 ? [theme.fg("dim", `  … ${skipped} earlier`)] : []),
			...recent.map((step) => stepLine(step, theme)),
			...(run.activity ? [theme.fg("thinkingText", run.activity)] : []),
		]);
	};

	// ── planning: read-only until the task has a worktree ─────────────────────────────────────────

	/**
	 * The whole of the read-only stage, decided per tool call from the files.
	 *
	 * There is no mode to enter or leave, and no toolset is borrowed and given back: a session is
	 * planning exactly while the task it drives has no worktree, which is the same fact `/task` reads
	 * to choose a stage. A reload, a resume, a second session, a redo and a deleted task all get the
	 * right answer for free, because none of them can disagree with a fact nobody stored.
	 */
	const planningTask = (ctx: ExtensionContext): TaskRef | undefined => {
		const task = activeTask(ctx.cwd, ctx.sessionManager.getEntries());
		return task && !hasWorktree(task) ? task : undefined;
	};

	pi.on("tool_call", async (event, ctx) => {
		const task = planningTask(ctx);
		if (!task) return undefined;

		// Named rather than derived from the active set: a tool registered after the session started
		// is added to that set automatically, and would otherwise arrive here ungoverned.
		if (!PLANNING_TOOLS.includes(event.toolName)) {
			return {
				block: true,
				reason: `${task.slug} planning: ${event.toolName} is not available while planning. ` +
					`This stage reads the repository and writes only into ${notesDir(task)}.`,
			};
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const notes = realPath(notesDir(task));
			const path = event.input.path;
			const absolute = typeof path === "string" ? realPath(resolve(ctx.cwd, path)) : undefined;
			if (absolute && (absolute === notes || absolute.startsWith(notes + sep))) return undefined;
			return {
				block: true,
				reason: `${task.slug} planning: notes go in ${notes}. ` +
					`The code changes later, in a phase inside the worktree.`,
			};
		}

		if (event.toolName === "bash") {
			const command = event.input.command;
			const reason = typeof command === "string"
				? writeReason(command)
				: "the command is not a string";
			if (reason === undefined) return undefined;
			return {
				block: true,
				reason: `${task.slug} planning: ${reason}. This stage only reads — building, testing, ` +
					`installing and editing happen later, in a phase inside the worktree. Wrappers and ` +
					`redirection are refused too: rephrase as a read, or ask the operator to run it.`,
			};
		}

		if (event.toolName === "delegate") {
			const agent = event.input.agent;
			if (typeof agent === "string" && RESEARCH_AGENTS.includes(agent)) return undefined;
			return {
				block: true,
				reason: `${task.slug} planning: delegate to ${RESEARCH_AGENTS.join(" or ")} only, ` +
					`by name — a resumed run cannot be told apart from any other. ` +
					`Implementation happens later, one phase at a time.`,
			};
		}

		return undefined;
	});

	// ── creating a task ───────────────────────────────────────────────────────────────────────────

	/** Why a name cannot be used, in the words the model is given to try again. */
	const slugTaken = (repository: string, slug: string): string | undefined => {
		if (existsSync(taskDir(tasksRoot(), slug))) return `a task named ${slug} already exists`;
		if (branchExists(repository, slug)) return `${repository} already has a branch named ${slug}`;
		return undefined;
	};

	/**
	 * One constrained call on one named model. Every way it can fail is a failure: no second model is
	 * tried and no prompt appears to paper over it, because a task named by something other than this
	 * would be a different thing wearing the same name.
	 */
	const proposeSlug = async (ctx: ExtensionContext, description: string): Promise<string> => {
		const found = ctx.modelRegistry.find(SLUG_MODEL.provider, SLUG_MODEL.id);
		if (!found) throw new Error(`${SLUG_MODEL.provider}/${SLUG_MODEL.id} is not available; /task names tasks with it`);
		// `completeSimple` rather than the registry's `complete`, because only the simple options
		// carry `reasoning`: naming a task does not deserve a thinking budget.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
		if (!auth.ok) throw new Error(`${found.id}: ${auth.error}`);
		// A per-credential endpoint belongs to the model, not to the request — model-runtime.ts:600
		// applies it exactly this way. Everything else pi resolved is passed through as it came.
		const { ok: _resolved, baseUrl, ...request } = auth;
		const model = baseUrl ? { ...found, baseUrl } : found;
		const response = await completeSimple(model, {
			systemPrompt: SLUG_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: description }], timestamp: Date.now() }],
			tools: [SLUG_TOOL],
		}, { ...request, reasoning: SLUG_THINKING });
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(`${model.id}: ${response.errorMessage ?? response.stopReason}`);
		}
		const call = response.content.find(
			(content) => content.type === "toolCall" && content.name === SLUG_TOOL.name,
		);
		if (call?.type !== "toolCall") {
			throw new Error(`${model.id} answered without calling ${SLUG_TOOL.name}`);
		}
		const slug = call.arguments.slug;
		if (typeof slug !== "string" || !isSlug(slug)) {
			throw new Error(`${model.id} answered ${JSON.stringify(slug)}, which is not a task name`);
		}
		return slug;
	};

	/**
	 * The name is claimed once, against everything it has to be unique in: the tasks directory and
	 * the repository's branches. A collision is told to the model rather than to the operator — one
	 * more attempt, with the reason — because it knows the task and can name it another way. Two
	 * collisions is a repository that already has this work in it, which is the operator's to sort out.
	 */
	const nameTask = async (ctx: ExtensionContext, repository: string, description: string): Promise<string> => {
		const first = await proposeSlug(ctx, description);
		const taken = slugTaken(repository, first);
		if (!taken) return first;
		const second = await proposeSlug(ctx, `${description}\n\nDo not answer ${first}: ${taken}. Name it differently.`);
		const stillTaken = slugTaken(repository, second);
		if (!stillTaken) return second;
		throw new Error(`${first} and ${second} are both taken (${taken}; ${stillTaken})`);
	};

	const newTask = async (ctx: ExtensionContext): Promise<Task | undefined> => {
		const repository = repositoryRoot(ctx.cwd);
		if (!repository) throw new Error(`${ctx.cwd} is not a Git repository`);
		const base = currentBranch(repository);
		if (!base) throw new Error(`${repository} has no current branch to fork from`);
		const description = (await ctx.ui.input("What is the task?", "a sentence or two"))?.trim();
		if (!description) return undefined;
		return createTask(tasksRoot(), await nameTask(ctx, repository, description), { repository, base, description });
	};

	// ── removing a task: the plan and the workspace, never the branch ─────────────────────────────

	/**
	 * The branch survives on purpose: it is the work, and the operator may still want to open a pull
	 * request from it. What goes is the planning — the task directory — and the worktree that held it.
	 *
	 * The dialog states what is uncommitted in that worktree, and `--force` is used exactly when it
	 * had something to state, so a confirmation is never followed by a refusal the operator cannot
	 * act on. Commits are not counted: the branch is kept, so there is nothing there to lose.
	 */
	const removeTask = async (ctx: ExtensionContext, task: TaskRef): Promise<void> => {
		const worktree = worktreePath(task);
		const present = existsSync(worktree);
		const changes = present ? worktreeChanges(worktree) : undefined;
		const discarded = !present
			? undefined
			: changes === undefined
				? "uncommitted state unknown — work may be discarded"
				: changes.modified + changes.untracked > 0
					? `${changes.modified} modified, ${changes.untracked} untracked — discarded`
					: undefined;
		const confirmed = await ctx.ui.confirm(
			`Delete task ${task.slug}?`,
			[
				`plan and notes  ${task.directory}`,
				...(present ? [`worktree        ${worktree}${discarded ? `\n                ${discarded}` : ""}`] : []),
				`\nBranch ${task.slug} is kept.`,
			].join("\n"),
		);
		if (!confirmed) return;
		if (present) {
			try {
				removeWorktree(task.header.repository, worktree, discarded !== undefined);
			} catch (error) {
				throw new Error(`${task.slug} was not deleted: ${errorMessage(error)}`, { cause: error });
			}
		}
		removeTaskDir(tasksRoot(), task.slug);
		ctx.ui.setWidget(WIDGET, undefined);
		ctx.ui.notify(`Deleted task ${task.slug}`, "info");
	};

	const chooseTask = async (ctx: ExtensionContext): Promise<Task | undefined> => {
		for (;;) {
			const { tasks, broken } = listTasks(tasksRoot());
			if (broken.length) ctx.ui.notify(`unreadable tasks: ${broken.join("; ")}`, "warning");
			const choice = await pickTask(ctx, tasks);
			if (!choice) return undefined;
			if (choice.kind === "new") return await newTask(ctx);
			if (choice.kind === "open") return readTask(tasksRoot(), choice.slug);
			await removeTask(ctx, readTask(tasksRoot(), choice.slug));
		}
	};

	// ── the two moves the state machine can make ──────────────────────────────────────────────────

	const createWorktree = async (ctx: ExtensionContext, task: Task): Promise<Task | undefined> => {
		const { repository, base } = task.header;
		const path = worktreePath(task);
		// The phases are in the question: this keypress is where the plan stops being discussable.
		const phases = task.phases.map((phase) => `  ${phase.name}  ${phase.title}`).join("\n");
		const confirmed = await ctx.ui.confirm(
			`Start implementing ${task.slug}?`,
			`worktree ${path}\nbranch ${task.slug} from ${base}\n\n` +
				(phases ? `${task.phases.length} phases:\n${phases}` : "no phases yet"),
		);
		if (!confirmed) return undefined;
		// The worktree appearing is what ends the planning stage — there is nothing to record.
		addWorktree(repository, path, task.slug, base);
		ctx.ui.notify(`Worktree ${path} on branch ${task.slug}`, "info");
		return readTask(tasksRoot(), task.slug);
	};

	const runPhase = async (ctx: ExtensionContext, task: Task, phase: Phase): Promise<void> => {
		const agent = loadAgent("implementer");
		if (!agent) throw new Error("the implementer agent is unavailable");
		const worktree = worktreePath(task);
		if (!existsSync(worktree)) {
			throw new Error(
				`${task.slug}: its worktree ${worktree} is gone. Restore it, or run ` +
					`\`git worktree prune\` in ${task.header.repository} and delete the task.`,
			);
		}
		const was = new Map(task.phases.map((candidate) => [candidate.name, candidate.status]));
		const childSessionDirectory = childSessionDir(
			ctx.sessionManager.getSessionDir(),
			ctx.sessionManager.getSessionId(),
			getAgentDir(),
		);
		const childSessionId = randomUUID();
		const aborts = new AbortController();
		activeRuns.add(aborts);
		// A phase you cannot stop is the seven-hour run in miniature. Escape ends the child, and is
		// consumed rather than merely observed: one that also reached the editor would be a second
		// press away from opening the tree selector over a running phase. The phase then stays open,
		// its report says how far it got, and /task runs it again.
		const stopWatchingInput = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) return undefined;
			aborts.abort(new Error("stopped by the operator"));
			return { consume: true };
		});
		let result: RunResult;
		try {
			result = await runAgent({
				// The child's capability, granted here and nowhere else: an implementer delegated to
				// from a conversation has no business closing phases.
				agent: { ...agent, tools: [...agent.tools, PHASE_TOOL] },
				task: implementerBrief(task, phase),
				resultTask: `${task.slug} ${phase.name}`,
				cwd: worktree,
				inherited: {
					sessionDir: childSessionDirectory,
					sessionId: childSessionId,
					...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
					...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
				},
				model: undefined,
				signal: aborts.signal,
				onProgress: (partial) => showRun(ctx, task, phase, partial),
			});
		} finally {
			// Teardown only. A filesystem read here would throw past the report the run just produced.
			stopWatchingInput();
			activeRuns.delete(aborts);
		}

		// The phase file, not the run, says whether the phase is done: a child that stopped to report
		// a mismatch finishes successfully and leaves its phase open, which is exactly right.
		const updated = readTask(tasksRoot(), task.slug);
		const after = updated.phases.find((candidate) => candidate.name === phase.name);
		showTask(ctx, updated);
		const outcome = classifyResult(result);
		// Everything the run was, in one entry that keeps: what it did, what it said, and the command
		// that opens its own session — the widget above only ever showed the last few steps.
		const steps = result.steps
			.map((step) => `${!step.outcome ? "⋯" : step.outcome === "failed" ? "\u2717" : "\u2713"} ${step.tool}${step.detail ? ` ${step.detail}` : ""}`)
			.join("\n");
		pi.sendMessage(
			{
				customType: "task-phase-report",
				content: [
					`**${phase.name} \u2014 ${phase.title}**`,
					outcome.kind === "success" ? undefined : outcome.message,
					result.output.trim() || "(no report)",
					steps ? `**${result.steps.length} steps**\n\n${steps}` : undefined,
					`Its own session: \`pi --session-dir ${childSessionDirectory} --session ${childSessionId}\``,
				].filter(Boolean).join("\n\n"),
				display: true,
			},
			{ triggerTurn: false },
		);
		// The tool can reach every phase of the task, so say so when a run closed one that was not its
		// own: the operator decides whether that was right, and the file is theirs to correct.
		const strayed = updated.phases.filter(
			(candidate) => candidate.name !== phase.name && candidate.status !== was.get(candidate.name),
		);
		if (strayed.length) {
			const changes = strayed.map((candidate) => `${candidate.name} → ${candidate.status}`).join(", ");
			ctx.ui.notify(`${phase.name}'s run also changed ${changes}`, "warning");
		}
		// Stopping and finishing can happen in either order — the child may close its phase and be
		// killed a moment later. Both facts are reported rather than one of them guessed at.
		const stopped = result.termination === "cancelled";
		const { done, total } = taskProgress(updated);
		if (after?.status === "done") {
			ctx.ui.notify(
				stopped
					? `${phase.name}: you stopped it, and its file says done · ${done}/${total} phases`
					: `${phase.name} done · ${done}/${total} phases`,
				stopped ? "warning" : "info",
			);
		} else {
			ctx.ui.notify(
				`${phase.name} ${stopped ? "stopped" : "ended"} without completing — read its report`,
				"warning",
			);
		}
	};

	/** The latest saved workspace for this task stage; `SessionManager.list` is newest first. */
	const stageSession = async (ctx: ExtensionCommandContext, task: Task, stage: Stage): Promise<string | undefined> => {
		const name = stageSessionName(task.slug, stage);
		const sessionDir = ctx.sessionManager.getSessionDir();
		const sessions = [
			...await SessionManager.listAll(),
			...await SessionManager.listAll(sessionDir),
		].sort((left, right) => right.modified.getTime() - left.modified.getTime());
		for (const session of sessions) {
			if (session.name !== name) continue;
			const mark = stageMark(SessionManager.open(session.path).getEntries());
			if (mark?.slug === task.slug && mark.stage === stage) return session.path;
		}
		return undefined;
	};

	/**
	 * A stage workspace is one persistent Pi session. Ordinary entry resumes it without sending a
	 * message; `new` replaces it with a blank child session, whose setup entry makes the read-only
	 * gate active before the replacement instance's `session_start` event.
	 */
	const enterStage = async (
		ctx: ExtensionCommandContext,
		task: Task,
		stage: Stage,
		freshSession: boolean,
	): Promise<void> => {
		const name = stageSessionName(task.slug, stage);
		const current = stageMark(ctx.sessionManager.getEntries());
		if (!freshSession && current?.slug === task.slug && current.stage === stage) {
			showTask(ctx, task);
			ctx.ui.notify(`${name}: already active`, "info");
			return;
		}

		if (!freshSession) {
			const saved = await stageSession(ctx, task, stage);
			if (saved) {
				const result = await ctx.switchSession(saved);
				if (result.cancelled) ctx.ui.notify(`${name}: resume cancelled`, "warning");
				return;
			}
		}

		const parentSession = ctx.sessionManager.getSessionFile();
		const inheritedModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const inheritedThinkingLevel = ctx.thinkingLevel;
		// TODO(pi#5263): Restore these into Pi 0.84's live runtime once setters are session-only.
		const mark: StageMarkDetails = { slug: task.slug, stage, workspace: true };
		const result = await ctx.newSession({
			...(parentSession ? { parentSession } : {}),
			setup: async (session) => {
				if (inheritedModel) session.appendModelChange(inheritedModel.provider, inheritedModel.id);
				if (inheritedThinkingLevel) session.appendThinkingLevelChange(inheritedThinkingLevel);
				session.appendCustomEntry(STAGE_MARK, mark);
				session.appendSessionInfo(name);
			},
			withSession: async (replacement) => {
				await replacement.sendUserMessage(stageBrief(task, stage));
			},
		});
		if (result.cancelled) ctx.ui.notify(`${name}: new session cancelled`, "warning");
	};

	const advance = async (
		ctx: ExtensionCommandContext,
		task: Task,
		redo?: Stage,
		freshSession = false,
	): Promise<void> => {
		let current = task;
		const stage = redo ?? currentStage(current);

		if (stage !== "implement") {
			await enterStage(ctx, current, stage, freshSession);
			return;
		}

		if (freshSession) throw new Error("new is available for planning stages only");

		if (!hasWorktree(current)) {
			const started = await createWorktree(ctx, current);
			if (!started) {
				showTask(ctx, current);
				return;
			}
			current = started;
		}

		showTask(ctx, current);
		if (current.phases.length === 0) {
			ctx.ui.notify(`${current.slug} has no phases yet — create them with the ${PHASE_TOOL} tool`, "warning");
			return;
		}
		const phase = nextOpenPhase(current);
		if (!phase) {
			ctx.ui.notify(`${current.slug}: every phase is done — ${worktreePath(current)} is yours`, "info");
			return;
		}
		await runPhase(ctx, current, phase);
	};

	// ── the command ───────────────────────────────────────────────────────────────────────────────

	pi.registerCommand("task", {
		description: "Plan and implement one task in its own worktree, one phase at a time",
		// pi replaces the whole argument prefix with an item's value. A task completion therefore keeps
		// a trailing space: typing the first stage letter (or pressing Tab immediately) asks this same
		// callback for the second argument instead of leaving the completed slug as a dead end.
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const [slug, stage, mode] = words(prefix);
			const completingMode = mode !== undefined || (stage !== undefined && prefix.endsWith(" "));
			const completingStage = !completingMode && (stage !== undefined || prefix.endsWith(" "));
			const items = completingMode
				? stage !== "implement" && "new".startsWith(mode ?? "")
					? [{ value: `${slug} ${stage} new`, label: "new", description: "start a fresh stage session" }]
					: []
				: completingStage
					? STAGES.filter((name) => name.startsWith(stage ?? "")).map((name) => ({
						value: `${slug} ${name} `,
						label: name,
						description: `resume the ${name} stage`,
					}))
					: listTasks(tasksRoot())
						.tasks.filter((task) => task.slug.startsWith(slug ?? ""))
						.map((task) => ({ value: `${task.slug} `, label: task.slug, description: taskSummary(task) }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				if (ctx.mode !== "tui") throw new Error("/task needs the interactive TUI");
				await ctx.waitForIdle();
				const [slug, stage, mode, ...rest] = words(args);
				if (rest.length || (mode !== undefined && mode !== "new")) {
					throw new Error("/task takes a task name, optionally one stage, then optionally new");
				}
				if (mode === "new" && stage === undefined) throw new Error("new requires a stage");
				if (stage !== undefined && !isStage(stage)) {
					throw new Error(`no stage ${stage}; stages are ${STAGES.join(", ")}`);
				}
				if (slug !== undefined) {
					const named = taskIfPresent(slug);
					if (!named) throw new Error(`no task ${slug}; run /task to see them`);
					await advance(ctx, readTask(tasksRoot(), named.slug), stage, mode === "new");
					return;
				}
				const active = activeTask(ctx.cwd, ctx.sessionManager.getEntries());
				const task = active ? readTask(tasksRoot(), active.slug) : await chooseTask(ctx);
				if (task) await advance(ctx, task);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	// A stage artifact is the transition signal. Once the turn that wrote it fully settles, repaint
	// from disk and put the existing command under the operator's Enter key. Revisions are excluded:
	// their derived stage was already downstream when their brief arrived, so they did not advance.
	let stageAtTurnStart: Stage | undefined;
	pi.on("agent_start", (_event, ctx) => {
		if (stageAtTurnStart !== undefined) return;
		const active = activeTask(ctx.cwd, ctx.sessionManager.getEntries());
		stageAtTurnStart = active ? currentStage(readTask(tasksRoot(), active.slug)) : undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		const active = activeTask(ctx.cwd, ctx.sessionManager.getEntries());
		if (!active) return;
		const task = readTask(tasksRoot(), active.slug);
		const entered = enteredStage(ctx);
		const next = entered ? STAGES[STAGES.indexOf(entered.stage) + 1] : undefined;
		const advanced = stageAtTurnStart === entered?.stage && currentStage(task) === next;
		stageAtTurnStart = undefined;
		showTask(ctx, task);
		if (advanced && ctx.mode === "tui" && ctx.ui.getEditorText().length === 0) {
			ctx.ui.setEditorText("/task");
		}
	});

	// Pi treats Tab after a command argument as forced file completion. Route that one case back
	// through ordinary slash-command completion so `/task <slug> ` can offer its stage argument.
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: [],
			getSuggestions(lines, line, column, options) {
				const before = (lines[line] ?? "").slice(0, column);
				return current.getSuggestions(
					lines,
					line,
					column,
					options.force && before.startsWith("/task ") ? { ...options, force: false } : options,
				);
			},
			applyCompletion(lines, line, column, item, prefix) {
				return current.applyCompletion(lines, line, column, item, prefix);
			},
			shouldTriggerFileCompletion(lines, line, column) {
				return current.shouldTriggerFileCompletion?.(lines, line, column) ?? true;
			},
		}));

		// A resumed session shows where its task is and nothing else: the read-only hold is decided per
		// tool call, and the interrupted conversation is still right there, so no brief is re-sent.
		const active = activeTask(ctx.cwd, ctx.sessionManager.getEntries());
		if (!active) return;
		showTask(ctx, readTask(tasksRoot(), active.slug));
	});

	pi.on("session_shutdown", async () => {
		for (const aborts of activeRuns) aborts.abort(new Error("session shut down"));
		activeRuns.clear();
	});
}
