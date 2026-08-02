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
import { COMMIT_INSPECTION_COMMANDS } from "./commit-message.ts";

const agentDir = mkdtempSync(join(tmpdir(), "juruc-pipeline-agent-"));
const scratch = mkdtempSync(join(tmpdir(), "juruc-pipeline-repository-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const [name, value] of Object.entries({
	GIT_AUTHOR_NAME: "JURUC pipeline test",
	GIT_AUTHOR_EMAIL: "juruc-pipeline@example.invalid",
	GIT_COMMITTER_NAME: "JURUC pipeline test",
	GIT_COMMITTER_EMAIL: "juruc-pipeline@example.invalid",
})) process.env[name] = value;

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const releaseTestLock = await acquireTestLock("juruc-extension-node-modules.lock");
const localModules = join(extensionDirectory, "node_modules");
const piExecutable = process.env.PATH?.split(delimiter)
	.map((directory) => join(directory, "pi"))
	.find(existsSync);
const piPackage = process.env.PI_PACKAGE_DIR ??
	(piExecutable ? join(dirname(realpathSync(piExecutable)), "..") : undefined);
if (!piPackage) throw new Error("pi package not found through PI_PACKAGE_DIR or PATH");
if (existsSync(localModules)) throw new Error(`${localModules} already exists; refusing to replace it`);
mkdirSync(join(localModules, "@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-tui"])
	symlinkSync(
		join(piPackage, "node_modules", "@earendil-works", name),
		join(localModules, "@earendil-works", name),
		"dir",
	);
