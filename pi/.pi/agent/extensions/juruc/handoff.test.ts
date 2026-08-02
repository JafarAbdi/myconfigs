import assert from "node:assert/strict";
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
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireTestLock } from "./test-lock.ts";

const agentDir = mkdtempSync(join(tmpdir(), "juruc-handoff-agent-"));
const scratch = mkdtempSync(join(tmpdir(), "juruc-handoff-repository-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const [name, value] of Object.entries({
	GIT_AUTHOR_NAME: "JURUC handoff test",
	GIT_AUTHOR_EMAIL: "juruc-handoff@example.invalid",
	GIT_COMMITTER_NAME: "JURUC handoff test",
	GIT_COMMITTER_EMAIL: "juruc-handoff@example.invalid",
}))
	process.env[name] = value;

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const releaseTestLock = await acquireTestLock("juruc-extension-node-modules.lock");
const localModules = join(extensionDirectory, "node_modules");
const piExecutable = process.env.PATH?.split(delimiter)
	.map((directory) => join(directory, "pi"))
	.find(existsSync);
const piPackage =
	process.env.PI_PACKAGE_DIR ??
	(piExecutable ? join(dirname(realpathSync(piExecutable)), "..") : undefined);
if (!piPackage) throw new Error("pi package not found through PI_PACKAGE_DIR or PATH");
if (existsSync(localModules))
	throw new Error(`${localModules} already exists; refusing to replace it`);
mkdirSync(join(localModules, "@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-tui"])
	symlinkSync(
		join(piPackage, "node_modules", "@earendil-works", name),
		join(localModules, "@earendil-works", name),
		"dir",
	);
symlinkSync(piPackage, join(localModules, "@earendil-works", "pi-coding-agent"), "dir");
symlinkSync(
	join(piPackage, "node_modules", "typebox"),
	join(localModules, "typebox"),
	"dir",
);

