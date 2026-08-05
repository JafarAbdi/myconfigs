/**
 * Open pi in another wezterm pane: `/wclone` continues this conversation, `/wnew` starts a fresh
 * one. Both leave the current session running and inherit its cwd, session dir, and agent dir.
 *
 * `/wclone` differs from pi's own `/clone`, which replaces the current session in place. The copy
 * is written by a *detached* SessionManager opened on the same file: `createBranchedSession`
 * retargets that instance's own `sessionFile` before writing, so the live session file is never
 * rewritten. It also copies only the root-to-leaf path, which is why `pi --fork` is not usable
 * here — `forkFrom` copies every branch of the source file.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const EXEC_TIMEOUT_MS = 5_000;
const SPLIT_PERCENT = "50";

interface Placement {
	/** `wezterm cli` subcommand and direction flags. */
	target: string[];
	/** Whether the new pane owns its tab. A split shares this pane's tab, so it must not retitle it. */
	ownTab: boolean;
	description: string;
}

/**
 * The one list: what `/wclone <tab>` completes to, and what both handlers accept.
 *
 * TODO: `split-pane --top-level` splits the whole window rather than the active pane. It is left
 * out because it is a modifier, not a direction — carrying it would mean either four more entries
 * or a second argument — and because it is a no-op whenever the tab holds a single pane, which is
 * the usual case here. Worth adding as a trailing word (`/wclone right wide`) if pi routinely
 * shares a tab, where splitting the window beats carving up pi's own pane.
 */
const PLACEMENTS: Record<string, Placement> = {
	tab: { target: ["spawn"], ownTab: true, description: "New tab (default)" },
	window: { target: ["spawn", "--new-window"], ownTab: true, description: "New window" },
	right: { target: ["split-pane", "--right"], ownTab: false, description: "Split right" },
	left: { target: ["split-pane", "--left"], ownTab: false, description: "Split left" },
	up: { target: ["split-pane", "--top"], ownTab: false, description: "Split up" },
	down: { target: ["split-pane", "--bottom"], ownTab: false, description: "Split down" },
};
const DEFAULT_PLACEMENT = "tab";

function completePlacement(prefix: string): AutocompleteItem[] | null {
	const matches = Object.entries(PLACEMENTS)
		.filter(([name]) => name.startsWith(prefix))
		.map(([name, placement]) => ({
			value: name,
			label: name,
			description: placement.description,
		}));
	return matches.length > 0 ? matches : null;
}

/**
 * How to start pi in the pane. Not `"pi"` from PATH: the mux server spawns the pane with its own
 * environment, and this pi is reached through a per-shell fnm dir under /run/user that the mux
 * server has no reason to share. The running process already knows which pi it is — argv[1] is the
 * entry script under node or bun, and is absent for a compiled binary, where execPath is pi itself.
 */
function piInvocation(): string[] {
	const script = process.argv[1];
	return script && existsSync(script) ? [process.execPath, script] : [process.execPath];
}

/** POSIX single-quote escaping. Also correct in fish, where `\'` outside quotes is a literal quote. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * What the pane runs. Two things the pane cannot inherit on its own:
 *
 * The pane's process is its lifetime, so running pi directly means the pane dies with it. Going
 * through the shell leaves a prompt behind on exit or crash, in the session's cwd.
 *
 * The mux server spawns the pane with its own environment, so the agent dir is re-resolved from
 * scratch there. `--session-dir` pins session storage; the agent dir has no flag, so it is
 * forwarded as an env var — read off this process rather than by name, since the name is derived
 * from a package config key (`PI_`, `TAU_`, …) that no export makes available.
 */
export function paneCommand(
	invocation: string[],
	sessionArgs: string[],
	sessionDir: string,
	shell: string,
	agentDirEnv: [string, string] | undefined,
): string[] {
	const parts = [...invocation, ...sessionArgs, "--session-dir", sessionDir];
	if (agentDirEnv) parts.unshift("env", `${agentDirEnv[0]}=${agentDirEnv[1]}`);
	return [shell, "-c", `${parts.map(shellQuote).join(" ")}; exec ${shellQuote(shell)}`];
}

