import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type CompletionErrorReporter,
	createRemoteAtAutocompleteProvider,
	getRemoteDirectoryCompletions,
	parseHiddenFlag,
} from "./autocomplete.ts";
import { SshConnection } from "./connection.ts";
import { SSH_STATE_CUSTOM_TYPE } from "./constants.ts";
import { executeRemoteGrep } from "./grep.ts";
import {
	createRemoteBashOps,
	createRemoteEditOps,
	createRemoteFindOps,
	createRemoteLsOps,
	createRemoteReadOps,
	createRemoteWriteOps,
} from "./operations.ts";
import { getPersistedSshState, makeSshSessionState, type SshSessionState } from "./state.ts";
import { createSubagentSshBridge, readChildSshTarget } from "./subagent-env.ts";

const SSH_EXECUTION_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"bash",
	"host_bash",
	"ls",
	"find",
	"grep",
] as const;

type SshExecutionToolName = (typeof SSH_EXECUTION_TOOL_NAMES)[number];

interface SshTarget {
	remote: string;
	remoteCwd?: string;
	persist: boolean;
}

function parseSshFlag(value: string): SshTarget {
	const colonIndex = value.indexOf(":");
	const remote = colonIndex === -1 ? value : value.slice(0, colonIndex);
	const remoteCwd = colonIndex === -1 ? undefined : value.slice(colonIndex + 1);
	return { remote, remoteCwd, persist: true };
}

function targetFromState(state: SshSessionState): SshTarget {
	return { remote: state.remote, remoteCwd: state.remoteCwd, persist: false };
}

function sshStatusText(connection: SshConnection): string {
	return `${connection.remote}:${connection.remoteCwd}`;
}

function updateSshPhaseStatus(ctx: ExtensionContext, text: string): void {
	const theme = ctx.ui.theme;
	const label = theme.fg("accent", "ssh");
	ctx.ui.setStatus("ssh", `${label} ${theme.fg("muted", text)}`);
}

function updateSshStatus(ctx: ExtensionContext, connection: SshConnection | null, error?: string): void {
	const theme = ctx.ui.theme;
	const label = theme.fg("accent", "ssh");
	if (error) {
		ctx.ui.setStatus("ssh", `${label} ${theme.fg("error", error)}`);
		return;
	}
	if (!connection) {
		ctx.ui.setStatus("ssh", undefined);
		return;
	}
	ctx.ui.setStatus("ssh", `${label} ${theme.fg("success", sshStatusText(connection))}`);
}

async function connectTarget(target: SshTarget, localCwd: string, ctx: ExtensionContext): Promise<SshConnection> {
	const nextConnection = new SshConnection(target.remote, localCwd);
	try {
		updateSshPhaseStatus(ctx, "connecting");
		await nextConnection.connect();
		if (target.remoteCwd) {
			await nextConnection.changeRemoteCwd(target.remoteCwd);
		} else {
			nextConnection.setRemoteCwd((await nextConnection.exec("pwd")).toString().trim());
		}
		await nextConnection.bootstrapTools((status) => updateSshPhaseStatus(ctx, status));
		return nextConnection;
	} catch (error) {
		await nextConnection.close();
		throw error;
	}
}

function isBuiltinTool(tool: ToolInfo): boolean {
	return tool.sourceInfo.source === "builtin";
}

function findSshExecutionToolConflicts(tools: ToolInfo[]): Array<{ name: SshExecutionToolName; owner: string }> {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const conflicts: Array<{ name: SshExecutionToolName; owner: string }> = [];
	for (const name of SSH_EXECUTION_TOOL_NAMES) {
		const tool = byName.get(name);
		if (tool && !isBuiltinTool(tool)) {
			conflicts.push({ name, owner: tool.sourceInfo.path });
		}
	}
	return conflicts;
}

function assertSshExecutionToolOwnership(pi: ExtensionAPI): void {
	const conflicts = findSshExecutionToolConflicts(pi.getAllTools());
	if (conflicts.length === 0) return;

	const lines = conflicts.map((conflict) => `- ${conflict.name}: ${conflict.owner}`);
	throw new Error(
		[
			"SSH mode requires ownership of its execution tools so every tool has one unambiguous machine target.",
			"Conflicting tool owners:",
			...lines,
			"Change those extensions to use policy hooks instead of registering execution tools.",
		].join("\n"),
	);
}