function cleanup(): void {
	rmSync(localModules, { recursive: true, force: true });
	releaseTestLock();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
process.once("exit", cleanup);

try {
	const [
		{ default: registerJuruc },
		{ SessionManager },
		{ git, repositoryEvidence, ensureManagedWorktree },
		{ runtimePaths },
		{ createTask, enterPlanning, loadTask, recordPlanningSession, taskIdentity },
		{ researchKickoff },
	] = await Promise.all([
		import("./index.ts"),
		import("@earendil-works/pi-coding-agent"),
		import("./repository.ts"),
		import("./runtime.ts"),
		import("./tasks.ts"),
		import("./planning.ts"),
	]);

	const source = join(scratch, "source");
	mkdirSync(source);
	for (const args of [
		["init", "-b", "main"],
		["add", "baseline.txt"],
		["commit", "-m", "Baseline"],
	]) {
		if (args[0] === "add") writeFileSync(join(source, "baseline.txt"), "baseline\n");
		const result = await git(source, args);
		assert.equal(result.code, 0, result.stderr);
	}
	const repository = await repositoryEvidence(source);
	assert.ok(repository);
	const paths = runtimePaths(agentDir);
	const slug = "automatic-handoff";
	const identity = taskIdentity(
		paths,
		slug,
		repository.root,
		repository.branch,
		repository.head,
	);
	let task = createTask(
		paths,
		"Automatic handoff",
		slug,
		"Exercise automatic handoff.",
		identity,
	);
	await ensureManagedWorktree(task.state);
	task = enterPlanning(task);
	const planning = SessionManager.create(task.state.worktree);
	planning.appendMessage({
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
	const planningPath = planning.getSessionFile();
	assert.ok(planningPath);
	task = recordPlanningSession(task, {
		path: realpathSync(planningPath),
		id: planning.getSessionId(),
	});

	type SessionManagerInstance = ReturnType<typeof SessionManager.create>;
	type Context = Record<string, unknown> & {
		cwd: string;
		hasUI: boolean;
		mode: "rpc";
		sessionManager: SessionManagerInstance;
		ui: {
			select(title: string, options: string[]): Promise<string | undefined>;
			editor(title: string): Promise<string | undefined>;
			notify(message: string, level: string): void;
			setWidget(key: string, value: unknown): void;
		};
		waitForIdle(): Promise<void>;
		switchSession(
			path: string,
			options?: { withSession?: (context: Context) => Promise<void> },
		): Promise<{ cancelled: boolean }>;
		sendUserMessage(message: string): Promise<void>;
	};
	type EventHandler = (event: Record<string, unknown>, context: Context) => unknown;
	type CommandHandler = (args: string, context: Context) => Promise<void>;
	type Tool = {
		name: string;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: () => void,
			context: Context,
		): Promise<{ terminate?: boolean }>;
	};

	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, Tool>();
	const selections = ["Open Automatic handoff — automatic-handoff · planning", "Build"];
	const replacementMessages: string[] = [];
	let activeTools = ["read"];
	let aborts = 0;
	let lastReplacementContext: Context | undefined;
	const slashMessages: string[] = [];
	const notices: string[] = [];
	const statusLines: string[] = [];

	function context(manager: SessionManagerInstance): Context {
		const value = {
			cwd: manager.getCwd(),
			hasUI: true,
			mode: "rpc" as const,
			sessionManager: manager,
			ui: {
				select: async () => selections.shift(),
				editor: async () => undefined,
				notify: (message: string) => notices.push(message),
				setWidget: (key: string, widget: unknown) => {
					if (key === "juruc" && Array.isArray(widget) && typeof widget[0] === "string")
						statusLines.push(widget[0]);
				},
				confirm: async () => false,
				input: async () => undefined,
				custom: async () => undefined,
			},
			waitForIdle: async () => undefined,
			isIdle: () => true,
			isProjectTrusted: () => true,
			abort: () => { aborts += 1; },
			hasPendingMessages: () => false,
			shutdown: () => undefined,
			getContextUsage: () => undefined,
			compact: () => undefined,
			getSystemPrompt: () => "",
			getSystemPromptOptions: () => ({ selectedTools: [...activeTools] }),
			modelRegistry: { find: () => undefined },
			model: undefined,
			thinkingLevel: "off",
			signal: undefined,
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			reload: async () => undefined,
			switchSession: async (
				path: string,
				options: { withSession?: (context: Context) => Promise<void> } = {},
			) => {
				await handlers.get("session_shutdown")?.({}, value as Context);
				activeGrill = managedGrill;
				const replacement = SessionManager.open(path);
				const replacementContext = context(replacement);
				lastReplacementContext = replacementContext;
				await handlers.get("session_start")?.({}, replacementContext);
				await options.withSession?.(replacementContext);
				return { cancelled: false };
			},
			sendUserMessage: async (message: string) => {
				replacementMessages.push(message);
			},
		};
		return value as Context;
	}

	const sourceGrill = join(scratch, "source-grill.md");
	const managedGrill = join(scratch, "managed-grill.md");
	writeFileSync(sourceGrill, "Dirty source ${ARGUMENTS:-the task}.\n");
	writeFileSync(managedGrill, "Managed grill ${ARGUMENTS:-the task}.\n");
	let activeGrill = sourceGrill;
	registerJuruc({
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: CommandHandler }) =>
			commands.set(name, options.handler),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		getAllTools: () => [
			...[
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
				"web_search",
				"fetch_content",
				"delegate",
			].map((name) => ({ name })),
			...[...tools.keys()].map((name) => ({ name })),
		],
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		getCommands: () => [
			{ name: "grill", source: "prompt", sourceInfo: { path: activeGrill } },
		],
		sendUserMessage: (message: string) => {
			slashMessages.push(message);
		},
	} as never);

	assert.deepEqual(
		[...commands.keys()],
		["juruc"],
		"only one user command is registered",
	);
	const sourceSession = SessionManager.create(source);
	sourceSession.appendMessage({
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
	await handlers.get("session_start")?.({}, context(sourceSession));
	await commands.get("juruc")?.("", context(sourceSession));
	assert.deepEqual(
		replacementMessages,
		[researchKickoff("Exercise automatic handoff.")],
		"a separate research session is kicked off before /grill",
	);
	assert.deepEqual(slashMessages, []);
	assert.deepEqual(activeTools, ["delegate"]);
	const researching = loadTask(paths, slug);
	assert.equal(researching.state.phase, "planning");
	assert.ok(researching.state.phase === "planning" && researching.state.researchSession);
	assert.equal(researching.state.researchProgress, "orientation");
	assert.notEqual(researching.state.researchSession?.path, planningPath);
	const researchContext = lastReplacementContext!;
	const directRead = await handlers.get("tool_call")?.(
		{ toolName: "read", input: { path: "src/main.rs" }, toolCallId: "inline-read" },
		researchContext,
	);
	assert.deepEqual(directRead, {
		block: true,
		reason: "Research coordinators may only delegate",
	});
	const resultFor = (agent: "scout" | "researcher" | "synthesizer", output: string) => ({
		agent,
		task: "Bounded factual work.",
		output,
		stopReason: "stop",
		steps: [],
		turns: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		durationMs: 1,
	});
	const beforeFailedOrientation = loadTask(paths, slug);
	assert.equal(await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "scout" }, toolCallId: "orientation-failed" },
		researchContext,
	), undefined);
	const noticesBeforeFailure = notices.length;
	assert.equal(await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "orientation-failed", isError: true, result: { error: "ordinary delegate failure" } },
		researchContext,
	), undefined);
	assert.deepEqual(loadTask(paths, slug).state, beforeFailedOrientation.state);
	assert.equal(notices.length, noticesBeforeFailure, "delegate failures add no JURUC error prose");
	assert.equal(aborts, 0);

	assert.equal(await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "scout" }, toolCallId: "orientation-retry" },
		researchContext,
	), undefined);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "orientation-retry", isError: false, result: { details: resultFor("scout", "Questions") } },
		researchContext,
	);
	const afterOrientation = loadTask(paths, slug);
	assert.ok(afterOrientation.state.phase === "planning" && afterOrientation.state.step === "research");
	assert.equal(afterOrientation.state.researchProgress, "evidence");
	assert.deepEqual(afterOrientation.state.researchSession, researching.state.researchSession);
	assert.deepEqual(await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "synthesizer" }, toolCallId: "synthesis-too-early" },
		researchContext,
	), {
		block: true,
		reason: "Research synthesis requires ready evidence",
	});

	assert.equal(await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "researcher" }, toolCallId: "evidence-failed" },
		researchContext,
	), undefined);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "evidence-failed", isError: true, result: { error: "ordinary evidence failure" } },
		researchContext,
	);
	const afterFailedEvidence = loadTask(paths, slug);
	assert.ok(afterFailedEvidence.state.phase === "planning" && afterFailedEvidence.state.step === "research");
	assert.deepEqual(afterFailedEvidence.state, afterOrientation.state);
	assert.equal(notices.length, noticesBeforeFailure);
	assert.equal(aborts, 0);

	const evidence = Array.from({ length: 7 }, (_, index) => [
		`evidence-${index + 1}`,
		index % 2 === 0 ? "scout" : "researcher",
	] as const);
	for (const [toolCallId, agent] of evidence)
		assert.equal(await handlers.get("tool_call")?.(
			{ toolName: "delegate", input: { agent }, toolCallId },
			researchContext,
		), undefined, `${toolCallId} is accepted without a durable count limit`);
	for (const [toolCallId, agent] of evidence)
		await handlers.get("tool_execution_end")?.(
			{ toolName: "delegate", toolCallId, isError: false, result: { details: resultFor(agent, `${toolCallId} report`) } },
			researchContext,
		);
	const ready = loadTask(paths, slug);
	assert.ok(ready.state.phase === "planning" && ready.state.step === "research");
	assert.equal(ready.state.researchProgress, "ready");
	assert.deepEqual(ready.state.researchSession, researching.state.researchSession);
	assert.equal(await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "scout" }, toolCallId: "evidence-after-ready" },
		researchContext,
	), undefined);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "evidence-after-ready", isError: false, result: { details: resultFor("scout", "Further evidence") } },
		researchContext,
	);
	const afterFurtherEvidence = loadTask(paths, slug);
	assert.ok(
		afterFurtherEvidence.state.phase === "planning" &&
			afterFurtherEvidence.state.step === "research",
	);
	assert.deepEqual(
		afterFurtherEvidence.state,
		ready.state,
		"further successful evidence creates no additional durable state",
	);

	const researchPath = join(ready.directory, "research.md");
	writeFileSync(researchPath, "unapproved interrupted synthesis\n");
	assert.equal(await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "synthesizer" }, toolCallId: "synthesis-failed" },
		researchContext,
	), undefined);
	assert.match(statusLines.at(-1) ?? "", /^● research · synthesizing  ○ plan  ○ build  ○ done$/u);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "synthesis-failed", isError: true, result: { error: "ordinary synthesis failure" } },
		researchContext,
	);
	const afterFailedSynthesis = loadTask(paths, slug);
	assert.ok(afterFailedSynthesis.state.phase === "planning" && afterFailedSynthesis.state.step === "research");
	assert.deepEqual(afterFailedSynthesis.state, ready.state);
	assert.equal(readFileSync(researchPath, "utf8"), "unapproved interrupted synthesis\n");
	assert.equal(notices.length, noticesBeforeFailure);
	assert.equal(aborts, 0);
	assert.match(
		statusLines.at(-1) ?? "",
		/^● research · ready  ○ plan  ○ build  ○ done$/u,
		"a failed synthesis clears transient activity without changing durable progress",
	);

	const brief = "  ## Findings\r\n\nUse the existing handoff boundary.\n";
	assert.equal(await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "synthesizer" }, toolCallId: "synthesis-retry" },
		researchContext,
	), undefined);
	const beforeResearch = loadTask(paths, slug);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "synthesis-retry", isError: false, result: { details: resultFor("synthesizer", brief) } },
		researchContext,
	);
	assert.equal(aborts, 1, "successful synthesis stops the coordinator after durable persistence");
	assert.equal(tools.has("juruc_submit_research"), false, "research requires no model-authored copy step");
	await handlers.get("agent_settled")?.({}, researchContext);
	const afterResearch = loadTask(paths, slug);
	assert.deepEqual(afterResearch.plan, beforeResearch.plan);
	assert.equal(afterResearch.state.phase, "planning");
	if (afterResearch.state.phase === "planning") {
		assert.equal(afterResearch.state.step, "grill");
		assert.equal(afterResearch.state.researchSession, null);
	}
	assert.deepEqual(slashMessages, []);
	assert.ok(replacementMessages.includes("Managed grill Exercise automatic handoff..\n"));
	assert.equal(
		readFileSync(join(afterResearch.directory, "research.md"), "utf8"),
		brief,
		"successful synthesis overwrites research.md with exact verbatim output",
	);
	const planningContext = lastReplacementContext!;
	const plannerDelegate = await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "scout" }, toolCallId: "planner-delegate" },
		planningContext,
	);
	assert.deepEqual(plannerDelegate, { block: true, reason: "Planning sessions are read-only" });

	const tool = tools.get("juruc_set_plan");
	assert.ok(tool);
	const planInput = {
		objective: "Exercise automatic handoff.",
		desiredEndState: "The plan is promoted without a slash message.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		decisions: [],
		risks: [],
		successCriteria: ["The task enters Building."],
		futurePhases: [
			{
				title: "Build",
				objective: "Implement the task.",
				successCriteria: ["Implementation is complete."],
			},
		],
	};
	const persisted = await tool.execute(
		"persist-plan",
		planInput,
		new AbortController().signal,
		() => undefined,
		{ ...planningContext, hasUI: false },
	);
	assert.equal(persisted.terminate, true);
	assert.ok(loadTask(paths, slug).plan.candidate, "the interrupted submission left a durable candidate");
	const result = await tool.execute(
		"retry-plan",
		planInput,
		new AbortController().signal,
		() => undefined,
		planningContext,
	);
	assert.equal(result.terminate, true);
	assert.equal(loadTask(paths, slug).state.phase, "promoting");

	await handlers.get("agent_settled")?.({}, planningContext);
	assert.equal(
		loadTask(paths, slug).state.phase,
		"building",
		`agent_settled awaits durable recovery before returning: ${notices.join("; ")}`,
	);
	assert.equal(slashMessages.length, 0, "research handoff stays in task-owned sessions");
	assert.ok(replacementMessages.some((message) => message.startsWith("Build P1:")));

	console.log("juruc automatic durable recovery: ok");
} finally {
	cleanup();
}