/** The `wezterm cli` argv, kept pure so the shape can be checked without a running mux. */
export function paneArgs(
	placement: Placement,
	paneId: string,
	cwd: string,
	command: string[],
): string[] {
	const percent = placement.target[0] === "split-pane" ? ["--percent", SPLIT_PERCENT] : [];
	return [
		"cli",
		...placement.target,
		...percent,
		"--pane-id",
		paneId,
		"--cwd",
		cwd,
		"--",
		...command,
	];
}

/**
 * Fail before any work: a missing pane or a typo'd placement should not leave a stray session file
 * behind, so both are settled before `/wclone` writes anything.
 */
function preparePane(
	args: string,
	ctx: ExtensionCommandContext,
): { paneId: string; name: string; placement: Placement } | undefined {
	const paneId = process.env.WEZTERM_PANE;
	if (!paneId) {
		ctx.ui.notify("WEZTERM_PANE is unset; not running directly inside a wezterm pane", "error");
		return undefined;
	}
	const name = args.trim() || DEFAULT_PLACEMENT;
	const placement = PLACEMENTS[name];
	if (!placement) {
		const known = Object.keys(PLACEMENTS).join(", ");
		ctx.ui.notify(`Unknown placement '${name}'; use one of: ${known}`, "error");
		return undefined;
	}
	return { paneId, name, placement };
}

async function openPane(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	pane: { paneId: string; name: string; placement: Placement },
	sessionArgs: string[],
	title: string,
): Promise<void> {
	const command = paneCommand(
		piInvocation(),
		sessionArgs,
		ctx.sessionManager.getSessionDir(),
		process.env.SHELL || "/bin/sh",
		Object.entries(process.env).find(
			(entry): entry is [string, string] =>
				entry[0].endsWith("_CODING_AGENT_DIR") && entry[1] !== undefined,
		),
	);
	const spawned = await pi.exec(
		"wezterm",
		paneArgs(pane.placement, pane.paneId, ctx.sessionManager.getCwd(), command),
		{ timeout: EXEC_TIMEOUT_MS },
	);
	if (spawned.code !== 0) {
		const reason = spawned.stderr.trim() || `exit code ${spawned.code}`;
		ctx.ui.notify(`wezterm ${pane.name} failed: ${reason}`, "error");
		return;
	}

	const newPaneId = spawned.stdout.trim();
	// The pane runs the shell, so wezterm would otherwise title the tab after the shell, not pi.
	if (pane.placement.ownTab) {
		await pi.exec("wezterm", ["cli", "set-tab-title", "--pane-id", newPaneId, title], {
			timeout: EXEC_TIMEOUT_MS,
		});
	}
	ctx.ui.notify(`Opened pane ${newPaneId} (${pane.name})`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("wclone", {
		description: "Clone the active branch into another wezterm pane",
		getArgumentCompletions: completePlacement,
		handler: async (args, ctx) => {
			const pane = preparePane(args, ctx);
			if (!pane) return;

			// The detached manager reads the branch from disk, so the leaf has to be flushed first.
			await ctx.waitForIdle();
			const sourceFile = ctx.sessionManager.getSessionFile();
			const leafId = ctx.sessionManager.getLeafId();
			if (!sourceFile || !leafId || !existsSync(sourceFile)) {
				ctx.ui.notify("Nothing to clone yet; wait for the first assistant response", "error");
				return;
			}

			let clonedFile: string | undefined;
			try {
				const detached = SessionManager.open(sourceFile, ctx.sessionManager.getSessionDir());
				clonedFile = detached.createBranchedSession(leafId);
			} catch (error) {
				ctx.ui.notify(
					`Clone failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			// createBranchedSession defers the write when the branch holds no assistant message, and
			// a detached manager never reaches the deferred persist.
			if (!clonedFile || !existsSync(clonedFile)) {
				ctx.ui.notify("Clone wrote no file; the branch has no assistant message yet", "error");
				return;
			}

			const name = ctx.sessionManager.getSessionName();
			const label = name || basename(ctx.sessionManager.getCwd());
			await openPane(pi, ctx, pane, ["--session", clonedFile], `clone: ${label}`);
		},
	});

	pi.registerCommand("wnew", {
		description: "Start a fresh pi session in another wezterm pane",
		getArgumentCompletions: completePlacement,
		handler: async (args, ctx) => {
			const pane = preparePane(args, ctx);
			if (!pane) return;
			await openPane(pi, ctx, pane, [], `pi: ${basename(ctx.sessionManager.getCwd())}`);
		},
	});
}