function requireConnection(connection: SshConnection | null): SshConnection {
	if (connection) return connection;
	throw new Error("SSH is not connected. Start pi with --ssh user@host:/path.");
}

function remoteCwdPromptLine(ssh: SshConnection, hostCwd: string): string {
	return `Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote}; host cwd: ${hostCwd})`;
}

// The "Current working directory: <cwd>" line is emitted by the pi runtime, not us, so
// this match is coupled to pi's prompt format. If pi rewords it the guards below return a
// warning instead of silently leaving the child pointed at the local cwd in SSH mode.
function rewriteSystemPromptRemoteCwd(
	systemPrompt: string,
	expectedLocalCwd: string,
	ssh: SshConnection,
): { systemPrompt?: string; warning?: string } {
	const cwdLinePattern = /^Current working directory: .*$/gm;
	const cwdLines = systemPrompt.match(cwdLinePattern) ?? [];
	if (cwdLines.length === 0) {
		return { warning: "SSH: cwd prompt line not found; remote cwd not injected." };
	}
	if (cwdLines.length > 1) {
		return { warning: "SSH: multiple cwd prompt lines found; remote cwd not injected." };
	}

	const expectedLine = `Current working directory: ${expectedLocalCwd}`;
	if (cwdLines[0] !== expectedLine) {
		return { warning: "SSH: expected cwd prompt line not found; remote cwd not injected." };
	}
	return { systemPrompt: systemPrompt.replace(cwdLinePattern, remoteCwdPromptLine(ssh, expectedLocalCwd)) };
}

