import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const COMMAND = "autosearch";
const FINISH_TOOL = "finish_autosearch";
const STATUS = "autosearch";

const FINISH_PARAMETERS = Type.Object({
	outcome: StringEnum(["done", "blocked"] as const, {
		description: "Whether the objective was verified or the search is blocked",
	}),
	evidence: Type.String({
		minLength: 1,
		description: "Verifier evidence for completion, or the exact blocker",
	}),
}, { additionalProperties: false });

interface Activity {
	startedAt: number;
	passes: number;
	turns: number;
	tools: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

interface PendingSearch {
	phase: "pending";
	objective: string;
	prompt: string;
}

interface ActiveSearch {
	phase: "active";
	objective: string;
	delegated: boolean;
	failure?: string;
	terminal?: { reason?: string; error?: string };
}

type Search = PendingSearch | ActiveSearch | undefined;

function formatCount(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}m`;
}

function counted(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDuration(startedAt: number): string {
	const seconds = Math.floor((Date.now() - startedAt) / 1_000);
	if (seconds < 1) return "<1s";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function instructions(systemPrompt: string, objective: string): string {
	return `${systemPrompt}\n\n## Autosearch

Objective:
${objective}

Advance this objective autonomously as the parent overseer.
- One dispatched autosearch prompt is one pass.
- Choose one bounded child task and call delegate exactly once with a fresh agent, never a runId. Select the role from the task and provide a complete brief.
- Do not edit, write, or otherwise mutate project files yourself. Delegate every mutation to an implementer child.
- After the child returns, inspect authoritative project evidence read-only and run only the objective's stated verifier.
- If the objective remains open, end normally with a concise pass result. Autosearch will start the next pass.
- A rejected hypothesis is evidence, not a blocker. Change hypothesis family when repeated tuning stalls.
- A child execution failure, unavailable verifier, required-operation failure, review finding, or reported blocker remains unresolved until authoritative evidence clears it. Never retry an operational failure.
- Any project mutation invalidates earlier completion evidence. After the last mutation, use a fresh non-mutating verification child in a later pass.
- Do not weaken constraints, invent success, use fallback behavior, or finish with unresolved evidence.
- Call ${FINISH_TOOL} alone with outcome "done" only in that final verification pass, after its child reports success and the stated verifier passes.
- Call ${FINISH_TOOL} alone with outcome "blocked" and exact evidence when the objective cannot be met, the verifier cannot run, or a required operation fails.`;
}

export default function autosearch(pi: ExtensionAPI) {
	let search: Search;
	let activity: Activity = {
		startedAt: 0,
		passes: 0,
		turns: 0,
		tools: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
	};

	function activeSearch(): ActiveSearch | undefined {
		return search?.phase === "active" ? search : undefined;
	}

	function addUsage(usage: Usage | undefined): void {
		if (usage === undefined) return;
		activity.inputTokens += usage.input;
		activity.outputTokens += usage.output;
		activity.cost += usage.cost.total;
	}

	function stats(): string {
		return `parent ${counted(activity.passes, "pass")} · ${counted(activity.turns, "turn")} · ` +
			`${counted(activity.tools, "work tool")} · ${formatDuration(activity.startedAt)} · ` +
			`usage incl. nested ${formatCount(activity.inputTokens)} in / ${formatCount(activity.outputTokens)} out · ` +
			`$${activity.cost.toFixed(3)}`;
	}

	function disableFinishTool(): void {
		const tools = pi.getActiveTools();
		if (tools.includes(FINISH_TOOL)) pi.setActiveTools(tools.filter((name) => name !== FINISH_TOOL));
	}

	function stop(ctx: ExtensionContext): void {
		search = undefined;
		ctx.ui.setStatus(STATUS, undefined);
		disableFinishTool();
	}

	function assertSolitaryFinish(toolCallId: string, ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getBranch().toReversed()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const calls = entry.message.content.filter((part) => part.type === "toolCall");
			if (!calls.some((call) => call.id === toolCallId)) continue;
			if (calls.length !== 1) throw new Error(`${FINISH_TOOL} must be called alone`);
			return;
		}
		throw new Error(`Could not find ${FINISH_TOOL} call ${toolCallId} in the session`);
	}

	pi.registerTool({
		name: FINISH_TOOL,
		label: "Finish Autosearch",
		description:
			"End autosearch after a verification pass proves success or an exact blocker. Never finish with unresolved evidence. Call alone.",
		parameters: FINISH_PARAMETERS,
		executionMode: "sequential",
		async execute(toolCallId, { outcome, evidence }, _signal, _onUpdate, ctx) {
			const active = activeSearch();
			if (active === undefined) throw new Error("No autosearch is active");
			if (!active.delegated) throw new Error("Autosearch requires exactly one fresh child per pass");
			if (outcome === "done" && active.failure !== undefined) throw new Error(active.failure);
			const result = evidence.trim();
			if (!result) throw new Error("Autosearch evidence must not be blank");
			assertSolitaryFinish(toolCallId, ctx);

			const summary = `Autosearch ${outcome === "done" ? "complete" : "blocked"}.\n\n` +
				`Objective: ${active.objective}\n\nEvidence: ${result}\n\nStats: ${stats()}`;
			stop(ctx);
			return {
				content: [{ type: "text", text: summary }],
				details: { outcome, evidence: result },
				terminate: true,
			};
		},
	});

	pi.registerCommand(COMMAND, {
		description: "Advance one objective autonomously until verified, blocked, aborted, or errored",
		handler: async (args, ctx) => {
			if (search?.phase === "active") throw new Error("Autosearch is already active in this Pi session");
			search = undefined;
			if (ctx.mode !== "tui") throw new Error("Autosearch requires interactive TUI mode");
			if (!ctx.isIdle()) throw new Error("Cannot start autosearch while the agent is busy");

			const objective = args.trim();
			if (!objective) throw new Error(`Usage: /${COMMAND} <objective>`);
			if (!pi.getAllTools().some((tool) => tool.name === FINISH_TOOL)) {
				throw new Error(`${FINISH_TOOL} is excluded by the active tool filters`);
			}

			activity = {
				startedAt: Date.now(),
				passes: 0,
				turns: 0,
				tools: 0,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			};
			const prompt = `Autosearch objective:\n\n${objective}`;
			search = { phase: "pending", objective, prompt };
			pi.sendUserMessage(prompt);
		},
	});

	pi.on("session_start", disableFinishTool);

	pi.on("before_agent_start", (event, ctx) => {
		if (search?.phase !== "pending" || event.prompt !== search.prompt) return;
		const { objective } = search;
		search = { phase: "active", objective, delegated: false };
		activity.passes++;

		const tools = pi.getActiveTools();
		if (!tools.includes(FINISH_TOOL)) pi.setActiveTools([...tools, FINISH_TOOL]);
		ctx.ui.setStatus(STATUS, `autosearch · pass ${activity.passes}`);
		return { systemPrompt: instructions(event.systemPrompt, objective) };
	});

	pi.on("turn_start", (event, ctx) => {
		if (activeSearch() === undefined) return;
		activity.turns++;
		ctx.ui.setStatus(STATUS, `autosearch · pass ${activity.passes} · turn ${event.turnIndex + 1}`);
	});

	pi.on("tool_call", (event) => {
		const active = activeSearch();
		if (active === undefined || event.toolName !== "delegate") return;
		if (active.failure !== undefined) return { block: true, reason: active.failure, terminate: true };
		if (event.input.runId !== undefined) {
			active.failure = "Autosearch child passes must start fresh";
			return { block: true, reason: active.failure, terminate: true };
		}
		if (active.delegated) {
			active.failure = "Autosearch permits exactly one child per pass";
			return { block: true, reason: active.failure, terminate: true };
		}
		active.delegated = true;
	});

	pi.on("tool_execution_start", (event) => {
		if (activeSearch() !== undefined && event.toolName !== FINISH_TOOL) activity.tools++;
	});

	pi.on("tool_execution_end", (event) => {
		const active = activeSearch();
		if (active !== undefined && event.toolName === "delegate" && event.isError) {
			active.failure ??= "Autosearch child execution failed";
		}
	});

	pi.on("message_end", (event) => {
		if (activeSearch() === undefined) return;
		if (event.message.role === "assistant" || event.message.role === "toolResult") addUsage(event.message.usage);
	});

	pi.on("session_compact", (event) => {
		if (activeSearch() !== undefined) addUsage(event.compactionEntry.usage);
	});

	pi.on("agent_end", (event) => {
		const active = activeSearch();
		if (active === undefined) return;
		const assistant = event.messages.findLast((message) => message.role === "assistant");
		active.terminal = { reason: assistant?.stopReason, error: assistant?.errorMessage };
	});

	pi.on("agent_settled", (_event, ctx) => {
		const active = activeSearch();
		if (active === undefined) return;
		const { reason, error } = active.terminal ?? {};

		if (reason !== "stop" || !active.delegated || active.failure !== undefined) {
			const message = error ?? active.failure ??
				(reason && reason !== "stop"
					? `Agent stopped with reason: ${reason}`
					: reason === "stop"
						? "Autosearch pass did not run exactly one fresh child"
						: "Agent settled without an assistant result");
			const interrupted = reason === "aborted";
			const finalStats = stats();
			stop(ctx);
			ctx.ui.notify(`Autosearch stopped: ${message} · ${finalStats}`, interrupted ? "warning" : "error");
			return;
		}

		const { objective } = active;
		stop(ctx);
		const prompt = `Continue autosearch with one bounded pass toward this objective:\n\n${objective}`;
		search = { phase: "pending", objective, prompt };
		pi.sendUserMessage(prompt);
	});

	pi.on("session_shutdown", (_event, ctx) => stop(ctx));
}