symlinkSync(piPackage, join(localModules, "@earendil-works", "pi-coding-agent"), "dir");
symlinkSync(join(piPackage, "node_modules", "typebox"), join(localModules, "typebox"), "dir");

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
		{},
		{ createTask, enterPlanning, loadTask, recordPlanningSession, taskIdentity },
		{ acquireSettlementLease, releaseSettlementLease, settlementLease, transferSettlementLease },
		{ committingBaselineState, committingMessageState, saveExecutionState, stagingState },
	] = await Promise.all([
		import("./index.ts"),
		import("@earendil-works/pi-coding-agent"),
		import("./repository.ts"),
		import("./runtime.ts"),
		import("./plan.ts"),
		import("./tasks.ts"),
		import("./lease.ts"),
		import("./state.ts"),
	]);

	const stateAudit = (slug: string) => {
		const task = loadTask(paths, slug);
		return task.state.phase === "building" ? task.state.audit : undefined;
	};

	const source = join(scratch, "source");
	mkdirSync(source);
	writeFileSync(join(source, "baseline.txt"), "baseline\n");
	for (const args of [["init", "-b", "main"], ["add", "baseline.txt"], ["commit", "-m", "Baseline"]]) {
		const result = await git(source, args);
		assert.equal(result.code, 0, result.stderr);
	}
	const repository = await repositoryEvidence(source);
	assert.ok(repository);
	const paths = runtimePaths(agentDir);
	const slug = "deterministic-pipeline";
	const identity = taskIdentity(paths, slug, repository.root, repository.branch, repository.head);
	let task = createTask(paths, "Deterministic pipeline", slug, "Exercise the full pipeline.", identity);
	await ensureManagedWorktree(task.state);
	task = enterPlanning(task);
	const planning = SessionManager.create(task.state.worktree);
	planning.appendMessage({
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const planningPath = planning.getSessionFile();
	assert.ok(planningPath);
	task = recordPlanningSession(task, { path: realpathSync(planningPath), id: planning.getSessionId() });

	type Manager = ReturnType<typeof SessionManager.create>;
	type Context = Record<string, unknown> & {
		cwd: string;
		hasUI: boolean;
		mode: "rpc";
		sessionManager: Manager;
		ui: {
			select(title: string, options: string[]): Promise<string | undefined>;
			editor(title: string): Promise<string | undefined>;
			notify(message: string, level: string): void;
			setWidget(key: string, value: unknown): void;
		};
		waitForIdle(): Promise<void>;
		switchSession(path: string, options?: { withSession?: (context: Context) => Promise<void> }): Promise<{ cancelled: boolean }>;
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): Promise<void>;
		sendUserMessage(message: string): Promise<void>;
	};
	type EventHandler = (event: Record<string, unknown>, context: Context) => unknown;
	type CommandHandler = (args: string, context: Context) => Promise<void>;
	type Tool = {
		name: string;
		execute(id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, context: Context): Promise<Record<string, unknown>>;
	};

	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, Tool>();
	const notices: string[] = [];
	const statusLines: string[] = [];
	const sessionMessages = new Map<string, string[]>();
	const followUps: Array<{ message: unknown; options: unknown }> = [];
	const replacementSends: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
	const switchInputResults: unknown[] = [];
	const sendUserAgentStartAborts: number[] = [];
	const selections = ["Open Deterministic pipeline — deterministic-pipeline · planning", "Build"];
	const editorValues: Array<string | undefined> = [];
	const ordinaryTools = [
		"read", "bash", "edit", "write", "grep", "find", "ls",
		"web_search", "fetch_content", "delegate",
		"juruc_set_plan", "juruc_block_phase",
	];
	const ordinaryWithoutJuruc = ordinaryTools.filter((name) => !name.startsWith("juruc_"));
	let activeTools = [...ordinaryTools];
	let aborts = 0;
	let cancelNextSwitch = false;
	let pendingMessages = false;
	let wrongNextReplacementIdentity = false;
	let currentContext: Context | undefined;

	function context(manager: Manager): Context {
		const sessionPath = manager.getSessionFile();
		assert.ok(sessionPath);
		const value = {
			cwd: manager.getCwd(),
			hasUI: true,
			mode: "rpc" as const,
			sessionManager: manager,
			ui: {
				select: async () => selections.shift(),
				editor: async () => editorValues.shift(),
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
			hasPendingMessages: () => pendingMessages,
			shutdown: () => undefined,
			getContextUsage: () => undefined,
			compact: () => undefined,
			getSystemPrompt: () => "",
			getSystemPromptOptions: () => ({
				selectedTools: [...activeTools],
				cwd: manager.getCwd(),
				contextFiles: [],
			}),
			modelRegistry: { find: () => undefined },
			model: undefined,
			thinkingLevel: "off",
			signal: undefined,
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			reload: async () => undefined,
			switchSession: async (path: string, options: { withSession?: (context: Context) => Promise<void> } = {}) => {
				const preflight = await handlers.get("session_before_switch")?.(
					{ reason: "resume", targetSessionFile: path },
					value as Context,
				);
				if ((preflight as { cancel?: boolean } | undefined)?.cancel) return { cancelled: true };
				if (cancelNextSwitch) {
					cancelNextSwitch = false;
					return { cancelled: true };
				}
				await handlers.get("session_shutdown")?.({ reason: "resume" }, value as Context);
				const replacementContext = context(SessionManager.open(path));
				if (wrongNextReplacementIdentity) {
					wrongNextReplacementIdentity = false;
					replacementContext.sessionManager.getSessionId = () => "wrong-replacement-id";
				}
				currentContext = replacementContext;
				activeTools = [...ordinaryTools];
				await handlers.get("session_start")?.({}, replacementContext);
				switchInputResults.push(await handlers.get("input")?.({}, replacementContext));
				await options.withSession?.(replacementContext);
				return { cancelled: false };
			},
			sendMessage: async (message: Record<string, unknown>, options?: Record<string, unknown>) => {
				await handlers.get("message_start")?.({ message: { role: "custom", ...message } }, value as Context);
				replacementSends.push({ message, options });
				manager.appendCustomMessageEntry(
					message.customType as string,
					message.content as never,
					message.display as boolean,
					message.details,
				);
			},
			sendUserMessage: async (message: string) => {
				const abortsBeforeStart = aborts;
				await handlers.get("agent_start")?.({}, value as Context);
				sendUserAgentStartAborts.push(aborts - abortsBeforeStart);
				const userMessage = {
					role: "user" as const,
					content: [{ type: "text" as const, text: message }],
					timestamp: Date.now(),
				};
				manager.appendMessage(userMessage);
				await handlers.get("message_start")?.({ message: userMessage }, value as Context);
				const messages = sessionMessages.get(sessionPath) ?? [];
				messages.push(message);
				sessionMessages.set(sessionPath, messages);
			},
		};
		return value as Context;
	}

	function assistantToolCalls(manager: Manager, calls: Array<{ id: string; name: string; arguments?: unknown }>): void {
		manager.appendMessage({
			role: "assistant",
			content: calls.map((call) => ({
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: call.arguments ?? {},
			})),
			api: "openai-responses",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
	}

	function successfulToolResult(manager: Manager, toolCallId: string): void {
		manager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		} as never);
	}

	const grill = join(scratch, "grill.md");
	const commitMessage = join(scratch, "commit-message.md");
	writeFileSync(grill, "Canonical grill ${ARGUMENTS:-the task}.\n");
	writeFileSync(commitMessage, "Return the canonical commit message.\n");
	registerJuruc({
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		getAllTools: () => ordinaryTools.map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		getCommands: () => [
			{ name: "grill", source: "prompt", sourceInfo: { path: grill } },
			{ name: "commit-message", source: "prompt", sourceInfo: { path: commitMessage } },
		],
		sendMessage: (message: unknown, options: unknown) => { followUps.push({ message, options }); },
		sendUserMessage: () => { throw new Error("automatic completion must not use sendUserMessage"); },
	} as never);

	const sourceManager = SessionManager.create(source);
	sourceManager.appendMessage({
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sourceContext = context(sourceManager);
	currentContext = sourceContext;
	await handlers.get("session_start")?.({}, sourceContext);
	const ordinaryNotices = notices.length;
	const ordinaryStatuses = statusLines.length;
	const ordinaryState = JSON.stringify(loadTask(paths, slug).state);
	const ordinaryIndex = (await git(source, ["diff", "--cached", "--name-only"])).stdout;
	await handlers.get("tool_execution_start")?.(
		{ toolName: "delegate", args: { agent: "audit" }, toolCallId: "ordinary-audit" },
		sourceContext,
	);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "ordinary-audit", isError: false, result: { agent: "audit" } },
		sourceContext,
	);
	assert.equal(JSON.stringify(loadTask(paths, slug).state), ordinaryState, "ordinary audit observation does not change JURUC state");
	assert.equal(notices.length, ordinaryNotices, "ordinary audit observation emits no JURUC notification");
	assert.equal(statusLines.length, ordinaryStatuses, "ordinary audit observation creates no JURUC tracking");
	assert.equal((await git(source, ["diff", "--cached", "--name-only"])).stdout, ordinaryIndex, "ordinary audit observation does not stage");
	assert.deepEqual(
		activeTools,
		ordinaryTools.filter((name) => !name.startsWith("juruc_")),
		"ordinary sessions preserve unrelated tools and expose no JURUC tools",
	);
	assert.equal(
		await handlers.get("session_before_tree")?.({ preparation: {} }, sourceContext),
		undefined,
		"ordinary sessions remain tree-navigable",
	);
	await commands.get("juruc")?.("", sourceContext);
	assert.ok(currentContext);
	const researchContext = currentContext;
	assert.notEqual(researchContext.sessionManager.getSessionId(), planning.getSessionId());
	assert.deepEqual(activeTools, ["delegate"]);
	assert.match(statusLines.at(-1) ?? "", /^● research · orientation  ○ plan  ○ build  ○ done$/u);
	const researchSessionPath = researchContext.sessionManager.getSessionFile();
	assert.ok(researchSessionPath);
	assert.equal(
		researchContext.sessionManager.getHeader()?.parentSession,
		planningPath,
		"research belongs to the task planning session",
	);
	assert.equal(sessionMessages.get(researchSessionPath)?.[0], "Exercise the full pipeline.");
	assert.deepEqual(
		await handlers.get("session_before_tree")?.({ preparation: {} }, researchContext),
		{ cancel: true },
		"the active research owner cannot navigate its branch",
	);
	const researchResult = (agent: "scout" | "synthesizer", output: string) => ({
		agent,
		task: "Bounded factual work.",
		output,
		stopReason: "stop",
		steps: [],
		turns: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		durationMs: 1,
	});
	for (const [toolCallId, agent, output] of [
		["orientation", "scout", "Questions"],
		["evidence", "scout", "Evidence"],
		["synthesis", "synthesizer", "## Findings\n\nPipeline evidence."],
	] as const) {
		const blocked = await handlers.get("tool_call")?.(
			{ toolName: "delegate", input: { agent }, toolCallId },
			researchContext,
		);
		assert.equal(blocked, undefined);
		if (agent === "synthesizer")
			assert.match(statusLines.at(-1) ?? "", /^● research · synthesizing  ○ plan  ○ build  ○ done$/u);
		await handlers.get("tool_execution_end")?.(
			{ toolName: "delegate", toolCallId, isError: false, result: { details: researchResult(agent, output) } },
			researchContext,
		);
	}
	const brief = "## Findings\n\nPipeline evidence.";
	assert.equal(tools.has("juruc_submit_research"), false);
	assert.equal(aborts, 1);
	assert.equal(loadTask(paths, slug).state.phase, "planning");
	assert.deepEqual(activeTools, ordinaryWithoutJuruc, "research handoff restores ordinary tools in place");
	assert.match(statusLines.at(-1) ?? "", /^✓ research  ● plan · grilling  ○ build  ○ done$/u);
	await handlers.get("agent_settled")?.({}, researchContext);
	assert.ok(currentContext);
	const plannerContext = currentContext;
	assert.equal(plannerContext.sessionManager.getSessionId(), planning.getSessionId());
	assert.deepEqual(activeTools.sort(), ["juruc_set_plan", "read"]);
	assert.match(statusLines.at(-1) ?? "", /^✓ research  ● plan · grilling  ○ build  ○ done$/u);
	assert.equal(activeTools.includes("bash"), false, "planning uses the read-only tool profile");
	assert.deepEqual(followUps, []);
	assert.match(sessionMessages.get(planningPath)?.[0] ?? "", /^Canonical grill Exercise the full pipeline\./u);
	const treeNoticesBeforeGrill = notices.length;
	assert.deepEqual(
		await handlers.get("session_before_tree")?.({ preparation: {} }, plannerContext),
		{ cancel: true },
		"the active grill owner cannot navigate its branch",
	);
	assert.equal(notices.length, treeNoticesBeforeGrill + 1);
	assert.equal(
		notices.at(-1),
		`${slug}: use /juruc to recover before navigating this active workflow`,
		"tree recovery has one concise /juruc instruction",
	);
	const planningPrompt = await handlers.get("before_agent_start")?.({
		systemPrompt: "base prompt",
		systemPromptOptions: {
			cwd: plannerContext.cwd,
			contextFiles: [
				{ path: join(plannerContext.cwd, "AGENTS.md"), content: "root contract" },
				{ path: join(plannerContext.cwd, "src", "CLAUDE.md"), content: "local contract" },
			],
		},
	}, plannerContext) as { systemPrompt?: string } | undefined;
	assert.match(planningPrompt?.systemPrompt ?? "", /Working directory: .*juruc\/worktrees\/deterministic-pipeline/u);
	assert.match(planningPrompt?.systemPrompt ?? "", /Applicable context files.*AGENTS\.md.*CLAUDE\.md/su);
	assert.doesNotMatch(planningPrompt?.systemPrompt ?? "", /root contract|local contract/u);
	const setPlan = tools.get("juruc_set_plan");
	assert.ok(setPlan);
	const beforeSiblingPlan = JSON.stringify(loadTask(paths, slug));
	assistantToolCalls(plannerContext.sessionManager, [
		{ id: "plan-sibling", name: "juruc_set_plan" },
		{ id: "plan-read-sibling", name: "read" },
	]);
	assert.deepEqual(
		await handlers.get("tool_call")?.(
			{ toolName: "juruc_set_plan", toolCallId: "plan-sibling", input: {} },
			plannerContext,
		),
		{
			block: true,
			reason: "juruc_set_plan must be the sole tool call in the current assistant message",
		},
		"a sibling read blocks plan transition authority",
	);
	assert.equal(JSON.stringify(loadTask(paths, slug)), beforeSiblingPlan, "a sibling plan call mutates nothing");
	assistantToolCalls(plannerContext.sessionManager, [{ id: "plan", name: "juruc_set_plan" }]);
	assert.equal(
		await handlers.get("tool_call")?.(
			{ toolName: "juruc_set_plan", toolCallId: "plan", input: {} },
			plannerContext,
		),
		undefined,
		"the exact sole plan call is authorized",
	);
	const submission = await setPlan.execute("plan", {
		objective: "Exercise the deterministic pipeline.",
		desiredEndState: "All three phases complete in isolated sessions.",
		constraints: [],
		assumptions: [],
		nonGoals: [],
		decisions: [],
		risks: [],
		successCriteria: ["The pipeline advances automatically."],
		futurePhases: [
			{ title: "Code change", objective: "Change a file.", successCriteria: ["The exact change is committed."] },
			{ title: "No code", objective: "Verify without changing files.", successCriteria: ["The phase completes without a commit."] },
			{ title: "Final session", objective: "Prove another fresh session starts.", successCriteria: ["P3 starts automatically."] },
		],
	}, new AbortController().signal, () => undefined, plannerContext);
	assert.equal(submission.terminate, true);
	assert.equal(loadTask(paths, slug).state.phase, "promoting");
	assert.deepEqual(activeTools, ordinaryWithoutJuruc, "plan promotion restores ordinary tools in place");
	assert.ok(
		statusLines.some((line) => line === "✓ research  ● plan · awaiting Build/Revise  ○ build  ○ done"),
		"the persisted candidate is visible before its decision",
	);
	assert.match(statusLines.at(-1) ?? "", /^✓ research  ✓ plan  ● build · P1\/3 · promoting  ○ done$/u);
	await handlers.get("agent_settled")?.({}, plannerContext);
	for (let attempt = 0; attempt < 100 && loadTask(paths, slug).state.phase !== "building"; attempt += 1)
		await new Promise((resolve) => setTimeout(resolve, 20));

	let building = loadTask(paths, slug);
	assert.equal(building.state.phase, "building", notices.join("\n"));
	if (building.state.phase !== "building") throw new Error("expected building state");
	const p1Session = building.state.phaseSession;
	assert.notDeepEqual(p1Session, building.state.planningSession);
	assert.equal(
		currentContext?.sessionManager.getHeader()?.parentSession,
		planningPath,
		"P1 belongs to the task planning session",
	);
	assert.equal(currentContext?.sessionManager.getSessionId(), p1Session.id, "the harness switched to persisted P1");
	assert.match(statusLines.at(-1) ?? "", /^✓ research  ✓ plan  ● build · P1\/3 · starting  ○ done$/u);
	assert.deepEqual(
		await handlers.get("session_before_tree")?.({ preparation: {} }, currentContext!),
		{ cancel: true },
		"the active building owner cannot navigate its branch",
	);
	assert.equal(
		notices.filter((notice) => notice === "P1 (1/3) started · Code change").length,
		1,
		"P1 has one transition notification",
	);
	assert.deepEqual(activeTools, [
		"read", "bash", "edit", "write", "grep", "find", "ls", "delegate",
		"juruc_block_phase",
	]);
	assert.equal(activeTools.includes("juruc_set_plan"), false, "building uses the exact build tool profile");
	assert.equal(tools.has("juruc_set_commit_message"), false);
	const p1Prompt = sessionMessages.get(p1Session.path)?.[0] ?? "";
	assert.match(p1Prompt, /^Build P1: Code change/u);
	assert.match(p1Prompt, /Create or edit project context only when an active criterion requires the exact change/u);
	const phaseTranscript = readFileSync(p1Session.path, "utf8");
	assert.match(phaseTranscript, /Never run git commit directly/u);
	assert.match(phaseTranscript, /return only the proposed commit message; JURUC commits mechanically/u);
	assert.doesNotMatch(phaseTranscript, /juruc_complete_phase|call juruc_set_commit_message/u);
	const syntheticSettlement = acquireSettlementLease(slug, p1Session, "committing");
	assert.ok(syntheticSettlement);
	assert.deepEqual(await handlers.get("input")?.({}, currentContext!), { action: "handled" });
	const abortsBeforeSettlementGuard = aborts;
	await handlers.get("agent_start")?.({}, currentContext!);
	assert.equal(aborts, abortsBeforeSettlementGuard + 1);
	assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "read", input: {} }, currentContext!), {
		block: true,
		reason: `${slug}: every tool is blocked while committing is settling`,
	});
	assert.deepEqual(await handlers.get("session_before_switch")?.({}, currentContext!), { cancel: true });
	await assert.rejects(commands.get("juruc")!("", currentContext!), /cannot run while deterministic-pipeline is committing/);
	const planningIdentityForTransfer = { path: planningPath, id: planning.getSessionId() };
	transferSettlementLease(syntheticSettlement, p1Session, planningIdentityForTransfer);
	assert.deepEqual(
		await handlers.get("session_before_switch")?.({ reason: "resume", targetSessionFile: planningPath }, researchContext),
		{ cancel: true },
		"a foreign source cannot consume another session's authorized target",
	);
	assert.equal(
		await handlers.get("session_before_switch")?.({ reason: "resume", targetSessionFile: planningPath }, currentContext!),
		undefined,
		"the exact authorized source passes once",
	);
	assert.deepEqual(
		await handlers.get("session_before_switch")?.({ reason: "resume", targetSessionFile: planningPath }, currentContext!),
		{ cancel: true },
		"repeated target navigation fails after one-use authorization is consumed",
	);
	releaseSettlementLease(syntheticSettlement);

	const openBuilding = "Open Deterministic pipeline — deterministic-pipeline · building";
	const amendAction = "Amend a phase — Persist an amendment; resume the active phase in its existing session.";
	selections.push(openBuilding, amendAction, "P3: Final session");
	editorValues.push("Also report that the final session received this amendment.");
	await commands.get("juruc")?.("", currentContext!);
	let amendedTask = loadTask(paths, slug);
	assert.equal(amendedTask.state.phase, "building");
	assert.deepEqual(amendedTask.plan.approved?.future[2].amendments, [
		"Also report that the final session received this amendment.",
	]);
	assert.equal(amendedTask.state.buildSessions.length, 1, "a future amendment creates no session");

	await handlers.get("tool_execution_start")?.(
		{ toolName: "delegate", args: { agent: "audit" }, toolCallId: "audit-before-amendment" },
		currentContext!,
	);
	const activeAmendment = "Also record this active amendment before implementation.";
	selections.push(openBuilding, amendAction, "P1: Code change · active");
	editorValues.push(activeAmendment);
	cancelNextSwitch = true;
	await commands.get("juruc")?.("", currentContext!);
	amendedTask = loadTask(paths, slug);
	assert.equal(amendedTask.state.phase, "amending", "interruption preserves the amendment transaction");
	assert.deepEqual(
		await handlers.get("session_before_tree")?.({ preparation: {} }, currentContext!),
		{ cancel: true },
		"the active amendment owner cannot navigate its branch",
	);
	assert.doesNotMatch(sessionMessages.get(p1Session.path)?.at(-1) ?? "", /^Authoritative human amendment for P1/u);

	selections.push("Open Deterministic pipeline — deterministic-pipeline · amending");
	await commands.get("juruc")?.("", currentContext!);
	amendedTask = loadTask(paths, slug);
	assert.equal(amendedTask.state.phase, "building");
	if (amendedTask.state.phase !== "building") throw new Error("expected amended building state");
	assert.deepEqual(amendedTask.state.phaseSession, p1Session, "active amendment reuses its exact session");
	assert.deepEqual(amendedTask.state.phaseSnapshot.amendments, [activeAmendment]);
	assert.equal(amendedTask.state.audit, null, "active amendment invalidates prior audit authority");
	assert.equal(amendedTask.state.buildSessions.length, 1, "active amendment creates no session");
	assert.match(sessionMessages.get(p1Session.path)?.at(-1) ?? "", /^Authoritative human amendment for P1 \(#1\):/u);

	selections.push(openBuilding, amendAction, "P1: Code change · active");
	editorValues.push(activeAmendment);
	await commands.get("juruc")?.("", currentContext!);
	amendedTask = loadTask(paths, slug);
	assert.equal(amendedTask.state.phase, "building");
	if (amendedTask.state.phase !== "building") throw new Error("expected twice-amended building state");
	assert.deepEqual(amendedTask.state.phaseSnapshot.amendments, [activeAmendment, activeAmendment]);
	assert.equal(amendedTask.state.buildSessions.length, 1);
	assert.match(sessionMessages.get(p1Session.path)?.at(-1) ?? "", /^Authoritative human amendment for P1 \(#2\):/u);

	assert.equal(tools.has("juruc_complete_phase"), false, "completion acknowledgement tool is deleted");
	writeFileSync(join(building.state.worktree, "rogue.txt"), "unapproved commit\n");
	assert.equal((await git(building.state.worktree, ["add", "rogue.txt"])).code, 0);
	assert.equal((await git(building.state.worktree, ["commit", "-m", "Rogue build commit"])).code, 0);
	await assert.rejects(
		async () => handlers.get("tool_execution_start")?.(
			{ toolName: "delegate", args: { agent: "audit" }, toolCallId: "audit-rogue" },
			currentContext!,
		),
		/unapproved Git commit/,
	);
	assert.equal(stateAudit(slug), null);
	assert.match(notices.at(-1) ?? "", /unapproved Git commit/u);
	assert.equal((await git(building.state.worktree, ["reset", "--hard", "HEAD^"])).code, 0);
	writeFileSync(join(building.state.worktree, "implementation.txt"), "implemented\n");
	const runResult = {
		agent: "audit",
		task: "Audit P1",
		audit: { verdict: "pass" as const, summary: "Validated the exact phase candidate." },
		output: "",
		stopReason: "stop",
		provider: "test",
		model: "test",
		steps: [{ tool: "read", detail: "implementation.txt", outcome: "ok" }],
		turns: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		durationMs: 1,
	};
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "audit-before-amendment", isError: false, result: { details: runResult } },
		currentContext!,
	);
	assert.equal(stateAudit(slug), null, "an audit started before an amendment cannot authorize the amended phase");
	assert.ok(currentContext);
	await handlers.get("tool_execution_start")?.(
		{ toolName: "delegate", args: { agent: "audit" }, toolCallId: "audit-old" },
		currentContext,
	);
	await handlers.get("tool_execution_start")?.(
		{ toolName: "delegate", args: { agent: "audit" }, toolCallId: "audit-new" },
		currentContext,
	);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "audit-old", isError: false, result: { details: runResult } },
		currentContext,
	);
	assert.equal(stateAudit(slug), null, "an older concurrent audit cannot restore invalidated evidence");
	const failedAudit = {
		...runResult,
		audit: {
			verdict: "fail" as const,
			findings: [{
				basis: { source: "phase" as const, criterion: 1 },
				path: "implementation.txt",
				evidence: "The focused check failed.",
				failure: "The active criterion is not yet satisfied.",
			}],
		},
	};
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "audit-new", isError: false, result: { details: failedAudit } },
		currentContext,
	);
	assert.equal(stateAudit(slug), null, "a failed latest audit leaves completion evidence empty");
	assert.equal(
		(await git(building.state.worktree, ["diff", "--cached", "--name-only"])).stdout.trim(),
		"",
		"failed validated audit unstages without losing implementation work",
	);
	assert.equal(readFileSync(join(building.state.worktree, "implementation.txt"), "utf8"), "implemented\n");
	const repaired = loadTask(paths, slug);
	if (repaired.state.phase !== "building") throw new Error("expected building state");
	assert.deepEqual(repaired.state.phaseSession, p1Session, "repair remains in the implementation session");
	assert.equal(
		await handlers.get("tool_call")?.(
			{ toolName: "delegate", input: { agent: "implementer" }, toolCallId: "build-helper" },
			currentContext,
		),
		undefined,
		"active builds may use any configured delegate role",
	);
	await handlers.get("tool_execution_end")?.({
		toolName: "delegate",
		toolCallId: "build-helper",
		isError: false,
		result: { details: { ...runResult, agent: "implementer", audit: undefined } },
	}, currentContext);
	assert.equal(stateAudit(slug), null, "non-audit delegates cannot authorize completion");
	await handlers.get("tool_execution_start")?.({ toolName: "delegate", args: { agent: "audit" }, toolCallId: "audit-p1" }, currentContext);
	assert.match(statusLines.at(-1) ?? "", /● build · P1\/3 · auditing/u);
	await handlers.get("tool_execution_end")?.({ toolName: "delegate", toolCallId: "audit-p1", isError: false, result: { details: runResult } }, currentContext);
	building = loadTask(paths, slug);
	assert.equal(building.state.phase, "building");
	assert.equal(building.state.audit?.kind, "phase", "terminal/phase audit evidence is persisted before staging recovery can proceed");
	const persistedAudit = JSON.stringify(building.state.audit);
	assert.equal(JSON.stringify(loadTask(paths, slug).state.audit), persistedAudit, "the audit boundary survives a fresh load");
	if (building.state.phase !== "building") throw new Error("expected building state");
	assert.deepEqual(building.state.audit?.snapshot.paths, ["implementation.txt"], "audit evidence is durable");
	assert.equal(building.state.audit?.summary, "Validated the exact phase candidate.");
	assert.deepEqual(
		await handlers.get("session_before_switch")?.({ reason: "resume", targetSessionFile: planningPath }, currentContext),
		{ cancel: true },
		"an audited exact phase session cannot navigate before settlement acquires a lease",
	);
	assert.deepEqual(await handlers.get("session_before_fork")?.({ entryId: "entry", position: "at" }, currentContext), { cancel: true });
	assert.equal(
		await handlers.get("session_before_switch")?.({ reason: "resume", targetSessionFile: building.state.phaseSession.path }, plannerContext),
		undefined,
		"recovery navigation from another session remains available",
	);
	const auditedSnapshot = building.state.audit!.snapshot;
	saveExecutionState(join(building.directory, "state.json"), stagingState(
		building.state,
		building.state.phaseSnapshot,
		building.state.phaseSession,
		building.state.audit!.summary,
		auditedSnapshot.head,
		auditedSnapshot.paths,
		auditedSnapshot.tree,
	));
	const stagedBoundary = loadTask(paths, slug);
	assert.equal(stagedBoundary.state.phase, "staging", "staging is durable before the canonical commit prompt");
	assert.equal((await git(building.state.worktree, ["diff", "--cached", "--name-only"])).stdout.trim(), "implementation.txt", "staged candidate survives the staging boundary");
	assert.deepEqual(
		await handlers.get("session_before_switch")?.({ reason: "resume", targetSessionFile: planningPath }, currentContext),
		{ cancel: true },
		"an exact staging transaction blocks preflight navigation",
	);
	assert.deepEqual(
		await handlers.get("session_before_tree")?.({ preparation: {} }, currentContext),
		{ cancel: true },
		"the active staging owner cannot navigate its branch",
	);
	saveExecutionState(join(building.directory, "state.json"), building.state);

	const phaseTools = [...activeTools];
	const openCommitting = "Open Deterministic pipeline — deterministic-pipeline · committing";
	const sendsBeforeArming = replacementSends.length;
	wrongNextReplacementIdentity = true;
	selections.push(openBuilding);
	await commands.get("juruc")?.("", plannerContext);
	assert.equal(
		loadTask(paths, slug).state.phase,
		"committing",
		"committing intent persists before switching and stays recoverable",
	);
	assert.match(notices.at(-1) ?? "", /replacement context changed/);
	assert.equal(replacementSends.length, sendsBeforeArming, "wrong replacement identity sends no canonical turn");
	pendingMessages = true;
	selections.push(openCommitting);
	await commands.get("juruc")?.("", plannerContext);
	assert.equal(loadTask(paths, slug).state.phase, "committing", "pending replacement work rejects canonical arming");
	assert.match(notices.at(-1) ?? "", /replacement context changed/);
	assert.equal(replacementSends.length, sendsBeforeArming, "pending replacement work sends no canonical turn");
	pendingMessages = false;
	selections.push(openCommitting);
	await commands.get("juruc")?.("", plannerContext);
	const armed = loadTask(paths, slug);
	assert.equal(armed.state.phase, "committing");
	if (armed.state.phase !== "committing") throw new Error("expected committing state");
	assert.equal(armed.state.commitMessage, null);
	assert.deepEqual(
		await handlers.get("session_before_switch")?.({ reason: "resume", targetSessionFile: planningPath }, currentContext),
		{ cancel: true },
		"an armed committing session cannot navigate between settlement events",
	);
	assert.deepEqual(
		await handlers.get("session_before_tree")?.({ preparation: {} }, currentContext),
		{ cancel: true },
		"the active committing owner cannot navigate its branch",
	);
	assert.deepEqual(await handlers.get("session_before_fork")?.({ entryId: "entry", position: "at" }, currentContext), { cancel: true });
	const armedState = armed.state;
	if (armedState.phase !== "committing") throw new Error("expected committing state");
	assert.ok(currentContext.sessionManager.getBranch().some((entry) => entry.id === armedState.promptBaselineEntryId), "recovery baseline remains on the active branch");
	assert.deepEqual(
		[...activeTools].sort(),
		["bash", "juruc_block_phase"],
		"the committing destination advertises no build tools during canonical wording",
	);
	assert.equal(followUps.length, 0, "explicit recovery does not use the streaming extension queue");
	assert.equal(replacementSends.length, 1, "changed audit recovery sends exactly one canonical turn");
	assert.deepEqual(replacementSends, [{
		message: {
			customType: "juruc-commit-message",
			content: [{ type: "text", text: "Return the canonical commit message.\n" }],
			display: false,
			details: { task: slug, phase: "P1", baseline: armed.state.promptBaselineEntryId },
		},
		options: { triggerTurn: true },
	}]);
	const beforeSiblingBlock = JSON.stringify(loadTask(paths, slug));
	assistantToolCalls(currentContext!.sessionManager, [
		{ id: "block-sibling", name: "juruc_block_phase" },
		{ id: "block-bash-sibling", name: "bash" },
	]);
	assert.deepEqual(
		await handlers.get("tool_call")?.(
			{ toolName: "juruc_block_phase", toolCallId: "block-sibling", input: { reason: "cancel" } },
			currentContext!,
		),
		{
			block: true,
			reason: "juruc_block_phase must be the sole tool call in the current assistant message",
		},
		"a sibling bash blocks phase transition authority",
	);
	assert.equal(JSON.stringify(loadTask(paths, slug)), beforeSiblingBlock, "a sibling block call mutates nothing");
	for (const [index, sibling] of ["read", "edit", "write", "bash", "delegate"].entries()) {
		const id = `block-sibling-${index}`;
		assistantToolCalls(currentContext!.sessionManager, [
			{ id, name: "juruc_block_phase" },
			{ id: `${id}-other`, name: sibling },
		]);
		assert.deepEqual(
			await handlers.get("tool_call")?.({ toolName: "juruc_block_phase", toolCallId: id, input: { reason: "cancel" } }, currentContext!),
			{ block: true, reason: "juruc_block_phase must be the sole tool call in the current assistant message" },
		);
	}
	assistantToolCalls(currentContext!.sessionManager, [{ id: "block", name: "juruc_block_phase" }]);
	assert.equal(await handlers.get("tool_call")?.(
		{ toolName: "juruc_block_phase", toolCallId: "block", input: { reason: "cancel" } },
		currentContext!,
	), undefined);
	const inspectionLimit = COMMIT_INSPECTION_COMMANDS.length;
	assistantToolCalls(currentContext!.sessionManager, [{ id: "timeout", name: "bash", arguments: { command: "git diff --cached", timeout: 1000 } }]);
	assert.deepEqual(
		await handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "timeout", input: { command: "git diff --cached", timeout: 1000 } }, currentContext),
		{ block: true, reason: `committing permits at most ${inspectionLimit} exact read-only Git inspection commands or juruc_block_phase` },
		"a timeout key rejects an otherwise permitted inspection command",
	);
	successfulToolResult(currentContext!.sessionManager, "timeout");
	assistantToolCalls(currentContext!.sessionManager, [{ id: "unknown", name: "bash", arguments: { command: "git diff --cached", unknownKey: true } }]);
	assert.deepEqual(
		await handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "unknown", input: { command: "git diff --cached", unknownKey: true } }, currentContext),
		{ block: true, reason: `committing permits at most ${inspectionLimit} exact read-only Git inspection commands or juruc_block_phase` },
		"an unknown key rejects an otherwise permitted inspection command",
	);
	successfulToolResult(currentContext!.sessionManager, "unknown");
	assistantToolCalls(currentContext!.sessionManager, [{ id: "inspection", name: "bash", arguments: { command: "git diff --cached" } }]);
	assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "inspection", input: { command: "git diff --cached" } }, currentContext), {
		block: true,
		reason: `committing permits at most ${inspectionLimit} exact read-only Git inspection commands or juruc_block_phase`,
	}, "a malformed prior suffix fails closed for later inspection calls");
	await handlers.get("message_start")?.({ message: { role: "custom", customType: "other", content: "context" } }, currentContext);
	assistantToolCalls(currentContext!.sessionManager, [{ id: "contextual", name: "bash", arguments: { command: "git diff --cached --stat" } }]);
	assert.deepEqual(
		await handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "contextual", input: { command: "git diff --cached --stat" } }, currentContext),
		{
			block: true,
			reason: `committing permits at most ${inspectionLimit} exact read-only Git inspection commands or juruc_block_phase`,
		},
		"contextual committing activity disarms transient inspection authorization",
	);
	assistantToolCalls(currentContext!.sessionManager, [{ id: "status", name: "bash", arguments: { command: "git status" } }]);
	assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "status", input: { command: "git status" } }, currentContext), {
		block: true,
		reason: `committing permits at most ${inspectionLimit} exact read-only Git inspection commands or juruc_block_phase`,
	});
	const stagedBeforeInvalidBlock = (await git(building.state.worktree, ["diff", "--cached", "--name-only"])).stdout;
	await assert.rejects(
		tools.get("juruc_block_phase")!.execute("invalid-block", { reason: "   " }, new AbortController().signal, () => undefined, currentContext),
		/block reason must be nonempty/,
	);
	assert.equal((await git(building.state.worktree, ["diff", "--cached", "--name-only"])).stdout, stagedBeforeInvalidBlock, "invalid block reason causes no Git effect");
	assert.equal(loadTask(paths, slug).state.phase, "committing");
	const absentTask = loadTask(paths, slug);
	assert.equal(absentTask.state.phase, "committing");
	if (absentTask.state.phase !== "committing") throw new Error("expected absent committing state");
	saveExecutionState(
		join(absentTask.directory, "state.json"),
		committingBaselineState(absentTask.state, currentContext.sessionManager.getLeafId()!),
	);
	const warningsBeforeAbsent = notices.filter((notice) => /Canonical commit-message response is absent/.test(notice)).length;
	await handlers.get("agent_settled")?.({}, currentContext);
	await handlers.get("agent_settled")?.({}, currentContext);
	assert.equal(
		notices.filter((notice) => /Canonical commit-message response is absent/.test(notice)).length,
		warningsBeforeAbsent,
		"contextual activity clears recognition instead of trusting an absent suffix",
	);
	selections.push("Open Deterministic pipeline — deterministic-pipeline · committing");
	await commands.get("juruc")?.("", plannerContext);
	assert.equal(replacementSends.length, 2, "explicit absent recovery resends one canonical prompt");
	currentContext.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "   " }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const warningsBeforeIncomplete = notices.filter((notice) => /Canonical commit-message response is invalid/.test(notice)).length;
	await handlers.get("agent_settled")?.({}, currentContext);
	await handlers.get("agent_settled")?.({}, currentContext);
	assert.equal(
		notices.filter((notice) => /Canonical commit-message response is invalid/.test(notice)).length,
		warningsBeforeIncomplete + 1,
		"recognized canonical turn rejects an invalid suffix",
	);
	const beforeIncompleteRetry = loadTask(paths, slug);
	assert.equal(beforeIncompleteRetry.state.phase, "committing");
	if (beforeIncompleteRetry.state.phase !== "committing") throw new Error("expected incomplete committing state");
	const initialPromptBaseline = beforeIncompleteRetry.state.promptBaselineEntryId;
	selections.push("Open Deterministic pipeline — deterministic-pipeline · committing");
	await commands.get("juruc")?.("", plannerContext);
	const retried = loadTask(paths, slug);
	assert.equal(retried.state.phase, "committing");
	if (retried.state.phase !== "committing") throw new Error("expected retried committing state");
	assert.notEqual(retried.state.promptBaselineEntryId, initialPromptBaseline, "explicit incomplete recovery rebaselines");
	assert.equal(replacementSends.length, 3, "explicit incomplete recovery awaits one replacement prompt");
	const responseEntryId = currentContext.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Implement exact pipeline change" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const receiptTask = loadTask(paths, slug);
	assert.equal(receiptTask.state.phase, "committing");
	if (receiptTask.state.phase !== "committing") throw new Error("expected committing receipt state");
	saveExecutionState(join(receiptTask.directory, "state.json"), committingMessageState(receiptTask.state, {
		responseEntryId,
		text: "Implement exact pipeline change",
	}));
	const wordingBoundary = loadTask(paths, slug);
	assert.equal(wordingBoundary.state.phase, "committing", "wording receipt is durable before Git commit");
	assert.equal(wordingBoundary.state.commitMessage?.text, "Implement exact pipeline change");
	assert.equal((await git(building.state.worktree, ["commit", "--cleanup=verbatim", "-m", "Wrong external wording"])).code, 0);
	selections.push("Open Deterministic pipeline — deterministic-pipeline · committing");
	await commands.get("juruc")?.("", plannerContext);
	assert.equal(loadTask(paths, slug).state.phase, "committing", "unauthorized exact child is not adopted through /juruc");
	assert.match(notices.at(-1) ?? "", /committed message differs from approved message/);
	assert.equal((await git(building.state.worktree, ["reset", "--soft", armed.state.parent])).code, 0);
	assert.equal((await git(building.state.worktree, ["commit", "--cleanup=verbatim", "-m", "Implement exact pipeline change"])).code, 0);
	const commitBeforePlan = (await git(building.state.worktree, ["rev-parse", "HEAD"])).stdout.trim();
	const beforePlanCompletion = loadTask(paths, slug);
	assert.equal(beforePlanCompletion.plan.approved?.completed[0]?.commit, undefined, "plan completion is not written before the commit boundary");
	assert.equal((await git(building.state.worktree, ["rev-parse", "HEAD"])).stdout.trim(), commitBeforePlan);
	const handoffInputIndex = switchInputResults.length;
	const handoffStartIndex = sendUserAgentStartAborts.length;
	selections.push("Open Deterministic pipeline — deterministic-pipeline · committing");
	await commands.get("juruc")?.("", plannerContext);
	const commit = (await git(building.state.worktree, ["rev-parse", "HEAD"])).stdout.trim();
	assert.match(commit, /^[0-9a-f]{40,64}$/u);
	assert.equal((await git(building.state.worktree, ["log", "-1", "--format=%s"])).stdout.trim(), "Implement exact pipeline change");
	let afterCommit = loadTask(paths, slug);
	assert.deepEqual(activeTools, phaseTools, "settlement installs the next phase's stable profile after handoff");
	assert.equal(afterCommit.plan.approved?.completed[0].status, "completed");
	assert.equal(afterCommit.plan.approved?.completed[0].commit, commit);
	assert.equal(afterCommit.state.phase, "building", "plan completion is durable before any terminal acceptance receipt");
	assert.equal(afterCommit.state.acceptance, undefined, "non-terminal plan completion has no acceptance receipt");
	const commitsAfterSettlement = (await git(building.state.worktree, ["rev-list", "--count", "HEAD"])).stdout.trim();
	await handlers.get("agent_settled")?.({}, currentContext);
	assert.equal((await git(building.state.worktree, ["rev-list", "--count", "HEAD"])).stdout.trim(), commitsAfterSettlement, "duplicate settlement cannot create another commit");

	let p2 = loadTask(paths, slug);
	assert.equal(p2.state.phase, "building", notices.join("\n"));
	if (p2.state.phase !== "building") throw new Error("expected P2 building state");
	assert.equal(p2.state.phaseSnapshot.id, "P2");
	assert.notDeepEqual(p2.state.phaseSession, p1Session);
	assert.notDeepEqual(p2.state.phaseSession, p2.state.planningSession);
	assert.equal(
		currentContext?.sessionManager.getHeader()?.parentSession,
		p1Session.path,
		"later phase sessions form one task branch",
	);
	assert.equal(currentContext?.sessionManager.getSessionId(), p2.state.phaseSession.id);
	assert.deepEqual(
		switchInputResults.slice(handoffInputIndex),
		[{ action: "handled" }, { action: "handled" }],
		"settlement first enters the exact phase owner, then switches to the next owner",
	);
	assert.deepEqual(
		sendUserAgentStartAborts.slice(handoffStartIndex),
		[0],
		"the transferred lease releases immediately before the intentional build prompt starts",
	);
	assert.equal(settlementLease(), undefined, "next-phase handoff releases settlement before the model run");
	assert.equal(
		notices.filter((notice) => notice === `P1 (1/3) committed ${commit.slice(0, 7)} · P2 (2/3) started · No code`).length,
		1,
		"the committed phase handoff has one transition notification",
	);

	await currentContext!.switchSession(p1Session.path);
	assert.ok(currentContext);
	assert.equal(activeTools.some((name) => name.startsWith("juruc_")), false);
	assert.ok(activeTools.includes("delegate") && activeTools.includes("web_search"));
	assert.equal(tools.has("juruc_complete_phase"), false);
	assert.equal(
		await handlers.get("session_before_tree")?.({ preparation: {} }, currentContext),
		undefined,
		"historical sessions remain tree-navigable",
	);
	const staleDelegate = await handlers.get("tool_call")?.(
		{ toolName: "delegate", input: { agent: "scout" } },
		currentContext,
	);
	assert.equal(staleDelegate, undefined, "historical sessions use ordinary delegate behavior");
	assert.equal(
		await handlers.get("tool_call")?.({ toolName: "delegate", input: { agent: "audit" } }, currentContext),
		undefined,
		"historical audit delegates retain the ordinary tool-call result",
	);
	const historicalState = JSON.stringify(loadTask(paths, slug).state);
	const historicalIndex = (await git(p2.state.worktree, ["diff", "--cached", "--name-only"])).stdout;
	const historicalNotices = notices.length;
	const historicalStatuses = statusLines.length;
	await handlers.get("tool_execution_start")?.(
		{ toolName: "delegate", args: { agent: "audit" }, toolCallId: "historical-audit" },
		currentContext,
	);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "historical-audit", isError: false, result: runResult },
		currentContext,
	);
	assert.equal(JSON.stringify(loadTask(paths, slug).state), historicalState, "historical audit observation does not change JURUC state");
	assert.equal(notices.length, historicalNotices, "historical audit observation emits no notification");
	assert.equal(statusLines.length, historicalStatuses, "historical audit observation creates no tracking");
	assert.equal((await git(p2.state.worktree, ["diff", "--cached", "--name-only"])).stdout, historicalIndex, "historical audit observation does not stage");
	await currentContext!.switchSession(p2.state.phaseSession.path);
	selections.push(
		openBuilding,
		"Resume the active phase — Continue the interrupted build in its owning session.",
	);
	await commands.get("juruc")?.("", currentContext!);

	const nonTerminalAuditInput: Record<string, unknown> = { agent: "audit", task: "model supplied omission" };
	assistantToolCalls(currentContext!.sessionManager, [{ id: "audit-p2", name: "delegate", arguments: nonTerminalAuditInput }]);
	assert.equal(await handlers.get("tool_call")?.({ toolName: "delegate", input: nonTerminalAuditInput, toolCallId: "audit-p2" }, currentContext!), undefined);
	const nonTerminalAuditLines = String(nonTerminalAuditInput.task).split("\n");
	assert.equal(nonTerminalAuditLines[1], "Judge only the exact proposed staged Git candidate; do not modify the worktree or index.");
	assert.equal(nonTerminalAuditLines.at(-3), "Required finding bases: phase criterion N or governing context path/rule.");
	assert.equal(nonTerminalAuditLines.at(-2), "Report exactly one schema-valid JSON object. Findings must contain only basis, path, evidence, and failure.");
	assert.equal(nonTerminalAuditLines.at(-1), "Pass only when every applicable criterion is satisfied; fail with every concrete blocker otherwise.");
	assert.equal(nonTerminalAuditLines.includes("Required phase evidence command: git diff --cached HEAD --"), true);
	assert.doesNotMatch(String(nonTerminalAuditInput.task), /\\\\n/u);
	assert.doesNotMatch(String(nonTerminalAuditInput.task), /Overall criteria:/u);
	assert.equal(nonTerminalAuditInput.auditBaseRef, undefined);
	await handlers.get("tool_execution_start")?.({ toolName: "delegate", args: nonTerminalAuditInput, toolCallId: "audit-p2" }, currentContext!);
	await handlers.get("tool_execution_end")?.({ toolName: "delegate", toolCallId: "audit-p2", isError: false, result: runResult }, currentContext!);
	p2 = loadTask(paths, slug);
	assert.equal(p2.state.phase, "building");
	if (p2.state.phase !== "building") throw new Error("expected P2 building state");
	assert.deepEqual(p2.state.audit?.snapshot.paths, []);
	assert.equal(p2.state.audit?.summary, "Validated the exact phase candidate.");
	await handlers.get("message_start")?.({ message: { role: "custom", customType: "other", content: "context" } }, currentContext!);
	assert.equal(stateAudit(slug), null, "contextual continuation clears provisional audit authority");
	await handlers.get("tool_execution_start")?.({ toolName: "delegate", args: { agent: "audit" }, toolCallId: "audit-p2-stale" }, currentContext!);
	await handlers.get("tool_execution_end")?.({ toolName: "delegate", toolCallId: "audit-p2-stale", isError: false, result: runResult }, currentContext!);
	writeFileSync(join(p2.state.worktree, "late.txt"), "late mutation\n");
	selections.push(openBuilding);
	await commands.get("juruc")?.("", plannerContext);
	assert.equal(stateAudit(slug), null, "stale durable audit recovery clears authority safely");
	rmSync(join(p2.state.worktree, "late.txt"));
	await handlers.get("tool_execution_start")?.({ toolName: "delegate", args: { agent: "audit" }, toolCallId: "audit-p2-final" }, currentContext!);
	await handlers.get("tool_execution_end")?.({ toolName: "delegate", toolCallId: "audit-p2-final", isError: false, result: runResult }, currentContext!);
	const turnsBeforeNoCodeRecovery = replacementSends.length;
	selections.push(openBuilding);
	await commands.get("juruc")?.("", plannerContext);
	assert.equal(replacementSends.length, turnsBeforeNoCodeRecovery, "no-code audit recovery starts no model turn");
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const value = loadTask(paths, slug);
		if (value.state.phase === "building" && value.state.phaseSnapshot.id === "P3") break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const p3 = loadTask(paths, slug);
	assert.equal(p3.state.phase, "building", notices.join("\n"));
	if (p3.state.phase !== "building") throw new Error("expected P3 building state");
	assert.equal(p3.state.phaseSnapshot.id, "P3");
	assert.notDeepEqual(p3.state.phaseSession, p2.state.phaseSession);
	assert.notDeepEqual(p3.state.phaseSession, p1Session);
	assert.notDeepEqual(p3.state.phaseSession, p3.state.planningSession);
	assert.equal(currentContext?.sessionManager.getSessionId(), p3.state.phaseSession.id);
	assert.equal(
		notices.filter((notice) => notice === "P2 (2/3) completed without commit · P3 (3/3) started · Final session").length,
		1,
		"the no-code phase handoff has one transition notification",
	);
	assert.equal(readFileSync(join(p3.state.worktree, "implementation.txt"), "utf8"), "implemented\n");
	const finalBuildPrompt = sessionMessages.get(p3.state.phaseSession.path)?.[0] ?? "";
	assert.match(finalBuildPrompt, /Human amendments \(authoritative, in order\):\n- Also report that the final session received this amendment\./u);
	assert.match(finalBuildPrompt, /Terminal combined audit: this is the unchanged final pending phase/u);
	assert.match(finalBuildPrompt, /git diff --cached HEAD --/u);
	assert.match(finalBuildPrompt, /git diff --cached [0-9a-f]+ --/u);

	const terminalAuditInput: Record<string, unknown> = { agent: "audit", task: "model supplied omission" };
	assistantToolCalls(currentContext!.sessionManager, [{ id: "audit-p3", name: "delegate", arguments: terminalAuditInput }]);
	assert.equal(await handlers.get("tool_call")?.({ toolName: "delegate", input: terminalAuditInput, toolCallId: "audit-p3" }, currentContext!), undefined);
	const terminalAuditLines = String(terminalAuditInput.task).split("\n");
	assert.equal(terminalAuditLines[1], "Judge only the exact proposed staged Git candidate; do not modify the worktree or index.");
	assert.equal(terminalAuditLines.includes(`Required overall evidence command: git diff --cached ${p3.state.sourceHead} --`), true);
	assert.equal(terminalAuditLines.includes("Required finding bases: phase criterion N, overall criterion N, or governing context path/rule."), true);
	assert.equal(terminalAuditLines.includes("Overall criteria:"), true);
	assert.doesNotMatch(String(terminalAuditInput.task), /\\\\n/u);
	assert.equal(terminalAuditInput.auditBaseRef, p3.state.sourceHead);
	await handlers.get("tool_execution_start")?.(
		{ toolName: "delegate", args: terminalAuditInput, toolCallId: "audit-p3" },
		currentContext!,
	);
	await handlers.get("tool_execution_end")?.(
		{ toolName: "delegate", toolCallId: "audit-p3", isError: false, result: runResult },
		currentContext!,
	);
	const terminalBoundary = loadTask(paths, slug);
	assert.equal(terminalBoundary.state.phase, "building", "terminal audit remains durable before acceptance recovery");
	assert.equal(terminalBoundary.state.audit?.kind, "terminal", "terminal audit is persisted before the accepting boundary");
	const terminalAuditReceipt = JSON.stringify(terminalBoundary.state.audit);
	await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, currentContext!);
	assert.equal(JSON.stringify(loadTask(paths, slug).state.audit), terminalAuditReceipt, "repeated audit settlement does not duplicate or replace terminal evidence");
	const planningTurnsBeforeReturn = sessionMessages.get(planningPath)?.length ?? 0;
	const finalHandoffInputIndex = switchInputResults.length;
	await handlers.get("agent_settled")?.({}, currentContext!);
	const acceptedBeforeHandoff = loadTask(paths, slug);
	assert.equal(acceptedBeforeHandoff.state.phase, "done");
	assert.ok(acceptedBeforeHandoff.state.acceptance, "acceptance receipt is durable before planning handoff");
	const handoffNotices = notices.filter((notice) => notice === "Done · 3/3 phases completed · returned to planning").length;
	const planningTurnsAfterHandoff = sessionMessages.get(planningPath)?.length ?? 0;
	await handlers.get("agent_settled")?.({}, currentContext!);
	assert.equal(loadTask(paths, slug).state.phase, "done", "repeated acceptance recovery remains done");
	assert.equal(notices.filter((notice) => notice === "Done · 3/3 phases completed · returned to planning").length, handoffNotices, "repeated acceptance recovery emits no duplicate handoff");
	assert.equal(sessionMessages.get(planningPath)?.length ?? 0, planningTurnsAfterHandoff, "repeated acceptance recovery starts no planning model turn");
	assert.deepEqual(activeTools, ordinaryWithoutJuruc, "completion restores ordinary tools in place");
	assert.equal(
		currentContext?.sessionManager.getSessionId(),
		planning.getSessionId(),
		"final completion returns to the persistent planning session",
	);
	assert.equal(
		notices.filter((notice) => notice === "Done · 3/3 phases completed · returned to planning").length,
		1,
		"final completion emits exactly one transition notification",
	);
	assert.match(
		notices.at(-1) ?? "",
		/^Accepted \(clear; current base; clean\) — Deterministic pipeline:/u,
		"final planning return shows the concise derived readiness result",
	);
	assert.equal(
		sessionMessages.get(planningPath)?.length ?? 0,
		planningTurnsBeforeReturn,
		"returning to planning starts no model turn",
	);
	assert.equal(activeTools.some((name) => name.startsWith("juruc_")), false);
	assert.deepEqual(switchInputResults.slice(finalHandoffInputIndex), [{ action: "handled" }], "final planning target stays excluded through validated switch completion");
	assert.equal(settlementLease(), undefined, "final handoff releases settlement after the planning switch");
	assert.equal(
		await handlers.get("session_before_tree")?.({ preparation: {} }, currentContext!),
		undefined,
		"completed sessions remain tree-navigable",
	);
	assert.match(statusLines.at(-1) ?? "", /^✓ research  ✓ plan  ✓ build  ✓ done · 3\/3$/u);
	const planningIdentity = { path: planningPath, id: planning.getSessionId() };
	assert.ok(acquireSettlementLease(slug, planningIdentity, "recovery"));
	await handlers.get("session_shutdown")?.({ reason: "reload" }, currentContext!);
	assert.equal(settlementLease(), undefined, "reload clears the matching process-global settlement lease");
	const resumedLease = acquireSettlementLease(slug, planningIdentity, "recovery");
	assert.ok(resumedLease);
	for (const reason of ["new", "resume", "fork"])
		await handlers.get("session_shutdown")?.({ reason }, currentContext!);
	assert.ok(settlementLease(), "new/resume/fork replacement preserves a spanning settlement lease");
	releaseSettlementLease(resumedLease);
	assert.ok(acquireSettlementLease(slug, planningIdentity, "recovery"));
	await handlers.get("session_shutdown")?.({ reason: "quit" }, currentContext!);
	assert.equal(settlementLease(), undefined, "quit clears the matching process-global settlement lease");

	console.log("juruc deterministic end-to-end pipeline: ok");
} finally {
	cleanup();
}
