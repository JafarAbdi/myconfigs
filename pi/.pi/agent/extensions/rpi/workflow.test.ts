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

interface SessionOptions {
	parentSession?: string;
	setup?: (manager: SessionManagerInstance) => Promise<void>;
	withSession?: (ctx: MockContext) => Promise<void>;
}

interface MockContext {
	cwd: string;
	mode: "rpc";
	hasUI: true;
	sessionManager: SessionManagerInstance;
	modelRegistry: { find(): undefined };
	model: undefined;
	thinkingLevel: undefined;
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
	newSession(options?: SessionOptions): Promise<{ cancelled: false }>;
	switchSession(
		path: string,
		options?: Pick<SessionOptions, "withSession">,
	): Promise<{ cancelled: false }>;
	sendUserMessage(text: string): Promise<void>;
}

interface MockUI {
	editor(question: string): Promise<string | undefined>;
	confirm(title: string, body: string): Promise<boolean>;
	select(): Promise<string | undefined>;
	input(): Promise<undefined>;
	custom(): Promise<undefined>;
	notify(message: string, level: string): void;
	setWidget(): void;
	getEditorText(): string;
	setEditorText(text: string): void;
}

const agentDir = mkdtempSync(join(tmpdir(), "rpi-workflow-agent-"));
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
process.env.PI_CODING_AGENT_DIR = agentDir;
Object.assign(process.env, gitIdentity);

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const localModules = join(extensionDirectory, "node_modules");
const piPackage =
	"/home/juruc/.local/share/fnm/node-versions/v22.22.3/installation/lib/node_modules/@earendil-works/pi-coding-agent";
let removeLocalModules = false;

function cleanupTempFiles(): void {
	rmSync(scratch, { recursive: true, force: true });
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
	const [{ default: registerRpi }, { SessionManager }] = await Promise.all([
		import("./index.ts"),
		import("@earendil-works/pi-coding-agent"),
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
	const phaseLine = "- [ ] Phase 1: Implement the focused change";

	function state(
		gitLocation: string,
		_head: string,
		phase: string,
		extra: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			version: 4,
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
		outline?: string,
	): void {
		const directory = join(tasks, slug);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "ticket.md"), `# ${slug}\n\nTest task.\n`);
		writeFileSync(
			join(directory, "state.json"),
			`${JSON.stringify(taskState, null, 2)}\n`,
		);
		if (outline !== undefined)
			writeFileSync(join(directory, "04-outline.md"), outline);
	}

	function loadState(slug: string): Record<string, unknown> {
		return JSON.parse(
			readFileSync(join(tasks, slug, "state.json"), "utf8"),
		) as Record<string, unknown>;
	}

	class Harness {
		readonly notices: Notice[] = [];
		readonly prompts: CapturedPrompt[] = [];
		readonly switches: string[] = [];
		readonly confirmations: Array<{ title: string; body: string }> = [];
		readonly editors: string[] = [];
		private manager: SessionManagerInstance | undefined;
		private command:
			| ((args: string, ctx: MockContext) => Promise<void>)
			| undefined;
		private editorAnswers: string[] = [];
		private confirmAnswers: boolean[] = [];
		private selectAnswers: string[] = [];
		private readonly commitPrompt = join(agentDir, "commit-message.md");

		constructor() {
			writeFileSync(
				this.commitPrompt,
				"---\ndescription: test\n---\nCommit the staged change.\n",
			);
			const api = {
				on: () => undefined,
				registerTool: () => undefined,
				registerCommand: (
					name: string,
					options: {
						handler: (args: string, ctx: MockContext) => Promise<void>;
					},
				) => {
					if (name === "rpi") this.command = options.handler;
				},
				getSessionName: () => this.manager?.getSessionName(),
				sendUserMessage: (text: string) => this.capturePrompt(text),
				getCommands: () => [
					{
						name: "commit-message",
						source: "prompt",
						sourceInfo: { path: this.commitPrompt },
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
			const source = SessionManager.create(cwd);
			this.persistSession(source, `source · ${slug}`);
			await this.withManager(source, () =>
				this.command?.(slug, this.context(source)),
			);
		}

		async invokeInSession(
			slug: string,
			manager: SessionManagerInstance,
			selection?: string,
		): Promise<void> {
			assert.ok(this.command, "RPI command was not registered");
			this.editorAnswers = [];
			this.confirmAnswers = [];
			this.selectAnswers = selection ? [selection] : [];
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

		private context(manager: SessionManagerInstance): MockContext {
			const ui: MockUI = {
				editor: async (question) => {
					this.editors.push(question);
					return this.editorAnswers.shift();
				},
				confirm: async (title, body) => {
					this.confirmations.push({ title, body });
					return this.confirmAnswers.shift() ?? false;
				},
				select: async () => this.selectAnswers.shift(),
				input: async () => undefined,
				custom: async () => undefined,
				notify: (message, level) => {
					this.notices.push({ message, level, cwd: manager.getCwd() });
				},
				setWidget: () => undefined,
				getEditorText: () => "",
				setEditorText: () => undefined,
			};
			const context: MockContext = {
				cwd: manager.getCwd(),
				mode: "rpc",
				hasUI: true,
				sessionManager: manager,
				modelRegistry: { find: () => undefined },
				model: undefined,
				thinkingLevel: undefined,
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

	const harness = new Harness();

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
			await harness.invoke(slug, repository.root);
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
					build: { phaseLine, status: "pending" },
				}),
			);
			const externalOutline = join(scratch, `${slug}-outline.md`);
			writeFileSync(externalOutline, `${phaseLine}\n`);
			symlinkSync(externalOutline, join(tasks, slug, "04-outline.md"));
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
					phaseLine,
					session: ownerPath,
					parent: repository.head,
					paths: ["new.txt", "tracked.txt"],
				}),
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
						phaseLine,
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
					phaseLine,
					session: ownerPath,
					resolution,
				}),
				`# Outline\n\n${phaseLine.replace("[ ]", "[x]")}\n\n## Phase 1: Implement the focused change\n\nResolution: ${resolution}\n`,
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
			await git(worktree, "commit", "-m", "Complete phase");
			persistTask(
				slug,
				state(repository.common, repository.head, "committing", {
					phaseLine,
					session: ownerPath,
					parent: repository.head,
				}),
				`# Outline\n\n${phaseLine}\n\n## Phase 1: Implement the focused change\n`,
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
			assert.match(
				readFileSync(join(tasks, slug, "04-outline.md"), "utf8"),
				/^- \[x\] Phase 1: Implement the focused change$/m,
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
					build: { phaseLine, status: "active", session: ownerPath },
				}),
				`# Outline\n\n${phaseLine}\n\n## Phase 1: Implement the focused change\n`,
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
