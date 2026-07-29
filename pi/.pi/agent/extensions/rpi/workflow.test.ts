import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionManager as SessionManagerInstance } from "@earendil-works/pi-coding-agent";
import type {
	OutlineRevision,
	OutlineStore,
	PendingPhase,
	SetOutlineInput,
} from "./outline.ts";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface Notice {
	message: string;
	level: string;
	cwd: string;
}

interface CapturedPrompt {
	text: string;
	cwd: string;
	session: string | undefined;
	name: string | undefined;
}

interface CapturedSelection {
	question: string;
	options: string[];
}

interface QuestionUpdateParams {
	task_slug: string;
	incorporated_question_ids: string[];
	questions: Array<{
		title: string;
		question: string;
		options: string[];
		recommended_option: number;
		recommendation: string;
	}>;
}

type ToolParams = QuestionUpdateParams | SetOutlineInput;

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: ToolParams,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: MockContext,
	): Promise<unknown>;
}

interface MockEvent {
	reason?: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
	text?: string;
	source?: string;
}

interface SessionOptions {
	parentSession?: string;
	setup?: (manager: SessionManagerInstance) => Promise<void>;
	withSession?: (ctx: MockContext) => Promise<void>;
}

interface MockModel {
	provider: string;
	id: string;
}

interface MockContext {
	cwd: string;
	mode: "rpc" | "tui";
	hasUI: true;
	sessionManager: SessionManagerInstance;
	modelRegistry: {
		find(provider: string, id: string): MockModel | undefined;
	};
	model: MockModel | undefined;
	thinkingLevel: string;
	signal: undefined;
	ui: MockUI;
	isIdle(): true;
	isProjectTrusted(): true;
	abort(): void;
	hasPendingMessages(): false;
	shutdown(): void;
	getContextUsage(): undefined;
	compact(): void;
	getSystemPrompt(): string;
	getSystemPromptOptions(): Record<string, never>;
	waitForIdle(): Promise<void>;
	newSession(options?: SessionOptions): Promise<{ cancelled: boolean }>;
	switchSession(
		path: string,
		options?: Pick<SessionOptions, "withSession">,
	): Promise<{ cancelled: boolean }>;
	sendUserMessage(text: string): Promise<void>;
}

interface MockUI {
	editor(question: string): Promise<string | undefined>;
	confirm(title: string, body: string): Promise<boolean>;
	select(question: string, options: string[]): Promise<string | undefined>;
	input(question: string, placeholder?: string): Promise<string | undefined>;
	custom<T>(): Promise<T | undefined>;
	notify(message: string, level: string): void;
	setWidget(key: string, value: unknown): void;
	getEditorText(): string;
	setEditorText(text: string): void;
}