function registerSshToolOverrides(
	pi: ExtensionAPI,
	localCwd: string,
	getConnection: () => SshConnection | null,
): void {
	const readDef = createReadToolDefinition(localCwd);
	const writeDef = createWriteToolDefinition(localCwd);
	const editDef = createEditToolDefinition(localCwd);
	const hostBashDef = createBashToolDefinition(localCwd);
	const lsDef = createLsToolDefinition(localCwd);
	const findDef = createFindToolDefinition(localCwd);
	const grepDef = createGrepToolDefinition(localCwd);

	pi.registerTool({
		...readDef,
		async execute(id, params, signal, onUpdate) {
			const ssh = requireConnection(getConnection());
			const tool = createReadTool(ssh.remoteCwd, { operations: createRemoteReadOps(ssh) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...writeDef,
		async execute(id, params, signal, onUpdate) {
			const ssh = requireConnection(getConnection());
			const tool = createWriteTool(ssh.remoteCwd, { operations: createRemoteWriteOps(ssh) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...editDef,
		async execute(id, params, signal, onUpdate) {
			const ssh = requireConnection(getConnection());
			const tool = createEditTool(ssh.remoteCwd, { operations: createRemoteEditOps(ssh) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...lsDef,
		async execute(id, params, signal, onUpdate) {
			const ssh = requireConnection(getConnection());
			const tool = createLsTool(ssh.remoteCwd, { operations: createRemoteLsOps(ssh) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...findDef,
		async execute(id, params, signal, onUpdate) {
			const ssh = requireConnection(getConnection());
			const tool = createFindTool(ssh.remoteCwd, { operations: createRemoteFindOps(ssh) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...grepDef,
		async execute(_id, params, signal) {
			return executeRemoteGrep(requireConnection(getConnection()), params, signal);
		},
	});

	pi.registerTool({
		...hostBashDef,
		name: "host_bash",
		label: "host bash",
		description: "Execute Bash on the host machine running Pi. Use it for all host-local commands and files.",
		promptSnippet: "Execute commands or access files on the host machine running Pi",
		promptGuidelines: [
			"In SSH mode, read, write, edit, ls, find, grep, bash, and ! operate on the SSH remote. " +
				"Use host_bash for every host-local command or file, including Pi docs, extensions, skills, " +
				"prompts, and agent config. Host and remote cwd are independent.",
		],
	});

	pi.registerTool({
		...hostBashDef,
		async execute(id, params, signal, onUpdate) {
			const ssh = requireConnection(getConnection());
			const tool = createBashTool(ssh.remoteCwd, {
				operations: createRemoteBashOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", {
		description: "SSH remote: user@host or user@host:/path",
		type: "string",
	});
	const localCwd = process.cwd();
	let connection: SshConnection | null = null;
	let autocompleteProviderRegistered = false;
	let toolOverridesRegistered = false;

	const getConnection = () => connection;
	const subagentBridge = createSubagentSshBridge({ getConnection });
	const persistConnection = (ssh: SshConnection) => {
		pi.appendEntry(SSH_STATE_CUSTOM_TYPE, makeSshSessionState(ssh.remote, ssh.remoteCwd));
	};

	let lastCompletionError = "";
	let reportCompletionError: CompletionErrorReporter = () => {};

	pi.registerCommand("ssh-cd", {
		description: "Change SSH remote working directory (-h to include hidden dirs)",
		getArgumentCompletions: async (argumentPrefix) => {
			const ssh = getConnection();
			return ssh ? getRemoteDirectoryCompletions(ssh, argumentPrefix, reportCompletionError) : null;
		},
		handler: async (args, ctx) => {
			const ssh = getConnection();
			if (!ssh) {
				ctx.ui.notify("SSH is not connected. Start pi with --ssh user@host:/path.", "warning");
				updateSshStatus(ctx, null);
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent turn to finish before changing SSH cwd.", "warning");
				return;
			}
			try {
				const nextRemoteCwd = await ssh.changeRemoteCwd(parseHiddenFlag(args).rest);
				persistConnection(ssh);
				subagentBridge.syncToConnection();
				updateSshStatus(ctx, ssh);
				ctx.ui.notify(`SSH cwd: ${ssh.remote}:${nextRemoteCwd}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateSshStatus(ctx, ssh, message);
				ctx.ui.notify(`SSH cd failed: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		reportCompletionError = (error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (message === lastCompletionError) return;
			lastCompletionError = message;
			ctx.ui.notify(`SSH completion failed: ${message}`, "error");
		};

		const arg = pi.getFlag("ssh") as string | undefined;
		const childTarget = readChildSshTarget();
		const persistedState = getPersistedSshState(ctx);
		const target = arg
			? parseSshFlag(arg)
			: childTarget
				? { ...childTarget, persist: false }
				: persistedState
					? targetFromState(persistedState)
					: undefined;
		if (!target) {
			subagentBridge.syncToConnection();
			updateSshStatus(ctx, null);
			return;
		}

		if (!toolOverridesRegistered) {
			assertSshExecutionToolOwnership(pi);
			registerSshToolOverrides(pi, localCwd, getConnection);
			toolOverridesRegistered = true;
		}

		try {
			connection = await connectTarget(target, ctx.cwd, ctx);
			if (target.persist) {
				persistConnection(connection);
			}
		} catch (error) {
			connection = null;
			const message = error instanceof Error ? error.message : String(error);
			updateSshStatus(ctx, null, message);
			throw error;
		}

		subagentBridge.syncToConnection();
		if (!autocompleteProviderRegistered) {
			autocompleteProviderRegistered = true;
			ctx.ui.addAutocompleteProvider((current) =>
				createRemoteAtAutocompleteProvider(current, getConnection, reportCompletionError),
			);
		}
		updateSshStatus(ctx, connection);
		ctx.ui.notify(`SSH mode: ${sshStatusText(connection)}`, "info");
	});

	pi.on("session_shutdown", async () => {
		const ssh = connection;
		connection = null;
		subagentBridge.shutdown();
		await ssh?.close();
	});

	// beginLaunch/endLaunch must bracket the subagent tool's execute(), where pi-subagents
	// snapshots process.env for the child spawn. Order is tool_call -> execute (spawn) ->
	// tool_result, so the published env override stays live across the whole spawn window.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		const { error } = subagentBridge.beginLaunch(event.input);
		if (error) return { block: true, reason: error };
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		subagentBridge.endLaunch();
	});

	pi.on("user_bash", (_event) => {
		const ssh = getConnection();
		if (!ssh) return;
		const operations = createRemoteBashOps(ssh);
		return {
			operations: {
				exec: (command, _cwd, options) => operations.exec(command, ssh.remoteCwd, options),
			},
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const ssh = getConnection();
		if (!ssh) return;

		const promptCwd = typeof event.systemPromptOptions?.cwd === "string"
			? event.systemPromptOptions.cwd
			: ctx.cwd;
		const rewrite = rewriteSystemPromptRemoteCwd(event.systemPrompt, promptCwd || localCwd, ssh);
		if (rewrite.warning) {
			ctx.ui.notify(rewrite.warning, "warning");
			return;
		}
		if (!rewrite.systemPrompt) return;
		return { systemPrompt: rewrite.systemPrompt };
	});
}
