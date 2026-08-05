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
import { type CompletionErrorReporter, createRemoteAtAutocompleteProvider } from "./autocomplete.ts";
import { SshConnection } from "./connection.ts";
import { SSH_STATE_CUSTOM_TYPE } from "./constants.ts";
import {
	applySshConnectionDescriptor,
	clearSshConnectionDescriptor,
	DELEGATE_CHILD_ENV,
	publishSshConnectionDescriptor,
	readDelegateChildSshDescriptor,
} from "./descriptor.ts";
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
			await nextConnection.resolveRemoteCwd(target.remoteCwd);
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

// Returns false (after notifying) on conflict instead of throwing: a session_start handler that
// throws doesn't stop the session — pi's extension runner catches it, logs a raw stack trace to
// the transcript, and continues starting the session regardless. Reporting through ctx.ui.notify
// gets the same "SSH mode does not activate" outcome with the clean message every other SSH
// failure in this file already uses.
function checkSshExecutionToolOwnership(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	const conflicts = findSshExecutionToolConflicts(pi.getAllTools());
	if (conflicts.length === 0) return true;

	const lines = conflicts.map((conflict) => `- ${conflict.name}: ${conflict.owner}`);
	const message = [
		"SSH mode requires ownership of its execution tools so every tool has one unambiguous machine target.",
		"Conflicting tool owners:",
		...lines,
		"Change those extensions to use policy hooks instead of registering execution tools.",
	].join("\n");
	updateSshStatus(ctx, null, message);
	ctx.ui.notify(message, "error");
	return false;
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
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireConnection(getConnection());
			const definition = createReadToolDefinition(ssh.remoteCwd, { operations: createRemoteReadOps(ssh) });
			return definition.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...writeDef,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireConnection(getConnection());
			const definition = createWriteToolDefinition(ssh.remoteCwd, { operations: createRemoteWriteOps(ssh) });
			return definition.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...editDef,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireConnection(getConnection());
			const definition = createEditToolDefinition(ssh.remoteCwd, { operations: createRemoteEditOps(ssh) });
			return definition.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...lsDef,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireConnection(getConnection());
			const definition = createLsToolDefinition(ssh.remoteCwd, { operations: createRemoteLsOps(ssh) });
			return definition.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...findDef,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireConnection(getConnection());
			const definition = createFindToolDefinition(ssh.remoteCwd, { operations: createRemoteFindOps(ssh) });
			return definition.execute(id, params, signal, onUpdate, ctx);
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
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireConnection(getConnection());
			const definition = createBashToolDefinition(ssh.remoteCwd, {
				operations: createRemoteBashOps(ssh),
			});
			return definition.execute(id, params, signal, onUpdate, ctx);
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
	let delegateChild = false;

	const getConnection = () => connection;
	const persistConnection = (ssh: SshConnection) => {
		pi.appendEntry(SSH_STATE_CUSTOM_TYPE, makeSshSessionState(ssh.remote, ssh.remoteCwd));
	};

	let lastCompletionError = "";
	let reportCompletionError: CompletionErrorReporter = () => {};

	pi.on("session_start", async (_event, ctx) => {
		reportCompletionError = (error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (message === lastCompletionError) return;
			lastCompletionError = message;
			ctx.ui.notify(`SSH completion failed: ${message}`, "error");
		};

		delegateChild = process.env[DELEGATE_CHILD_ENV] === "1";
		// Fail closed if a marked child's inherited descriptor is malformed.
		if (delegateChild && !toolOverridesRegistered) {
			if (!checkSshExecutionToolOwnership(pi, ctx)) return;
			registerSshToolOverrides(pi, localCwd, getConnection);
			toolOverridesRegistered = true;
		}
		const childDescriptor = readDelegateChildSshDescriptor();
		const arg = pi.getFlag("ssh") as string | undefined;
		const persistedState = getPersistedSshState(ctx);
		const parentTarget = childDescriptor
			? undefined
			: arg
				? parseSshFlag(arg)
				: persistedState
					? targetFromState(persistedState)
					: undefined;
		if (!childDescriptor && !parentTarget) {
			clearSshConnectionDescriptor();
			updateSshStatus(ctx, null);
			return;
		}

		if (!toolOverridesRegistered) {
			if (!checkSshExecutionToolOwnership(pi, ctx)) return;
			registerSshToolOverrides(pi, localCwd, getConnection);
			toolOverridesRegistered = true;
		}

		try {
			if (childDescriptor) {
				connection = new SshConnection(childDescriptor.remote, ctx.cwd);
				applySshConnectionDescriptor(connection, childDescriptor);
			} else {
				connection = await connectTarget(parentTarget!, ctx.cwd, ctx);
				publishSshConnectionDescriptor(connection);
			}
			if (parentTarget?.persist) persistConnection(connection);
		} catch (error) {
			connection = null;
			if (!delegateChild) clearSshConnectionDescriptor();
			const message = error instanceof Error ? error.message : String(error);
			updateSshStatus(ctx, null, message);
			ctx.ui.notify(`SSH connect failed: ${message}`, "error");
			return;
		}

		if (!autocompleteProviderRegistered) {
			autocompleteProviderRegistered = true;
			ctx.ui.addAutocompleteProvider((current) =>
				createRemoteAtAutocompleteProvider(current, getConnection, reportCompletionError),
			);
		}
		updateSshStatus(ctx, connection);
		ctx.ui.notify(`SSH mode: ${sshStatusText(connection)}`, "info");
		pi.events.emit("ssh:connected", undefined);
	});

	pi.on("session_shutdown", async () => {
		const ssh = connection;
		connection = null;
		if (!delegateChild) clearSshConnectionDescriptor();
		await ssh?.close();
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
