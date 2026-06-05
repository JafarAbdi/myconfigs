import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
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
import { createLocalRuntimeRoots, routePath } from "./path-router.ts";
import { getPersistedSshState, makeSshSessionState, type SshSessionState } from "./state.ts";

const SSH_EXECUTION_TOOL_NAMES = ["read", "write", "edit", "bash", "ls", "find", "grep"] as const;

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
			"SSH mode requires ownership of execution tools so all execution runs on the remote host.",
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

function registerSshToolOverrides(pi: ExtensionAPI, localCwd: string, getConnection: () => SshConnection | null): void {
	const localRuntimeRoots = createLocalRuntimeRoots();
	const isLocalRuntimePath = (path: string | undefined): boolean =>
		routePath(path, localRuntimeRoots) === "local-runtime";
	const assertRemoteMutationPath = (path: string): void => {
		if (!isLocalRuntimePath(path)) return;
		throw new Error(`Refusing to modify host runtime path in SSH mode: ${path}`);
	};

	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localLs = createLsTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localGrep = createGrepTool(localCwd);

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, toolCtx) {
			if (isLocalRuntimePath(params.path)) return localRead.execute(id, params, signal, onUpdate);
			const ssh = requireConnection(getConnection());
			const tool = createReadTool(toolCtx.cwd, {
				operations: createRemoteReadOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, toolCtx) {
			assertRemoteMutationPath(params.path);
			const ssh = requireConnection(getConnection());
			const tool = createWriteTool(toolCtx.cwd, {
				operations: createRemoteWriteOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, toolCtx) {
			assertRemoteMutationPath(params.path);
			const ssh = requireConnection(getConnection());
			const tool = createEditTool(toolCtx.cwd, {
				operations: createRemoteEditOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, toolCtx) {
			const ssh = requireConnection(getConnection());
			const tool = createBashTool(toolCtx.cwd, {
				operations: createRemoteBashOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, toolCtx) {
			if (isLocalRuntimePath(params.path)) return localLs.execute(id, params, signal, onUpdate);
			const ssh = requireConnection(getConnection());
			const tool = createLsTool(toolCtx.cwd, {
				operations: createRemoteLsOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, toolCtx) {
			if (isLocalRuntimePath(params.path)) return localFind.execute(id, params, signal, onUpdate);
			const ssh = requireConnection(getConnection());
			const tool = createFindTool(toolCtx.cwd, {
				operations: createRemoteFindOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(id, params, signal, onUpdate) {
			if (isLocalRuntimePath(params.path)) return localGrep.execute(id, params, signal, onUpdate);
			const ssh = requireConnection(getConnection());
			return executeRemoteGrep(ssh, params, signal);
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	let connection: SshConnection | null = null;
	let autocompleteProviderRegistered = false;
	let toolOverridesRegistered = false;

	const getConnection = () => connection;
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
		const persistedState = getPersistedSshState(ctx);
		const target = arg ? parseSshFlag(arg) : persistedState ? targetFromState(persistedState) : undefined;
		if (!target) {
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
		await ssh?.close();
	});

	pi.on("user_bash", (_event) => {
		const ssh = getConnection();
		if (!ssh) return;
		return { operations: createRemoteBashOps(ssh) };
	});

	pi.on("before_agent_start", async (event) => {
		const ssh = getConnection();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