const agentDir = mkdtempSync(join(tmpdir(), "rpi-workflow-agent-"));
const configuredAgentDir = `${agentDir}-link`;
symlinkSync(agentDir, configuredAgentDir, "dir");
const scratch = mkdtempSync(join(tmpdir(), "rpi-workflow-repos-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const gitIdentity = {
	GIT_AUTHOR_NAME: "RPI Test",
	GIT_AUTHOR_EMAIL: "rpi-test@example.invalid",
	GIT_COMMITTER_NAME: "RPI Test",
	GIT_COMMITTER_EMAIL: "rpi-test@example.invalid",
};
const previousGitIdentity = new Map(
	Object.keys(gitIdentity).map((name) => [name, process.env[name]]),
);
process.env.PI_CODING_AGENT_DIR = configuredAgentDir;
Object.assign(process.env, gitIdentity);

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const localModules = join(extensionDirectory, "node_modules");
const piPackage =
	"/home/juruc/.local/share/fnm/node-versions/v22.22.3/installation/lib/node_modules/@earendil-works/pi-coding-agent";
let removeLocalModules = false;

function cleanupTempFiles(): void {
	rmSync(scratch, { recursive: true, force: true });
	rmSync(configuredAgentDir, { force: true });
	rmSync(agentDir, { recursive: true, force: true });
	if (removeLocalModules)
		rmSync(localModules, { recursive: true, force: true });
}
process.once("exit", cleanupTempFiles);

if (existsSync(localModules))
	throw new Error(`${localModules} already exists; refusing to replace it`);
mkdirSync(join(localModules, "@earendil-works"), { recursive: true });
removeLocalModules = true;
for (const name of ["pi-ai", "pi-tui"]) {
	symlinkSync(
		join(piPackage, "node_modules", "@earendil-works", name),
		join(localModules, "@earendil-works", name),
		"dir",
	);
}
symlinkSync(
	piPackage,
	join(localModules, "@earendil-works", "pi-coding-agent"),
	"dir",
);
symlinkSync(
	join(piPackage, "node_modules", "typebox"),
	join(localModules, "typebox"),
	"dir",
);

async function main(): Promise<void> {
	const [{ default: registerRpi }, { SessionManager }, { renderBuildPhase }] =
		await Promise.all([
			import("./index.ts"),
			import("@earendil-works/pi-coding-agent"),
			import("./outline.ts"),
		]);

	function run(
		command: string,
		args: string[],
		options: { cwd: string; timeout?: number },
	): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd: options.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const timer = options.timeout
				? setTimeout(() => child.kill("SIGKILL"), options.timeout)
				: undefined;
			child.on("error", reject);
			child.on("close", (code, signal) => {
				if (timer) clearTimeout(timer);
				resolve({ code: signal ? 124 : (code ?? 1), stdout, stderr });
			});
		});
	}

	async function git(cwd: string, ...args: string[]): Promise<string> {
		const result = await run("git", args, { cwd, timeout: 10_000 });
		assert.equal(
			result.code,
			0,
			`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`,
		);
		return result.stdout.trim();
	}

	async function initRepository(
		name: string,
	): Promise<{ root: string; head: string; common: string }> {
		const root = join(scratch, name);
		mkdirSync(root);
		await git(root, "init", "-b", "main");
		writeFileSync(join(root, "tracked.txt"), "committed\n");
		await git(root, "add", "tracked.txt");
		await git(root, "commit", "-m", "Base");
		return {
			root,
			head: await git(root, "rev-parse", "HEAD"),
			common: realpathSync(
				await git(
					root,
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				),
			),
		};
	}

	const tasks = join(agentDir, "tasks");
	const worktrees = join(agentDir, "worktrees");
	const phaseInput = {
		title: "Implement the focused change",
		summary: "Implement the agreed focused behavior.",
		file_changes: [
			{ path: "tracked.txt", change: "Apply the focused change." },
		],
		verification: ["git diff --check"],
	};
	const outlineInput = (
		slug: string,
		phases = [phaseInput],
	): SetOutlineInput => ({
		task_slug: slug,
		overview: {
			kind: "revise",
			title: "Focused implementation",
			summary: "Implement the agreed design in focused phases.",
			desired_end_state: "The focused behavior is implemented and verified.",
		},
		pending: phases.map((phase) => ({ kind: "add", ...phase })),
		removed_pending_ids: [],
	});
	const pendingPhase = (id = "P1", input = phaseInput): PendingPhase => ({
		id,
		status: "pending",
		...input,
		file_changes: input.file_changes.map((change) => ({ ...change })),
		verification: [...input.verification],
		resolution: null,
	});
	const outlineStore = (
		phases: OutlineStore["phases"] = [pendingPhase()],
		next_phase_id = phases.length + 1,
	): OutlineStore => ({
		version: 1,
		next_phase_id,
		title: "Focused implementation",
		summary: "Implement the agreed design in focused phases.",
		desired_end_state: "The focused behavior is implemented and verified.",
		phases,
	});
	const serializeOutlineStore = (store: OutlineStore): string =>
		`${JSON.stringify(store, null, 2)}\n`;
	const emptyDesign =
		"# Design\n\n### Proposed architecture\n\nUse the existing adapter.\n";
	const cacheInput = {
		title: "Cache ownership",
		question: "Which layer should own the cache?",
		options: ["The adapter", "The caller"],
		recommended_option: 1,
		recommendation: "The adapter already owns the remote lifecycle.",
	};
	const evictionInput = {
		title: "Eviction timing",
		question: "When should stale entries be removed?",
		options: ["During writes", "By a background timer"],
		recommended_option: 1,
		recommendation: "Write-time eviction avoids another lifecycle.",
	};
	const cacheQuestion = {
		id: "Q1",
		...cacheInput,
		status: "open",
		answer: null,
	};
	const evictionQuestion = {
		id: "Q2",
		...evictionInput,
		status: "open",
		answer: null,
	};

	function state(
		gitLocation: string,
		_head: string,
		phase: string,
		extra: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			version: 5,
			phase,
			baseBranch: "main",
			...(phase === "creating" ? { sourceRoot: gitLocation } : {}),
			...(phase === "deleting" ? { gitDirectory: gitLocation } : {}),
			...extra,
		};
	}

	function persistTask(
		slug: string,
		taskState: Record<string, unknown>,
		outline?: OutlineStore,
	): void {
		const directory = join(tasks, slug);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "ticket.md"), `# ${slug}\n\nTest task.\n`);
		writeFileSync(
			join(directory, "state.json"),
			`${JSON.stringify(taskState, null, 2)}\n`,
		);
		if (outline !== undefined)
			writeFileSync(
				join(directory, "outline.json"),
				serializeOutlineStore(outline),
			);
	}

	function loadOutline(slug: string): OutlineStore {
		return JSON.parse(
			readFileSync(join(tasks, slug, "outline.json"), "utf8"),
		) as OutlineStore;
	}

	function loadCandidate(slug: string): OutlineRevision {
		return JSON.parse(
			readFileSync(join(tasks, slug, "outline-candidate.json"), "utf8"),
		) as OutlineRevision;
	}

	function loadState(slug: string): Record<string, unknown> {
		return JSON.parse(
			readFileSync(join(tasks, slug, "state.json"), "utf8"),
		) as Record<string, unknown>;
	}

	function setOutlineOwner(slug: string, owner: SessionManagerInstance): void {
		const session = owner.getSessionFile();
		assert.ok(session);
		writeFileSync(
			join(tasks, slug, "state.json"),
			`${JSON.stringify({ ...loadState(slug), session }, null, 2)}\n`,
		);
	}

	function persistQuestions(slug: string, questions: unknown[]): void {
		writeFileSync(
			join(tasks, slug, "questions.json"),
			`${JSON.stringify({ version: 1, questions }, null, 2)}\n`,
		);
	}

	function loadQuestions(slug: string): {
		version: number;
		questions: Array<Record<string, unknown>>;
	} {
		return JSON.parse(
			readFileSync(join(tasks, slug, "questions.json"), "utf8"),
		) as { version: number; questions: Array<Record<string, unknown>> };
	}

	class Harness {
		readonly notices: Notice[] = [];
		readonly prompts: CapturedPrompt[] = [];
		readonly switches: string[] = [];
		readonly confirmations: Array<{ title: string; body: string }> = [];
		readonly editors: string[] = [];
		readonly selections: CapturedSelection[] = [];
		readonly tools: string[] = [];
		readonly widgets: unknown[] = [];
		readonly editorTexts: string[] = [];
		cancelNextSwitch = false;
		beforeNextConfirm: (() => Promise<void> | void) | undefined;
		beforeNextSelect: (() => Promise<void> | void) | undefined;
		private manager: SessionManagerInstance | undefined;
		private command:
			| ((args: string, ctx: MockContext) => Promise<void>)
			| undefined;
		private sessionStart:
			| ((event: MockEvent, ctx: MockContext) => Promise<unknown>)
			| undefined;
		private agentSettled:
			| ((event: MockEvent, ctx: MockContext) => Promise<unknown>)
			| undefined;
		private inputHandler:
			| ((event: MockEvent, ctx: MockContext) => Promise<unknown>)
			| undefined;
		private readonly registeredTools = new Map<string, RegisteredTool>();
		private availableModel: MockModel | undefined;
		private selectedModel: MockModel | undefined;
		private thinkingLevel = "off";
		private editorAnswers: string[] = [];
		private confirmAnswers: boolean[] = [];
		private selectAnswers: string[] = [];
		private inputAnswers: string[] = [];
		private customAnswers: unknown[] = [];
		private readonly commitPrompt = join(agentDir, "commit-message.md");
		private readonly auditPrompt = join(agentDir, "audit.md");

		constructor() {
			writeFileSync(
				this.auditPrompt,
				"---\ndescription: test\n---\nReview this scope: ${@:-the current git diff}\n",
			);
			writeFileSync(
				this.commitPrompt,
				"---\ndescription: test\n---\nCommit the staged change.\n",
			);
			const api = {
				on: (
					event: string,
					handler: (event: MockEvent, ctx: MockContext) => Promise<unknown>,
				) => {
					if (event === "session_start") this.sessionStart = handler;
					if (event === "agent_settled") this.agentSettled = handler;
					if (event === "input") this.inputHandler = handler;
				},
				registerTool: (tool: RegisteredTool) => {
					this.tools.push(tool.name);
					this.registeredTools.set(tool.name, tool);
				},
				registerCommand: (
					name: string,
					options: {
						handler: (args: string, ctx: MockContext) => Promise<void>;
					},
				) => {
					if (name === "rpi") this.command = options.handler;
				},
				getSessionName: () => this.manager?.getSessionName(),
				setSessionName: (name: string) => {
					assert.ok(this.manager);
					this.manager.appendSessionInfo(name);
				},
				sendUserMessage: (text: string) => this.capturePrompt(text),
				setModel: async (model: MockModel) => {
					const sameModel =
						this.selectedModel?.provider === model.provider &&
						this.selectedModel.id === model.id;
					if (!sameModel) this.thinkingLevel = "off";
					this.selectedModel = model;
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level: string) => {
					this.thinkingLevel = level;
				},
				getCommands: () => [
					{
						name: "commit-message",
						source: "prompt",
						sourceInfo: { path: this.commitPrompt },
					},
					{
						name: "audit",
						source: "prompt",
						sourceInfo: { path: this.auditPrompt },
					},
				],
			};
			registerRpi(api as unknown as Parameters<typeof registerRpi>[0]);
		}

		async invoke(
			slug: string,
			cwd: string,
			options: { description?: string; confirm?: boolean } = {},
		): Promise<void> {
			assert.ok(this.command, "RPI command was not registered");
			this.editorAnswers = options.description ? [options.description] : [];
			this.confirmAnswers =
				options.confirm === undefined ? [] : [options.confirm];
			this.selectAnswers = [];
			this.inputAnswers = [];
			const source = SessionManager.create(cwd);
			this.persistSession(source, `source · ${slug}`);
			await this.withManager(source, () =>
				this.command?.(slug, this.context(source)),
			);
		}

		async executeTool(
			name: "rpi_set_outline" | "rpi_update_design_questions",
			manager: SessionManagerInstance,
			params: ToolParams,
		): Promise<void> {
			const tool = this.registeredTools.get(name);
			assert.ok(tool, `${name} was not registered`);
			await this.withManager(manager, () =>
				tool.execute(
					"test-tool-call",
					params,
					new AbortController().signal,
					() => undefined,
					this.context(manager),
				),
			);
		}

		async updateQuestions(
			manager: SessionManagerInstance,
			params: QuestionUpdateParams,
		): Promise<void> {
			await this.executeTool("rpi_update_design_questions", manager, params);
		}

		async setOutline(
			manager: SessionManagerInstance,
			params: SetOutlineInput,
		): Promise<void> {
			await this.executeTool("rpi_set_outline", manager, params);
		}

		async startSession(
			manager: SessionManagerInstance,
			event: Pick<MockEvent, "reason" | "previousSessionFile"> = {},
		): Promise<void> {
			assert.ok(this.sessionStart, "session_start was not registered");
			await this.withManager(manager, () =>
				this.sessionStart?.(
					{ reason: "startup", ...event },
					this.context(manager),
				),
			);
		}

		async settle(manager: SessionManagerInstance): Promise<void> {
			assert.ok(this.agentSettled, "agent_settled was not registered");
			await this.withManager(manager, () =>
				this.agentSettled?.({}, this.context(manager)),
			);
		}

		async input(
			manager: SessionManagerInstance,
			text = "inspect recovery",
		): Promise<unknown> {
			assert.ok(this.inputHandler, "input was not registered");
			return this.withManager(manager, () =>
				this.inputHandler?.({ text, source: "user" }, this.context(manager)),
			);
		}

		configureModel(
			available: MockModel,
			selected: MockModel,
			thinkingLevel: string,
		): void {
			this.availableModel = available;
			this.selectedModel = selected;
			this.thinkingLevel = thinkingLevel;
		}

		sessionSettings(): {
			model: MockModel | undefined;
			thinkingLevel: string;
		} {
			return { model: this.selectedModel, thinkingLevel: this.thinkingLevel };
		}

		resetModel(): void {
			this.availableModel = undefined;
			this.selectedModel = undefined;
			this.thinkingLevel = "off";
		}

		async remove(slug: string, cwd: string): Promise<void> {
			assert.ok(this.command, "RPI command was not registered");
			this.confirmAnswers = [true];
			this.customAnswers = [{ action: "remove", slug }, { action: "cancel" }];
			const source = SessionManager.create(cwd);
			this.persistSession(source, `remove · ${slug}`);
			await this.withManager(source, () =>
				this.command?.("", this.context(source, "tui")),
			);
		}

		async invokeInSession(
			slug: string,
			manager: SessionManagerInstance,
			selection?: string | string[],
			editorAnswer?: string,
			inputAnswer?: string | string[],
		): Promise<void> {
			assert.ok(this.command, "RPI command was not registered");
			this.editorAnswers = editorAnswer === undefined ? [] : [editorAnswer];
			this.confirmAnswers = [];
			this.selectAnswers = Array.isArray(selection)
				? [...selection]
				: selection
					? [selection]
					: [];
			this.inputAnswers = Array.isArray(inputAnswer)
				? [...inputAnswer]
				: inputAnswer === undefined
					? []
					: [inputAnswer];
			await this.withManager(manager, () =>
				this.command?.(slug, this.context(manager)),
			);
		}

		createOwner(cwd: string, name: string): SessionManagerInstance {
			const owner = SessionManager.create(cwd);
			this.persistSession(owner, name);
			assert.ok(owner.getSessionFile());
			return owner;
		}

		private persistSession(
			manager: SessionManagerInstance,
			name: string,
		): void {
			manager.appendMessage({
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			manager.appendSessionInfo(name);
		}

		private async withManager<T>(
			manager: SessionManagerInstance,
			operation: () => Promise<T> | T | undefined,
		): Promise<T | undefined> {
			const previous = this.manager;
			this.manager = manager;
			try {
				return await operation();
			} finally {
				this.manager = previous;
			}
		}

		private capturePrompt(text: string): void {
			assert.ok(this.manager);
			this.prompts.push({
				text,
				cwd: this.manager.getCwd(),
				session: this.manager.getSessionFile(),
				name: this.manager.getSessionName(),
			});
		}

		private context(
			manager: SessionManagerInstance,
			mode: "rpc" | "tui" = "rpc",
		): MockContext {
			const ui: MockUI = {
				editor: async (question) => {
					this.editors.push(question);
					return this.editorAnswers.shift();
				},
				confirm: async (title, body) => {
					this.confirmations.push({ title, body });
					const before = this.beforeNextConfirm;
					this.beforeNextConfirm = undefined;
					await before?.();
					return this.confirmAnswers.shift() ?? false;
				},
				select: async (question, options) => {
					this.selections.push({ question, options });
					const before = this.beforeNextSelect;
					this.beforeNextSelect = undefined;
					await before?.();
					return this.selectAnswers.shift();
				},
				input: async () => this.inputAnswers.shift(),
				custom: async <T>() => this.customAnswers.shift() as T | undefined,
				notify: (message, level) => {
					this.notices.push({ message, level, cwd: manager.getCwd() });
				},
				setWidget: (_key, value) => {
					this.widgets.push(value);
				},
				getEditorText: () => "",
				setEditorText: (text) => {
					this.editorTexts.push(text);
				},
			};
			const context: MockContext = {
				cwd: manager.getCwd(),
				mode,
				hasUI: true,
				sessionManager: manager,
				modelRegistry: {
					find: (provider, id) =>
						this.availableModel?.provider === provider &&
						this.availableModel.id === id
							? this.availableModel
							: undefined,
				},
				model: this.selectedModel,
				thinkingLevel: this.thinkingLevel,
				signal: undefined,
				ui,
				isIdle: () => true,
				isProjectTrusted: () => true,
				abort: () => undefined,
				hasPendingMessages: () => false,
				shutdown: () => undefined,
				getContextUsage: () => undefined,
				compact: () => undefined,
				getSystemPrompt: () => "",
				getSystemPromptOptions: () => ({}),
				waitForIdle: async () => undefined,
				newSession: async (options = {}) => {
					const replacement = SessionManager.create(
						manager.getCwd(),
						undefined,
						{
							parentSession: options.parentSession,
						},
					);
					await options.setup?.(replacement);
					await this.withManager(replacement, () =>
						options.withSession?.(this.context(replacement)),
					);
					return { cancelled: false };
				},
				switchSession: async (path, options = {}) => {
					this.switches.push(path);
					if (this.cancelNextSwitch) {
						this.cancelNextSwitch = false;
						return { cancelled: true };
					}
					const replacement = SessionManager.open(path);
					assert.equal(replacement.getCwd(), replacement.getHeader()?.cwd);
					await this.withManager(replacement, () =>
						options.withSession?.(this.context(replacement)),
					);
					return { cancelled: false };
				},
				sendUserMessage: async (text) => this.capturePrompt(text),
			};
			return context;
		}
	}

	async function preparePlainTask(
		slug: string,
		phase: "design" | "outline",
		design: string,
		questions: unknown[] = [],
	): Promise<string> {
		const repository = await initRepository(slug);
		const worktree = join(worktrees, slug);
		mkdirSync(worktrees, { recursive: true });
		await git(
			repository.root,
			"worktree",
			"add",
			"-b",
			slug,
			worktree,
			repository.head,
		);
		persistTask(
			slug,
			state(
				repository.common,
				repository.head,
				phase,
				phase === "outline"
					? { submitted: false, session: "/unowned-outline-session" }
					: {},
			),
		);
		writeFileSync(
			join(tasks, slug, "03-design.md"),
			design.startsWith("---\n")
				? design
				: `---\nrepo: ${worktree}\nbranch: ${slug}\nsha: ${repository.head}\n---\n\n${design}`,
		);
		if (questions.length) persistQuestions(slug, questions);
		return worktree;
	}

	async function prepareStructuredTask(
		slug: string,
		phase: string,
		extra: Record<string, unknown>,
		store = outlineStore(),
	): Promise<{
		repository: Awaited<ReturnType<typeof initRepository>>;
		worktree: string;
	}> {
		const repository = await initRepository(slug);
		const worktree = join(worktrees, slug);
		mkdirSync(worktrees, { recursive: true });
		await git(
			repository.root,
			"worktree",
			"add",
			"-b",
			slug,
			worktree,
			repository.head,
		);
		persistTask(
			slug,
			state(repository.common, repository.head, phase, extra),
			store,
		);
		writeFileSync(
			join(tasks, slug, "03-design.md"),
			`---\nrepo: ${worktree}\nbranch: ${slug}\nsha: ${repository.head}\n---\n\n${emptyDesign}`,
		);
		return { repository, worktree };
	}

	async function prepareCommitRecovery(
		slug: string,
		options: { legacy?: boolean; completed?: boolean } = {},
	): Promise<{
		repository: Awaited<ReturnType<typeof initRepository>>;
		worktree: string;
		owner: SessionManagerInstance;
		ownerPath: string;
		tree: string;
	}> {
		const phase = pendingPhase();
		const storedPhase = options.completed
			? { ...phase, status: "completed" as const }
			: phase;
		const { repository, worktree } = await prepareStructuredTask(
			slug,
			"committing",
			{},
			outlineStore([storedPhase]),
		);
		const owner = harness.createOwner(worktree, `${slug} · build`);
		const ownerPath = owner.getSessionFile();
		assert.ok(ownerPath);
		writeFileSync(join(worktree, "tracked.txt"), "approved tracked\n");
		await git(worktree, "add", "tracked.txt");
		const tree = await git(worktree, "write-tree");
		persistTask(
			slug,
			state(repository.common, repository.head, "committing", {
				phaseSnapshot: phase,
				session: ownerPath,
				parent: repository.head,
				...(options.legacy ? {} : { tree }),
			}),
			outlineStore([storedPhase]),
		);
		return { repository, worktree, owner, ownerPath, tree };
	}

	const harness = new Harness();
	assert.deepEqual(harness.tools, [
		"rpi_set_outline",
		"rpi_update_design_questions",
	]);

	try {
		for (const slug of ["foo.", "foo..bar", "foo.lock"]) {
			const root = join(scratch, `invalid-${slug.replaceAll(".", "-")}`);
			mkdirSync(root);
			const noticeCount = harness.notices.length;
			await harness.invoke(slug, root, {
				description: "This must never be persisted.",
				confirm: true,
			});
			assert.equal(existsSync(join(root, ".git")), false);
			assert.equal(existsSync(join(tasks, slug)), false);
			assert.equal(existsSync(join(worktrees, slug)), false);
			assert.ok(
				harness.notices
					.slice(noticeCount)
					.some(
						(notice) => notice.message === `${slug}: invalid Git branch name`,
					),
			);
		}

		{
			const slug = "absent-baseline";
			const root = join(scratch, slug);
			mkdirSync(root);
			writeFileSync(join(root, ".gitignore"), "ignored.log\n");
			writeFileSync(join(root, "kept.txt"), "baseline\n");
			writeFileSync(join(root, "ignored.log"), "secret\n");
			await harness.invoke(slug, root, {
				description: "Initialize a baseline and ask questions.",
				confirm: true,
			});

			const worktree = join(worktrees, slug);
			const initialHead = await git(root, "rev-parse", "HEAD");
			assert.equal(
				await git(root, "log", "-1", "--format=%s"),
				"Initialize repository",
			);
			assert.deepEqual(
				(await git(root, "ls-tree", "-r", "--name-only", initialHead)).split(
					"\n",
				),
				[".gitignore", "kept.txt"],
			);
			assert.equal(
				await git(root, "status", "--porcelain", "--ignored"),
				"!! ignored.log",
			);
			assert.equal(await git(worktree, "branch", "--show-current"), slug);
			assert.equal(realpathSync(worktree), worktree);
			assert.deepEqual(
				loadState(slug),
				state(realpathSync(join(root, ".git")), initialHead, "questions"),
			);
			assert.deepEqual(harness.confirmations.at(-1), {
				title: "Initialize Git and commit the local baseline?",
				body: `Run git init in ${root}, git add -A, and create the root commit "Initialize repository". Every current non-ignored file will be committed. Nothing will be pushed.`,
			});
			const prompt = harness.prompts.at(-1);
			assert.equal(
				prompt?.cwd,
				worktree,
				JSON.stringify(harness.notices, null, 2),
			);
			assert.ok(
				prompt?.session,
				"questions must use a fresh persisted session path",
			);
			assert.equal(prompt.name, `${slug} · questions`);
			assert.match(prompt?.text ?? "", /Write a query plan/);
			assert.match(prompt?.text ?? "", /Task slug: `absent-baseline`/);
			assert.ok(
				harness.notices.some((notice) =>
					notice.message.includes("gpt-5.6-luna not available"),
				),
				"named RPC creation must fall back when the title model is absent",
			);
		}

		{
			const slug = "dirty-existing";
			const repository = await initRepository(slug);
			writeFileSync(
				join(repository.root, "tracked.txt"),
				"outside tracked edit\n",
			);
			writeFileSync(
				join(repository.root, "outside.txt"),
				"outside untracked edit\n",
			);
			await harness.invoke(slug, repository.root, {
				description: "Use committed HEAD only.",
			});

			const worktree = join(worktrees, slug);
			assert.equal(
				readFileSync(join(repository.root, "tracked.txt"), "utf8"),
				"outside tracked edit\n",
			);
			assert.equal(
				readFileSync(join(repository.root, "outside.txt"), "utf8"),
				"outside untracked edit\n",
			);
			assert.equal(
				readFileSync(join(worktree, "tracked.txt"), "utf8"),
				"committed\n",
			);
			assert.equal(existsSync(join(worktree, "outside.txt")), false);
			assert.equal(await git(worktree, "status", "--porcelain"), "");
			assert.equal("baseSha" in loadState(slug), false);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.message ===
						"existing checkout changes are excluded; the RPI worktree starts from committed HEAD",
				),
			);
		}

		{
			const slug = "detached-head";
			const repository = await initRepository(slug);
			await git(repository.root, "checkout", "--detach", repository.head);
			await harness.invoke(slug, repository.root, {
				description: "Must reject detached HEAD.",
			});
			assert.equal(existsSync(join(tasks, slug)), false);
			assert.equal(existsSync(join(worktrees, slug)), false);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.message ===
						"RPI requires a named base branch; detached HEAD is unsupported",
				),
			);
		}

		{
			const slug = "recover-creating";
			const repository = await initRepository(slug);
			await git(repository.root, "branch", slug, repository.head);
			persistTask(slug, state(repository.root, repository.head, "creating"));
			const unflushedSource = SessionManager.create(repository.root);
			assert.ok(unflushedSource.getSessionFile());
			assert.equal(existsSync(unflushedSource.getSessionFile() ?? ""), false);
			await harness.invokeInSession(slug, unflushedSource);
			assert.equal(
				await git(join(worktrees, slug), "rev-parse", "HEAD"),
				repository.head,
			);
			assert.equal(
				await git(join(worktrees, slug), "branch", "--show-current"),
				slug,
			);
			assert.equal(loadState(slug).phase, "questions");
			assert.equal(harness.prompts.at(-1)?.name, `${slug} · questions`);
		}

		{
			const slug = "creating-is-not-questions-input";
			const repository = await initRepository(slug);
			persistTask(slug, state(repository.root, repository.head, "creating"));
			const questionsSession = harness.createOwner(
				repository.root,
				`${slug} · questions`,
			);

			assert.deepEqual(await harness.input(questionsSession), {
				action: "handled",
			});
			assert.match(
				harness.notices.at(-1)?.message ?? "",
				/creating, not this questions session/,
			);
			assert.match(harness.notices.at(-1)?.message ?? "", /\/clone/);
			assert.match(
				harness.notices.at(-1)?.message ?? "",
				new RegExp(`/rpi ${slug}`),
			);
			assert.equal(loadState(slug).phase, "creating");
		}

		{
			const slug = "recover-existing-branch";
			const repository = await initRepository(slug);
			writeFileSync(join(repository.root, "later.txt"), "later\n");
			await git(repository.root, "add", "later.txt");
			await git(repository.root, "commit", "-m", "Later");
			const branchHead = await git(repository.root, "rev-parse", "HEAD");
			await git(repository.root, "branch", slug, branchHead);
			persistTask(slug, state(repository.root, repository.head, "creating"));
			await harness.invoke(slug, repository.root);
			assert.equal(loadState(slug).phase, "questions");
			assert.equal(
				await git(join(worktrees, slug), "rev-parse", "HEAD"),
				branchHead,
			);
		}

		{
			const slug = "cancel-plain-target";
			await preparePlainTask(slug, "design", emptyDesign);
			const source = SessionManager.create(scratch);
			const promptCount = harness.prompts.length;
			harness.cancelNextSwitch = true;
			await harness.invokeInSession(slug, source);
			const target = harness.switches.at(-1);
			assert.ok(target);
			assert.equal(existsSync(target), false);
			assert.equal(loadState(slug).phase, "design");
			assert.equal(harness.prompts.length, promptCount);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.message === "session switch cancelled — design unchanged",
				),
			);
		}

		{
			const slug = "inherit-session-settings";
			mkdirSync(join(tasks, slug), { recursive: true });
			const source = harness.createOwner(scratch, "source session");
			source.appendModelChange("source-provider", "source-model");
			source.appendThinkingLevelChange("high");
			const target = harness.createOwner(scratch, `${slug} · research`);
			harness.configureModel(
				{ provider: "source-provider", id: "source-model" },
				{ provider: "fallback-provider", id: "fallback-model" },
				"medium",
			);
			await harness.startSession(target, {
				previousSessionFile: source.getSessionFile(),
			});
			assert.deepEqual(harness.sessionSettings(), {
				model: { provider: "source-provider", id: "source-model" },
				thinkingLevel: "high",
			});
			harness.resetModel();
		}

		{
			const slug = "clone-detaches-rpi";
			const { worktree, owner, ownerPath } = await prepareCommitRecovery(slug);
			await harness.startSession(owner);
			const clone = SessionManager.forkFrom(ownerPath, worktree);
			assert.equal(clone.getSessionName(), `${slug} · build`);
			const editorCount = harness.editorTexts.length;

			await harness.startSession(clone, { reason: "fork" });

			assert.equal(clone.getSessionName(), undefined);
			assert.equal(owner.getSessionName(), `${slug} · build`);
			assert.equal(loadState(slug).session, ownerPath);
			assert.equal(harness.widgets.at(-1), undefined);
			assert.match(
				harness.notices.at(-1)?.message ?? "",
				/conversation detached from RPI in the same worktree/,
			);
			assert.match(
				harness.notices.at(-1)?.message ?? "",
				new RegExp(`/rpi ${slug}`),
			);
			await harness.settle(clone);
			assert.equal(harness.editorTexts.length, editorCount);

			const ordinary = harness.createOwner(worktree, "ordinary named fork");
			await harness.startSession(ordinary, { reason: "fork" });
			assert.equal(ordinary.getSessionName(), "ordinary named fork");
		}

		{
			const slug = "question-tool-flow";
			const worktree = await preparePlainTask(slug, "design", emptyDesign);
			const owner = harness.createOwner(worktree, `${slug} · design`);
			await harness.startSession(owner);
			await harness.updateQuestions(owner, {
				task_slug: slug,
				incorporated_question_ids: [],
				questions: [cacheInput, evictionInput],
			});
			assert.deepEqual(
				loadQuestions(slug).questions.map(({ id, status }) => ({ id, status })),
				[
					{ id: "Q1", status: "open" },
					{ id: "Q2", status: "open" },
				],
			);
			assert.match(JSON.stringify(harness.widgets.at(-1)), /2 unanswered/);
			await harness.invokeInSession(slug, owner, [
				"A — The adapter",
				"A — During writes",
			]);
			const followUp = {
				...cacheInput,
				title: "Refresh ownership",
				question: "Which layer should request refreshes?",
			};
			const mutation = {
				task_slug: slug,
				incorporated_question_ids: ["Q1", "Q2"],
				questions: [followUp],
			};
			await harness.updateQuestions(owner, mutation);
			await harness.updateQuestions(owner, mutation);
			assert.deepEqual(
				loadQuestions(slug).questions.map(({ id, status }) => ({ id, status })),
				[
					{ id: "Q1", status: "incorporated" },
					{ id: "Q2", status: "incorporated" },
					{ id: "Q3", status: "open" },
				],
			);
			assert.match(JSON.stringify(harness.widgets.at(-1)), /1 unanswered/);
		}

		{
			const slug = "design-question-flow";
			const worktree = await preparePlainTask(slug, "design", emptyDesign, [
				cacheQuestion,
				evictionQuestion,
			]);
			const owner = harness.createOwner(worktree, `${slug} · design`);
			const promptCount = harness.prompts.length;
			const selectionCount = harness.selections.length;

			await harness.invokeInSession(
				slug,
				owner,
				["A — The adapter", "Type an answer…"],
				undefined,
				"After each write",
			);
			assert.equal(loadState(slug).phase, "design");
			assert.equal(harness.prompts.length, promptCount + 1);
			assert.match(
				harness.prompts.at(-1)?.text ?? "",
				/Q1 · Cache ownership → Option A: The adapter/,
			);
			assert.match(
				harness.prompts.at(-1)?.text ?? "",
				/Q2 · Eviction timing → After each write/,
			);
			assert.deepEqual(harness.selections.at(-2), {
				question: [
					"Cache ownership",
					"",
					"Which layer should own the cache?",
					"",
					"Recommendation: A — The adapter already owns the remote lifecycle.",
				].join("\n"),
				options: ["A — The adapter", "B — The caller", "Type an answer…"],
			});
			assert.match(
				JSON.stringify(harness.widgets.at(-1)),
				/2 awaiting incorporation/,
			);
			const stored = loadQuestions(slug).questions;
			assert.deepEqual(
				stored.map(({ id, status, answer }) => ({ id, status, answer })),
				[
					{
						id: "Q1",
						status: "answered",
						answer: { kind: "option", option: 1 },
					},
					{
						id: "Q2",
						status: "answered",
						answer: { kind: "free_text", text: "After each write" },
					},
				],
			);

			await harness.invokeInSession(slug, owner);
			assert.equal(harness.prompts.length, promptCount + 2);
			assert.equal(
				harness.selections.length,
				selectionCount + 2,
				"answered records must be resent before opening more dialogs",
			);
		}

		{
			const slug = "design-partial-cancel";
			const worktree = await preparePlainTask(slug, "design", emptyDesign, [
				cacheQuestion,
				evictionQuestion,
			]);
			const owner = harness.createOwner(worktree, `${slug} · design`);
			const promptCount = harness.prompts.length;
			await harness.invokeInSession(slug, owner, "A — The adapter");
			assert.equal(harness.prompts.length, promptCount + 1);
			assert.match(harness.prompts.at(-1)?.text ?? "", /Q1 · Cache ownership/);
			assert.doesNotMatch(
				harness.prompts.at(-1)?.text ?? "",
				/Q2 · Eviction timing/,
			);
			assert.deepEqual(
				loadQuestions(slug).questions.map(({ id, status }) => ({ id, status })),
				[
					{ id: "Q1", status: "answered" },
					{ id: "Q2", status: "open" },
				],
			);
		}

		{
			const slug = "design-continue";
			const worktree = await preparePlainTask(slug, "design", emptyDesign);
			const owner = harness.createOwner(worktree, `${slug} · design`);
			const promptCount = harness.prompts.length;

			await harness.invokeInSession(slug, owner);
			assert.equal(harness.prompts.length, promptCount);
			assert.equal(loadState(slug).phase, "design");
			assert.deepEqual(harness.selections.at(-1)?.options, [
				"Agree & continue to outline",
				"Continue designing",
			]);
			assert.match(
				JSON.stringify(harness.widgets.at(-1)),
				/awaiting agreement/,
			);

			await harness.invokeInSession(
				slug,
				owner,
				"Continue designing",
				"Remove the compatibility fallback.",
			);
			assert.equal(loadState(slug).phase, "design");
			assert.equal(harness.prompts.at(-1)?.session, owner.getSessionFile());
			assert.match(
				harness.prompts.at(-1)?.text ?? "",
				/Human feedback or decisions:\nRemove the compatibility fallback\./,
			);
			assert.equal(harness.editors.at(-1), "Optional design feedback");
		}

		{
			const slug = "stale-design-evidence";
			const worktree = await preparePlainTask(slug, "design", emptyDesign);
			const owner = harness.createOwner(worktree, `${slug} · design`);
			const path = join(tasks, slug, "03-design.md");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(/sha: [0-9a-f]{40}/, `sha: ${"b".repeat(40)}`),
			);
			const selections = harness.selections.length;
			const prompts = harness.prompts.length;
			await harness.invokeInSession(slug, owner);
			assert.equal(loadState(slug).phase, "design");
			assert.equal(harness.selections.length, selections);
			assert.equal(harness.prompts.length, prompts + 1);
			assert.match(harness.prompts.at(-1)?.text ?? "", /Design repository evidence is stale/);
		}

		{
			const slug = "symlinked-question-store";
			const worktree = await preparePlainTask(slug, "design", emptyDesign);
			const external = join(scratch, `${slug}.json`);
			writeFileSync(external, '{"version":1,"questions":[]}\n');
			symlinkSync(external, join(tasks, slug, "questions.json"));
			const owner = harness.createOwner(worktree, `${slug} · design`);
			const selectionCount = harness.selections.length;
			await harness.invokeInSession(slug, owner);
			assert.equal(harness.selections.length, selectionCount);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.level === "error" &&
						notice.message.includes(
							"questions.json is not a regular non-symlink file",
						),
				),
			);
		}

		{
			const slug = "malformed-question-store";
			const worktree = await preparePlainTask(slug, "design", emptyDesign);
			const path = join(tasks, slug, "questions.json");
			const malformed = '{"version":1,"questions":[';
			writeFileSync(path, malformed);
			const owner = harness.createOwner(worktree, `${slug} · design`);
			await harness.invokeInSession(slug, owner);
			assert.equal(readFileSync(path, "utf8"), malformed);
			await assert.rejects(
				harness.updateQuestions(owner, {
					task_slug: slug,
					incorporated_question_ids: [],
					questions: [cacheInput],
				}),
				/invalid questions JSON/,
			);
			assert.equal(readFileSync(path, "utf8"), malformed);
		}

		{
			const slug = "directory-question-store";
			const worktree = await preparePlainTask(slug, "design", emptyDesign);
			const path = join(tasks, slug, "questions.json");
			mkdirSync(path);
			writeFileSync(join(path, "sentinel"), "keep\n");
			const owner = harness.createOwner(worktree, `${slug} · design`);
			await harness.invokeInSession(slug, owner);
			assert.equal(readFileSync(join(path, "sentinel"), "utf8"), "keep\n");
			await assert.rejects(
				harness.updateQuestions(owner, {
					task_slug: slug,
					incorporated_question_ids: [],
					questions: [cacheInput],
				}),
				/not a regular non-symlink file/,
			);
			assert.equal(readFileSync(join(path, "sentinel"), "utf8"), "keep\n");
		}

		{
			const slug = "design-agreement-fresh-outline";
			const worktree = await preparePlainTask(slug, "design", emptyDesign);
			const staleOutline = harness.createOwner(worktree, `${slug} · outline`);
			const staleOutlinePath = staleOutline.getSessionFile();
			assert.ok(staleOutlinePath);
			const designOwner = harness.createOwner(worktree, `${slug} · design`);
			const switchCount = harness.switches.length;

			await harness.invokeInSession(
				slug,
				designOwner,
				"Agree & continue to outline",
			);
			const outlinePrompt = harness.prompts.at(-1);
			assert.equal(loadState(slug).phase, "outline");
			assert.equal(outlinePrompt?.name, `${slug} · outline`);
			assert.notEqual(outlinePrompt?.session, staleOutlinePath);
			assert.match(
				outlinePrompt?.text ?? "",
				/call `rpi_set_outline` exactly once/,
			);
			assert.ok(
				outlinePrompt?.text.includes(worktree),
				"phase prompts must use the canonical worktree path",
			);
			assert.equal(
				outlinePrompt?.text.includes(configuredAgentDir),
				false,
				"phase prompts must not expose the configured agent-directory symlink",
			);
			assert.equal(
				harness.switches.slice(switchCount).includes(staleOutlinePath),
				false,
				"agreement must not resume an older same-name Outline session",
			);
		}

		{
			const slug = "outline-cannot-incorporate";
			const answered = {
				...cacheQuestion,
				status: "answered",
				answer: { kind: "option", option: 1 },
			};
			const worktree = await preparePlainTask(slug, "outline", emptyDesign, [
				answered,
			]);
			const owner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, owner);
			await harness.startSession(owner);
			await assert.rejects(
				harness.updateQuestions(owner, {
					task_slug: slug,
					incorporated_question_ids: ["Q1"],
					questions: [],
				}),
				/Outline may add questions but may not incorporate answers/,
			);
		}

		{
			const slug = "outline-question-backtrack";
			const worktree = await preparePlainTask(slug, "outline", emptyDesign);
			const designOwner = harness.createOwner(worktree, `${slug} · design`);
			const designPath = designOwner.getSessionFile();
			assert.ok(designPath);
			const outlineOwner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, outlineOwner);
			await harness.startSession(outlineOwner);
			await harness.setOutline(outlineOwner, outlineInput(slug));
			await harness.updateQuestions(outlineOwner, {
				task_slug: slug,
				incorporated_question_ids: [],
				questions: [cacheInput],
			});
			assert.equal(existsSync(join(tasks, slug, "outline-candidate.json")), true);
			assert.match(
				readFileSync(join(tasks, slug, "04-structure-outline.md"), "utf8"),
				/Awaiting approval/,
			);
			const promptCount = harness.prompts.length;
			const selectionCount = harness.selections.length;

			await harness.invokeInSession(slug, outlineOwner);
			assert.equal(loadState(slug).phase, "design");
			assert.equal(harness.switches.at(-1), designPath);
			assert.equal(existsSync(join(tasks, slug, "outline-candidate.json")), false);
			assert.doesNotMatch(
				readFileSync(join(tasks, slug, "04-structure-outline.md"), "utf8"),
				/Awaiting approval/,
			);
			assert.equal(harness.prompts.length, promptCount);
			assert.equal(
				harness.selections.length,
				selectionCount,
				"Outline must return to Design without answering the question",
			);
		}

		{
			const slug = "outline-submit-gate";
			const worktree = await preparePlainTask(slug, "outline", emptyDesign);
			const owner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, owner);
			await harness.startSession(owner);
			await harness.invokeInSession(slug, owner);
			assert.equal(loadState(slug).submitted, false);
			assert.ok(
				harness.notices.some((notice) =>
					notice.message.includes("outline work is not submitted"),
				),
			);
			const imposter = harness.createOwner(worktree, `${slug} · outline`);
			await assert.rejects(
				harness.setOutline(imposter, outlineInput(slug)),
				/does not own the Outline phase/,
			);
			await harness.setOutline(owner, outlineInput(slug));
			const first = loadCandidate(slug);
			assert.equal(loadState(slug).submitted, true);
			assert.deepEqual(Object.keys(first).sort(), [
				"overview",
				"pending",
				"removed_pending_ids",
			]);
			assert.equal("task_slug" in first, false);
			assert.equal(
				existsSync(join(tasks, slug, "outline.json")),
				false,
				"submission must not create the approved outline",
			);
			await harness.setOutline(owner, outlineInput(slug));
			assert.deepEqual(loadCandidate(slug), first);
			await harness.invokeInSession(slug, owner, "Approve plan & start Build");
			assert.equal(loadState(slug).phase, "build");
			assert.match(
				readFileSync(join(tasks, slug, "04-structure-outline.md"), "utf8"),
				/Phase 1 \(P1\): Implement the focused change/,
			);
			assert.equal(
				(
					(loadState(slug).build as Record<string, unknown>)
						.phaseSnapshot as PendingPhase
				).id,
				"P1",
			);
			assert.match(harness.prompts.at(-1)?.text ?? "", /"id": "P1"/);
		}

		{
			const slug = "empty-outline-to-pr";
			const worktree = await preparePlainTask(slug, "outline", emptyDesign);
			const owner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, owner);
			await harness.startSession(owner);
			await harness.setOutline(owner, outlineInput(slug, []));
			await harness.invokeInSession(
				slug,
				owner,
				"Approve plan & continue to PR",
			);
			assert.equal(loadState(slug).phase, "pr");
			const prPrompt = harness.prompts.at(-1)?.text ?? "";
			assert.match(prPrompt, /Audit the transient range/);
			// The audit prompt is inlined with its scope bound, never left for the agent to read
			// and then discount an unexpanded slash-command placeholder.
			assert.match(prPrompt, /Review this scope: `git diff [0-9a-f]{40}\.\.[0-9a-f]{40}`/);
			assert.equal(prPrompt.includes("${@"), false);
		}

		{
			const slug = "outline-continue-keeps-approved";
			const worktree = await preparePlainTask(slug, "outline", emptyDesign);
			const owner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, owner);
			await harness.startSession(owner);
			await harness.setOutline(owner, outlineInput(slug));
			await harness.invokeInSession(
				slug,
				owner,
				"Continue outlining",
				"Keep only work that remains after settled phases.",
			);
			assert.equal(loadState(slug).submitted, false);
			assert.equal(existsSync(join(tasks, slug, "outline-candidate.json")), false);
			assert.equal(existsSync(join(tasks, slug, "outline.json")), false);
			assert.doesNotMatch(
				readFileSync(join(tasks, slug, "04-structure-outline.md"), "utf8"),
				/Awaiting approval/,
			);
		}

		{
			const slug = "outline-revisit-restores-approved";
			const worktree = await preparePlainTask(slug, "outline", emptyDesign);
			const designOwner = harness.createOwner(worktree, `${slug} · design`);
			const outlineOwner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, outlineOwner);
			await harness.startSession(outlineOwner);
			await harness.setOutline(outlineOwner, outlineInput(slug));
			await harness.invokeInSession(
				slug,
				outlineOwner,
				"Revisit design",
				"The behavior needs another decision.",
			);
			assert.equal(loadState(slug).phase, "design");
			assert.equal(harness.switches.at(-1), designOwner.getSessionFile());
			assert.equal(existsSync(join(tasks, slug, "outline-candidate.json")), false);
			assert.doesNotMatch(
				readFileSync(join(tasks, slug, "04-structure-outline.md"), "utf8"),
				/Awaiting approval/,
			);
		}

		{
			const slug = "outline-design-race";
			const worktree = await preparePlainTask(slug, "outline", emptyDesign);
			const owner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, owner);
			await harness.startSession(owner);
			await harness.setOutline(owner, outlineInput(slug));
			harness.beforeNextSelect = () => {
				writeFileSync(
					join(tasks, slug, "outline-candidate.json"),
					`${JSON.stringify({ ...loadCandidate(slug), pending: [] }, null, 2)}\n`,
				);
			};
			await harness.invokeInSession(slug, owner, "Approve plan & start Build");
			assert.equal(loadState(slug).phase, "outline");
			assert.ok(harness.notices.at(-1)?.message.includes("changed during review"));
		}

		{
			const slug = "direct-replan-no-op";
			const { worktree } = await prepareStructuredTask(
				slug,
				"build",
				{ build: { phaseSnapshot: pendingPhase(), status: "pending" } },
			);
			const buildOwner = harness.createOwner(worktree, `${slug} · build`);
			const buildPath = buildOwner.getSessionFile();
			assert.ok(buildPath);
			writeFileSync(
				join(tasks, slug, "state.json"),
				`${JSON.stringify(
					state("unused", "", "build", {
						build: {
							phaseSnapshot: pendingPhase(),
							status: "active",
							session: buildPath,
						},
					}),
					null,
					2,
				)}\n`,
			);
			await harness.startSession(buildOwner);
			await harness.invokeInSession(slug, buildOwner, "Replan pending work");
			assert.equal(loadState(slug).phase, "outline");
			assert.equal(loadState(slug).basis, "approved-outline");
			const outlineOwner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, outlineOwner);
			await harness.startSession(outlineOwner);
			const selectionCount = harness.selections.length;
			await harness.setOutline(outlineOwner, {
				...outlineInput(slug, []),
				overview: { kind: "keep" },
				pending: [{ kind: "keep", id: "P1" }],
			});
			await harness.invokeInSession(slug, outlineOwner);
			assert.equal(loadState(slug).phase, "build");
			assert.equal(
				harness.selections.length,
				selectionCount,
				"an exact planning-only no-op needs no approval input",
			);
		}

		{
			const slug = "pr-replan-invalidates-description";
			const completed = {
				...pendingPhase("P1"),
				status: "completed" as const,
				resolution: null,
			};
			const { worktree } = await prepareStructuredTask(
				slug,
				"pr",
				{ pr: { status: "pending" } },
				outlineStore([completed], 2),
			);
			const prOwner = harness.createOwner(worktree, `${slug} · pr`);
			const prPath = prOwner.getSessionFile();
			assert.ok(prPath);
			writeFileSync(
				join(tasks, slug, "state.json"),
				`${JSON.stringify(state("unused", "", "pr", { pr: { status: "active", session: prPath } }), null, 2)}\n`,
			);
			writeFileSync(join(tasks, slug, "pr-description.md"), "Stale PR\n");
			await harness.startSession(prOwner);
			await harness.invokeInSession(
				slug,
				prOwner,
				"Revise remaining work — return to Outline",
			);
			assert.deepEqual(harness.selections.at(-1), {
				question: `${slug} · PR phase — choose next step`,
				options: [
					"Done — finish the task",
					"Revise remaining work — return to Outline",
					"Fix a review finding — add a repair phase",
					"Rethink the solution — return to Design",
				],
			});
			const outlineOwner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, outlineOwner);
			await harness.startSession(outlineOwner);
			await harness.setOutline(outlineOwner, outlineInput(slug, []));
			await harness.invokeInSession(
				slug,
				outlineOwner,
				"Approve plan & continue to PR",
			);
			assert.equal(loadState(slug).phase, "pr");
			assert.equal(existsSync(join(tasks, slug, "pr-description.md")), false);
			assert.doesNotMatch(
				readFileSync(join(tasks, slug, "04-structure-outline.md"), "utf8"),
				/Awaiting approval/,
			);
		}

		{
			const slug = "dirty-build-replan";
			const { worktree } = await prepareStructuredTask(
				slug,
				"build",
				{ build: { phaseSnapshot: pendingPhase(), status: "pending" } },
			);
			const owner = harness.createOwner(worktree, `${slug} · build`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			writeFileSync(
				join(tasks, slug, "state.json"),
				`${JSON.stringify(
					state("unused", "", "build", {
						build: {
							phaseSnapshot: pendingPhase(),
							status: "active",
							session: ownerPath,
						},
					}),
					null,
					2,
				)}\n`,
			);
			writeFileSync(join(worktree, "tracked.txt"), "dirty\n");
			await harness.invokeInSession(slug, owner, "Replan pending work");
			assert.equal(loadState(slug).phase, "build");
			assert.ok(
				harness.notices.some((notice) =>
					notice.message.includes("replanning requires a clean worktree"),
				),
			);
		}

		for (const kind of ["malformed", "directory", "symlink"] as const) {
			const slug = `${kind}-outline-json`;
			const { repository } = await prepareStructuredTask(slug, "build", {
				build: { phaseSnapshot: pendingPhase(), status: "pending" },
			});
			const path = join(tasks, slug, "outline.json");
			rmSync(path);
			if (kind === "malformed") writeFileSync(path, '{"version":1');
			else if (kind === "directory") mkdirSync(path);
			else {
				const external = join(scratch, `${slug}.json`);
				writeFileSync(external, serializeOutlineStore(outlineStore()));
				symlinkSync(external, path);
			}
			const promptCount = harness.prompts.length;
			await harness.invoke(slug, repository.root);
			assert.equal(harness.prompts.length, promptCount);
			assert.ok(harness.notices.at(-1)?.level === "error");
		}

		{
			const slug = "three-completed-repair";
			const completed = [1, 2, 3].map((number) => ({
				...pendingPhase(`P${number}`),
				status: "completed" as const,
				resolution: null,
			}));
			const { worktree } = await prepareStructuredTask(
				slug,
				"pr",
				{ pr: { status: "pending" } },
				outlineStore(completed, 4),
			);
			const prOwner = harness.createOwner(worktree, `${slug} · pr`);
			const prPath = prOwner.getSessionFile();
			assert.ok(prPath);
			writeFileSync(
				join(tasks, slug, "state.json"),
				`${JSON.stringify(state("unused", "", "pr", { pr: { status: "active", session: prPath } }), null, 2)}\n`,
			);
			await harness.startSession(prOwner);
			await harness.invokeInSession(
				slug,
				prOwner,
				"Fix a review finding — add a repair phase",
				"Repair retry behavior.",
			);
			const designOwner = harness.createOwner(worktree, `${slug} · design`);
			await harness.startSession(designOwner);
			await harness.invokeInSession(
				slug,
				designOwner,
				"Agree & continue to outline",
			);
			const outlineOwner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, outlineOwner);
			await harness.startSession(outlineOwner);
			await harness.setOutline(outlineOwner, outlineInput(slug));
			assert.equal(loadOutline(slug).phases.length, 3);
			assert.deepEqual(loadCandidate(slug).pending.map(({ kind }) => kind), ["add"]);
			await harness.invokeInSession(slug, outlineOwner, "Approve changed plan");
			assert.equal(
				(
					(loadState(slug).build as Record<string, unknown>)
						.phaseSnapshot as PendingPhase
				).id,
				"P4",
			);
		}

		{
			const slug = "mid-build-replan";
			const completed = {
				...pendingPhase("P1"),
				status: "completed" as const,
				resolution: null,
			};
			const oldPending = pendingPhase("P2", {
				...phaseInput,
				title: "Old pending work",
			});
			const { worktree } = await prepareStructuredTask(
				slug,
				"build",
				{ build: { phaseSnapshot: oldPending, status: "pending" } },
				outlineStore([completed, oldPending], 3),
			);
			const buildOwner = harness.createOwner(worktree, `${slug} · build`);
			const buildPath = buildOwner.getSessionFile();
			assert.ok(buildPath);
			writeFileSync(
				join(tasks, slug, "state.json"),
				`${JSON.stringify(
					state("unused", "", "build", {
						build: {
							phaseSnapshot: oldPending,
							status: "active",
							session: buildPath,
						},
					}),
					null,
					2,
				)}\n`,
			);
			await harness.startSession(buildOwner);
			await harness.invokeInSession(
				slug,
				buildOwner,
				"Revisit design",
				"Replace pending work.",
			);
			const designOwner = harness.createOwner(worktree, `${slug} · design`);
			await harness.startSession(designOwner);
			await harness.invokeInSession(
				slug,
				designOwner,
				"Agree & continue to outline",
			);
			const outlineOwner = harness.createOwner(worktree, `${slug} · outline`);
			setOutlineOwner(slug, outlineOwner);
			await harness.startSession(outlineOwner);
			await harness.setOutline(outlineOwner, {
				...outlineInput(slug),
				removed_pending_ids: ["P2"],
			});
			assert.deepEqual(
				loadOutline(slug).phases.map(({ id, status }) => ({ id, status })),
				[
					{ id: "P1", status: "completed" },
					{ id: "P2", status: "pending" },
				],
				"approved outline remains unchanged before review",
			);
			await harness.invokeInSession(slug, outlineOwner, "Approve changed plan");
			assert.deepEqual(
				loadOutline(slug).phases.map(({ id, status }) => ({ id, status })),
				[
					{ id: "P1", status: "completed" },
					{ id: "P3", status: "pending" },
				],
			);
		}

		{
			const slug = "pr-repair-through-design";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			const prOwner = harness.createOwner(worktree, `${slug} · pr`);
			const prPath = prOwner.getSessionFile();
			assert.ok(prPath);
			persistTask(
				slug,
				state(repository.common, repository.head, "pr", {
					pr: { status: "active", session: prPath },
				}),
			);
			writeFileSync(join(tasks, slug, "03-design.md"), emptyDesign);
			writeFileSync(join(tasks, slug, "pr-description.md"), "Existing PR\n");

			await harness.invokeInSession(
				slug,
				prOwner,
				"Fix a review finding — add a repair phase",
				"Repair the failed retry behavior.",
			);
			assert.equal(loadState(slug).phase, "design");
			assert.equal(harness.prompts.at(-1)?.name, `${slug} · design`);
			assert.match(
				harness.prompts.at(-1)?.text ?? "",
				/Repair the failed retry behavior\./,
			);
			assert.equal(existsSync(join(tasks, slug, "pr-description.md")), false);
		}

		{
			const slug = "symlinked-outline";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			mkdirSync(worktrees, { recursive: true });
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			persistTask(
				slug,
				state(repository.common, repository.head, "build", {
					build: { phaseSnapshot: pendingPhase(), status: "pending" },
				}),
			);
			const externalOutline = join(scratch, `${slug}-outline.json`);
			writeFileSync(externalOutline, serializeOutlineStore(outlineStore()));
			symlinkSync(externalOutline, join(tasks, slug, "outline.json"));
			const promptCount = harness.prompts.length;
			await harness.invoke(slug, repository.root);
			assert.equal(harness.prompts.length, promptCount);
			assert.equal(loadState(slug).phase, "build");
			assert.ok(
				harness.notices.some((notice) =>
					notice.message.includes("is not a regular non-symlink file"),
				),
			);
		}

		for (const changed of [true, false]) {
			const slug = `continue-build-${changed ? "changed" : "clean"}`;
			const { repository, worktree } = await prepareStructuredTask(
				slug,
				"build",
				{ build: { phaseSnapshot: pendingPhase(), status: "pending" } },
			);
			const owner = harness.createOwner(worktree, `${slug} · build`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			const expectedState = state(repository.common, repository.head, "build", {
				build: {
					phaseSnapshot: pendingPhase(),
					status: "active",
					session: ownerPath,
				},
			});
			persistTask(slug, expectedState, outlineStore());
			if (changed)
				writeFileSync(join(worktree, "tracked.txt"), "work in progress\n");
			const promptCount = harness.prompts.length;

			await harness.invokeInSession(slug, owner, "Continue working");

			assert.deepEqual(harness.selections.at(-1), {
				question: `Phase 1 · ${changed ? "1 changed path" : "no changes"} · review with git diff`,
				options: changed
					? [
							"Continue working",
							"Approve & commit",
							"Replan pending work",
							"Revisit design",
						]
					: [
							"Continue working",
							"Close with no code",
							"Replan pending work",
							"Revisit design",
						],
			});
			assert.equal(harness.prompts.length, promptCount + 1);
			assert.equal(
				harness.prompts.at(-1)?.text,
				[
					"Continue the current RPI build phase in this initialized session. Do not start another phase.",
					`Authoritative structured build phase:\n${renderBuildPhase(pendingPhase())}`,
				].join("\n\n"),
			);
			assert.deepEqual(loadState(slug), expectedState);
			assert.equal(await git(worktree, "diff", "--cached", "--name-only"), "");
			assert.equal(await git(worktree, "rev-parse", "HEAD"), repository.head);
			assert.equal(
				await git(worktree, "status", "--porcelain"),
				changed ? "M tracked.txt" : "",
			);
		}

		{
			const slug = "cancel-build-target";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			persistTask(
				slug,
				state(repository.common, repository.head, "build", {
					build: { phaseSnapshot: pendingPhase(), status: "pending" },
				}),
				outlineStore(),
			);
			const source = SessionManager.create(repository.root);
			harness.cancelNextSwitch = true;
			await harness.invokeInSession(slug, source);
			const target = harness.switches.at(-1);
			assert.ok(target);
			assert.equal(existsSync(target), false);
			assert.deepEqual(
				loadState(slug),
				state(repository.common, repository.head, "build", {
					build: { phaseSnapshot: pendingPhase(), status: "pending" },
				}),
			);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.message === "session switch cancelled — build run unchanged",
				),
			);
		}

		{
			const slug = "staging-owner";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			mkdirSync(worktrees, { recursive: true });
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			const owner = harness.createOwner(worktree, `${slug} · build`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			writeFileSync(join(worktree, "tracked.txt"), "staged version\n");
			writeFileSync(join(worktree, "new.txt"), "new worktree file\n");
			await git(worktree, "add", "-A");
			writeFileSync(join(worktree, "tracked.txt"), "latest unstaged version\n");
			persistTask(
				slug,
				state(repository.common, repository.head, "staging", {
					phaseSnapshot: pendingPhase(),
					session: ownerPath,
					parent: repository.head,
					paths: ["new.txt", "tracked.txt"],
				}),
				outlineStore(),
			);
			await harness.startSession(owner);
			const stagingWidget = JSON.stringify(harness.widgets.at(-1));
			assert.match(stagingWidget, /● build · staging approved changes/);
			assert.doesNotMatch(
				stagingWidget,
				/[✓●○] (?:creating|closing|staging|committing|done|deleting)/,
			);
			const elsewhere = join(scratch, `${slug}-elsewhere`);
			mkdirSync(elsewhere);
			await harness.invoke(slug, elsewhere);

			assert.equal(harness.switches.at(-1), ownerPath);
			assert.equal(await git(worktree, "diff", "--cached", "--name-only"), "");
			assert.equal(
				readFileSync(join(worktree, "tracked.txt"), "utf8"),
				"latest unstaged version\n",
			);
			assert.equal(
				readFileSync(join(worktree, "new.txt"), "utf8"),
				"new worktree file\n",
			);
			assert.deepEqual(
				loadState(slug),
				state(repository.common, repository.head, "build", {
					build: {
						phaseSnapshot: pendingPhase(),
						status: "active",
						session: ownerPath,
					},
				}),
			);
		}

		{
			const slug = "closing-owner";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			const owner = harness.createOwner(worktree, `${slug} · build`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			const resolution = "The existing behavior already satisfies this phase.";
			persistTask(
				slug,
				state(repository.common, repository.head, "closing", {
					phaseSnapshot: pendingPhase(),
					session: ownerPath,
					resolution,
				}),
				outlineStore(),
			);
			const elsewhere = join(scratch, `${slug}-elsewhere`);
			mkdirSync(elsewhere);
			await harness.invoke(slug, elsewhere);

			assert.equal(harness.switches.at(-1), ownerPath);
			assert.deepEqual(
				loadState(slug),
				state(repository.common, repository.head, "pr", {
					pr: { status: "pending" },
				}),
			);
			assert.equal(await git(worktree, "status", "--porcelain"), "");
			assert.deepEqual(loadOutline(slug).phases[0], {
				...pendingPhase(),
				status: "completed",
				resolution,
			});
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.cwd === worktree &&
						notice.message === "no-code phase closure recovered",
				),
			);
		}

		{
			const slug = "committing-owner";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			const owner = harness.createOwner(worktree, `${slug} · build`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			writeFileSync(join(worktree, "tracked.txt"), "completed child\n");
			await git(worktree, "add", "tracked.txt");
			const approvedTree = await git(worktree, "write-tree");
			await git(worktree, "commit", "-m", "Complete phase");
			persistTask(
				slug,
				state(repository.common, repository.head, "committing", {
					phaseSnapshot: pendingPhase(),
					session: ownerPath,
					parent: repository.head,
					tree: approvedTree,
				}),
				outlineStore(),
			);
			const elsewhere = join(scratch, `${slug}-elsewhere`);
			mkdirSync(elsewhere);
			await harness.invoke(slug, elsewhere);

			assert.equal(harness.switches.at(-1), ownerPath);
			assert.deepEqual(
				loadState(slug),
				state(repository.common, repository.head, "pr", {
					pr: { status: "pending" },
				}),
			);
			assert.deepEqual(loadOutline(slug).phases[0], {
				...pendingPhase(),
				status: "completed",
				resolution: null,
			});
			assert.match(
				readFileSync(join(tasks, slug, "04-structure-outline.md"), "utf8"),
				/^- \[x\] Phase 1 \(P1\): Implement the focused change$/m,
			);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.cwd === worktree &&
						notice.message === "commit verified; outline phase checked",
				),
			);
		}

		{
			const slug = "literal-approved-path";
			const repository = await initRepository(slug);
			const literalName = ":(literal)foo";
			writeFileSync(join(repository.root, literalName), "literal baseline\n");
			writeFileSync(join(repository.root, "foo"), "ordinary baseline\n");
			await git(
				repository.root,
				"--literal-pathspecs",
				"add",
				"--",
				literalName,
				"foo",
			);
			await git(repository.root, "commit", "-m", "Add pathspec fixtures");
			repository.head = await git(repository.root, "rev-parse", "HEAD");

			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			const owner = harness.createOwner(worktree, `${slug} · build`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			persistTask(
				slug,
				state(repository.common, repository.head, "build", {
					build: {
						phaseSnapshot: pendingPhase(),
						status: "active",
						session: ownerPath,
					},
				}),
				outlineStore(),
			);
			writeFileSync(join(worktree, literalName), "literal edited\n");

			await harness.invokeInSession(slug, owner, "Approve & commit");
			assert.deepEqual(
				(await git(worktree, "diff", "--cached", "--name-only", "-z"))
					.split("\0")
					.filter(Boolean),
				[literalName],
			);
			assert.equal(loadState(slug).phase, "committing");
			assert.equal(loadState(slug).tree, await git(worktree, "write-tree"));
			assert.match(
				harness.prompts.at(-1)?.text ?? "",
				/^Commit the staged index exactly as-is\. Do not modify the index or worktree\./,
			);

			await git(worktree, "commit", "-m", "Edit literal pathspec filename");
			assert.deepEqual(
				(
					await git(
						worktree,
						"diff-tree",
						"--no-commit-id",
						"--name-only",
						"-r",
						"-z",
						"HEAD",
					)
				)
					.split("\0")
					.filter(Boolean),
				[literalName],
			);
			await harness.invokeInSession(slug, owner);
			assert.equal(loadState(slug).phase, "pr");
			assert.equal(
				readFileSync(join(worktree, "foo"), "utf8"),
				"ordinary baseline\n",
			);
		}

		{
			const slug = "commit-wrong-tree-clean";
			const { repository, worktree, owner } = await prepareCommitRecovery(slug);
			await git(worktree, "reset", "--mixed", repository.head);
			writeFileSync(join(worktree, "tracked.txt"), "committed\n");
			await git(worktree, "commit", "--allow-empty", "-m", "Subset commit");
			const head = await git(worktree, "rev-parse", "HEAD");
			await harness.invokeInSession(slug, owner, "Leave unchanged");
			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Invalidate approval & return to Build", "Leave unchanged"],
			});
			assert.equal(await git(worktree, "status", "--porcelain"), "");
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(loadState(slug).phase, "committing");
		}

		{
			const slug = "commit-reset-preserves-present-files";
			const { repository, worktree, owner, ownerPath, tree } =
				await prepareCommitRecovery(slug);
			await git(worktree, "reset", "--mixed", repository.head);
			writeFileSync(join(worktree, "tracked.txt"), "wrong committed tree\n");
			await git(worktree, "add", "tracked.txt");
			await git(worktree, "commit", "-m", "Wrong commit");
			const dropped = await git(worktree, "rev-parse", "HEAD");
			writeFileSync(join(worktree, "tracked.txt"), "present tracked work\n");
			writeFileSync(join(worktree, "present-untracked.txt"), "present untracked\n");
			await harness.invokeInSession(
				slug,
				owner,
				"Invalidate approval & return to Build",
			);
			assert.equal(await git(worktree, "rev-parse", "HEAD"), repository.head);
			assert.equal(await git(worktree, "diff", "--cached", "--name-only"), "");
			assert.equal(
				readFileSync(join(worktree, "tracked.txt"), "utf8"),
				"present tracked work\n",
			);
			assert.equal(
				readFileSync(join(worktree, "present-untracked.txt"), "utf8"),
				"present untracked\n",
			);
			assert.deepEqual(loadState(slug), {
				version: 5,
				phase: "build",
				baseBranch: "main",
				build: {
					phaseSnapshot: pendingPhase(),
					status: "active",
					session: ownerPath,
				},
			});
			assert.match(harness.prompts.at(-1)?.text ?? "", /Approval was invalidated/);
			assert.match(
				harness.prompts.at(-1)?.text ?? "",
				new RegExp(`Dropped child ${dropped} with approved tree ${tree}`),
			);
		}

		for (const committed of [false, true]) {
			const slug = `commit-missing-approved-new-file-${committed ? "child" : "parent"}`;
			const { worktree, owner } = await prepareCommitRecovery(slug);
			const approved = join(worktree, "approved-new.txt");
			writeFileSync(approved, "approved new file\n");
			await git(worktree, "add", "approved-new.txt");
			const tree = await git(worktree, "write-tree");
			persistTask(slug, { ...loadState(slug), tree });
			if (committed)
				await git(worktree, "commit", "-m", "Commit approved files");
			rmSync(approved);
			const head = await git(worktree, "rev-parse", "HEAD");
			const status = await git(worktree, "status", "--porcelain=v1", "-z");

			await harness.invokeInSession(slug, owner, "Leave unchanged");

			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Ask agent to inspect", "Leave unchanged"],
			});
			assert.match(harness.notices.at(-1)?.message ?? "", new RegExp(tree));
			assert.match(
				harness.notices.at(-1)?.message ?? "",
				/approved-new\.txt/,
			);
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(await git(worktree, "status", "--porcelain=v1", "-z"), status);
			assert.equal(loadState(slug).phase, "committing");
		}

		{
			const slug = "commit-reset-revalidation";
			const { repository, worktree, owner } = await prepareCommitRecovery(slug);
			await git(worktree, "reset", "--mixed", repository.head);
			writeFileSync(join(worktree, "tracked.txt"), "wrong commit\n");
			await git(worktree, "add", "tracked.txt");
			await git(worktree, "commit", "-m", "Wrong commit");
			const head = await git(worktree, "rev-parse", "HEAD");
			harness.beforeNextSelect = () => {
				writeFileSync(
					join(tasks, slug, "state.json"),
					`${JSON.stringify({ ...loadState(slug), tree: repository.head }, null, 2)}\n`,
				);
			};
			await harness.invokeInSession(
				slug,
				owner,
				"Invalidate approval & return to Build",
			);
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(loadState(slug).phase, "committing");
			assert.ok(
				harness.notices.some((notice) =>
					notice.message.includes("commit state changed while recovery was open"),
				),
			);
		}

		{
			const slug = "commit-reset-content-revalidation";
			const { repository, worktree, owner } = await prepareCommitRecovery(slug);
			await git(worktree, "reset", "--mixed", repository.head);
			writeFileSync(join(worktree, "tracked.txt"), "wrong commit\n");
			await git(worktree, "add", "tracked.txt");
			await git(worktree, "commit", "-m", "Wrong commit");
			const head = await git(worktree, "rev-parse", "HEAD");
			harness.beforeNextSelect = () =>
				writeFileSync(join(worktree, "tracked.txt"), "changed while open\n");

			await harness.invokeInSession(
				slug,
				owner,
				"Invalidate approval & return to Build",
			);

			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(
				readFileSync(join(worktree, "tracked.txt"), "utf8"),
				"changed while open\n",
			);
			assert.equal(loadState(slug).phase, "committing");
			assert.match(
				harness.notices.at(-1)?.message ?? "",
				/worktree or index evidence changed while recovery was open/,
			);
		}

		{
			const slug = "commit-retry-revalidation";
			const { repository, worktree, owner } = await prepareCommitRecovery(slug);
			const promptCount = harness.prompts.length;
			harness.beforeNextSelect = async () => {
				await git(worktree, "reset", "--mixed", repository.head);
			};
			await harness.invokeInSession(slug, owner, "Retry commit");
			assert.equal(harness.prompts.length, promptCount);
			assert.equal(await git(worktree, "rev-parse", "HEAD"), repository.head);
			assert.equal(loadState(slug).phase, "committing");
		}

		{
			const slug = "commit-exact-tree-residue";
			const { worktree, owner } = await prepareCommitRecovery(slug);
			await git(worktree, "commit", "-m", "Exact commit");
			const head = await git(worktree, "rev-parse", "HEAD");
			writeFileSync(join(worktree, "residue.txt"), "keep residue\n");
			await harness.invokeInSession(slug, owner, "Leave unchanged");
			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: [
					"Ask agent to clean remaining files",
					"Undo commit & return to Build",
					"Leave unchanged",
				],
			});
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(loadState(slug).phase, "committing");
			assert.equal(loadOutline(slug).phases[0].status, "pending");
		}

		{
			const slug = "commit-parent-retry";
			const { worktree, owner } = await prepareCommitRecovery(slug);
			await harness.invokeInSession(slug, owner, "Leave unchanged");
			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: [
					"Retry commit",
					"Invalidate approval & return to Build",
					"Leave unchanged",
				],
			});
			assert.notEqual(await git(worktree, "diff", "--cached", "--name-only"), "");
		}

		for (const indexState of ["wrong", "partially-unstaged"] as const) {
			const slug = `commit-parent-${indexState}`;
			const { worktree, owner } = await prepareCommitRecovery(slug);
			if (indexState === "wrong") {
				writeFileSync(join(worktree, "tracked.txt"), "wrong staged content\n");
				await git(worktree, "add", "tracked.txt");
			} else await git(worktree, "reset", "HEAD", "--", "tracked.txt");
			const head = await git(worktree, "rev-parse", "HEAD");
			const status = await git(worktree, "status", "--porcelain=v1", "-z");

			await harness.invokeInSession(slug, owner, "Leave unchanged");

			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Invalidate approval & return to Build", "Leave unchanged"],
			});
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(await git(worktree, "status", "--porcelain=v1", "-z"), status);
		}

		{
			const slug = "commit-legacy-recovery";
			const { worktree, owner } = await prepareCommitRecovery(slug, {
				legacy: true,
			});
			await harness.invokeInSession(slug, owner, "Leave unchanged");
			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Invalidate approval & return to Build", "Leave unchanged"],
			});
			assert.ok(
				harness.notices.some((notice) =>
					notice.message.includes("approved tree was not recorded"),
				),
			);
			assert.notEqual(await git(worktree, "diff", "--cached", "--name-only"), "");
		}

		{
			const slug = "commit-legacy-completed-outline";
			const { worktree, owner } = await prepareCommitRecovery(slug, {
				legacy: true,
				completed: true,
			});
			await git(worktree, "commit", "-m", "Legacy completed commit");
			writeFileSync(join(worktree, "residue.txt"), "cleanup required\n");
			await harness.invokeInSession(slug, owner, "Leave unchanged");
			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Ask agent to clean remaining files", "Leave unchanged"],
			});
			assert.equal(loadState(slug).phase, "committing");
			rmSync(join(worktree, "residue.txt"));
			const noticeCount = harness.notices.length;

			await harness.invokeInSession(slug, owner);

			assert.equal(loadState(slug).phase, "pr");
			assert.ok(
				harness.notices
					.slice(noticeCount)
					.some((notice) =>
						notice.message.includes("legacy commit recovery resumed state advancement"),
					),
			);
			assert.ok(
				harness.notices
					.slice(noticeCount)
					.every((notice) => !notice.message.includes("commit verified")),
			);
		}

		{
			const slug = "commit-owner-events";
			const { worktree, owner } = await prepareCommitRecovery(slug);
			const other = harness.createOwner(worktree, `${slug} · build`);
			await harness.startSession(other);
			await harness.settle(other);
			assert.equal(loadState(slug).phase, "committing");
			assert.deepEqual(await harness.input(other), { action: "handled" });
			assert.match(harness.notices.at(-1)?.message ?? "", /\/clone/);
			assert.match(
				harness.notices.at(-1)?.message ?? "",
				new RegExp(`/rpi ${slug}`),
			);
			assert.deepEqual(await harness.input(owner), { action: "continue" });
			await git(worktree, "commit", "-m", "Exact owner commit");
			await harness.settle(other);
			assert.equal(loadState(slug).phase, "committing");
			await harness.settle(owner);
			assert.equal(loadState(slug).phase, "pr");
		}

		for (const kind of ["detached", "branch"] as const) {
			const slug = `commit-ambiguous-${kind}`;
			const { worktree, owner } = await prepareCommitRecovery(slug);
			if (kind === "detached") await git(worktree, "checkout", "--detach");
			else await git(worktree, "checkout", "-b", `${slug}-other`);
			const head = await git(worktree, "rev-parse", "HEAD");
			const status = await git(worktree, "status", "--porcelain=v1", "-z");

			await harness.invokeInSession(slug, owner, "Leave unchanged");

			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Ask agent to inspect", "Leave unchanged"],
			});
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(await git(worktree, "status", "--porcelain=v1", "-z"), status);
			assert.equal(loadState(slug).phase, "committing");
		}

		for (const kind of ["extra", "merge"] as const) {
			const slug = `commit-ambiguous-${kind}`;
			const { repository, worktree, owner } = await prepareCommitRecovery(slug);
			if (kind === "merge") {
				const side = join(scratch, `${slug}-side`);
				await git(repository.root, "worktree", "add", "-b", `${slug}-side`, side, repository.head);
				writeFileSync(join(side, "side.txt"), "side\n");
				await git(side, "add", "side.txt");
				await git(side, "commit", "-m", "Side commit");
				await git(worktree, "commit", "-m", "Exact commit");
				await git(worktree, "merge", "--no-ff", `${slug}-side`, "-m", "Merge side");
			} else {
				await git(worktree, "commit", "-m", "Exact commit");
				await git(worktree, "commit", "--allow-empty", "-m", "Extra commit");
			}
			const head = await git(worktree, "rev-parse", "HEAD");
			await harness.invokeInSession(slug, owner, "Leave unchanged");
			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Ask agent to inspect", "Leave unchanged"],
			});
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(loadState(slug).phase, "committing");
		}

		{
			const slug = "commit-completed-outline";
			const { worktree, owner } = await prepareCommitRecovery(slug, {
				completed: true,
			});
			await git(worktree, "commit", "-m", "Exact completed commit");
			const head = await git(worktree, "rev-parse", "HEAD");
			writeFileSync(join(worktree, "residue.txt"), "residue\n");
			await harness.invokeInSession(slug, owner, "Leave unchanged");
			assert.deepEqual(harness.selections.at(-1), {
				question: "Commit recovery",
				options: ["Ask agent to clean remaining files", "Leave unchanged"],
			});
			assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
			assert.equal(loadOutline(slug).phases[0].status, "completed");
			rmSync(join(worktree, "residue.txt"));
			await harness.invokeInSession(slug, owner);
			assert.equal(loadState(slug).phase, "pr");
			assert.equal(loadOutline(slug).phases[0].status, "completed");
		}

		for (const changedTree of [false, true]) {
			const slug = `commit-amend-${changedTree ? "content" : "message"}`;
			const { worktree, owner } = await prepareCommitRecovery(slug);
			await git(worktree, "commit", "-m", "Initial commit");
			if (changedTree) {
				writeFileSync(join(worktree, "tracked.txt"), "amended content\n");
				await git(worktree, "add", "tracked.txt");
			}
			await git(worktree, "commit", "--amend", "-m", "Amended commit");
			await harness.invokeInSession(
				slug,
				owner,
				changedTree ? "Leave unchanged" : undefined,
			);
			if (changedTree) {
				assert.deepEqual(harness.selections.at(-1), {
					question: "Commit recovery",
					options: ["Invalidate approval & return to Build", "Leave unchanged"],
				});
				assert.equal(loadState(slug).phase, "committing");
			} else assert.equal(loadState(slug).phase, "pr");
		}

		{
			const slug = "remove-absent-worktree";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			persistTask(slug, state(repository.common, repository.head, "questions"));
			const owner = harness.createOwner(worktree, `${slug} · questions`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			const doneSession = harness.createOwner(worktree, `${slug} · done`);
			const donePath = doneSession.getSessionFile();
			assert.ok(donePath);
			const otherSession = harness.createOwner(
				worktree,
				`${slug}-other · questions`,
			);
			const otherPath = otherSession.getSessionFile();
			assert.ok(otherPath);
			rmSync(worktree, { recursive: true });
			await harness.remove(slug, repository.root);
			assert.equal(existsSync(join(tasks, slug)), false);
			assert.equal(existsSync(ownerPath), false);
			assert.equal(existsSync(donePath), true);
			assert.equal(existsSync(otherPath), true);
			assert.equal(
				await git(repository.root, "rev-parse", `refs/heads/${slug}`),
				repository.head,
			);
			assert.match(
				await git(repository.root, "worktree", "list", "--porcelain"),
				new RegExp(`worktree ${worktree}`),
			);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.level === "warning" &&
						notice.message.includes("worktree is absent"),
				),
			);
		}

		{
			const slug = "remove-malformed-state";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			persistTask(slug, state(repository.common, repository.head, "questions"));
			persistQuestions(slug, [cacheQuestion]);
			writeFileSync(join(tasks, slug, "state.json"), "not json\n");
			const owner = harness.createOwner(worktree, `${slug} · questions`);
			const ownerPath = owner.getSessionFile();
			assert.ok(ownerPath);
			await harness.startSession(owner);
			const plain = harness.createOwner(repository.root, "plain session");
			await harness.startSession(plain);
			await harness.remove(slug, repository.root);
			assert.equal(existsSync(worktree), false);
			assert.equal(existsSync(ownerPath), false);
			assert.equal(existsSync(join(tasks, slug)), false);
			assert.equal(
				await git(repository.root, "rev-parse", `refs/heads/${slug}`),
				repository.head,
			);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.level === "warning" &&
						notice.message === `${slug}: state.json is malformed`,
				),
			);
		}

		{
			const slug = "keep-changed-worktree";
			const repository = await initRepository(slug);
			writeFileSync(join(repository.root, ".gitignore"), "ignored.log\n");
			await git(repository.root, "add", ".gitignore");
			await git(repository.root, "commit", "-m", "Ignore test log");
			repository.head = await git(repository.root, "rev-parse", "HEAD");
			const worktree = join(worktrees, slug);
			await git(
				repository.root,
				"worktree",
				"add",
				"-b",
				slug,
				worktree,
				repository.head,
			);
			persistTask(slug, state(repository.common, repository.head, "questions"));
			harness.beforeNextConfirm = () => {
				writeFileSync(join(worktree, "ignored.log"), "keep\n");
			};
			await harness.remove(slug, repository.root);
			assert.equal(existsSync(join(worktree, "ignored.log")), true);
			assert.equal(existsSync(join(tasks, slug)), true);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.level === "error" &&
						notice.message.includes("including ignored files"),
				),
			);
		}

		{
			const slug = "keep-unsafe-worktree";
			const repository = await initRepository(slug);
			const worktree = join(worktrees, slug);
			mkdirSync(worktree, { recursive: true });
			writeFileSync(join(worktree, "unrelated.txt"), "keep\n");
			persistTask(slug, state(repository.common, repository.head, "questions"));
			await harness.remove(slug, repository.root);
			assert.equal(existsSync(join(worktree, "unrelated.txt")), true);
			assert.equal(existsSync(join(tasks, slug)), true);
			assert.ok(
				harness.notices.some(
					(notice) =>
						notice.level === "error" &&
						notice.message.includes("exists but is not a Git checkout"),
				),
			);
		}

		console.log("rpi real-Git workflow integration: ok");
	} finally {
		process.off("exit", cleanupTempFiles);
		cleanupTempFiles();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const [name, value] of previousGitIdentity) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
