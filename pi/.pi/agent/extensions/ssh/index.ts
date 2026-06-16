import { posix } from "node:path";
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
import {
	createLocalRuntimeRoots,
	extractAbsolutePaths,
	hasLocalPathTarget,
	isLocalPathRoute,
	type LocalRuntimeRoots,
	normalizeToolPath,
	routePath,
	type SshPathRoute,
} from "./path-router.ts";
import { getPersistedSshState, makeSshSessionState, type SshSessionState } from "./state.ts";

const SSH_EXECUTION_TOOL_NAMES = ["read", "write", "edit", "bash", "ls", "find", "grep"] as const;

type SshExecutionToolName = (typeof SSH_EXECUTION_TOOL_NAMES)[number];

interface SshTarget {
	remote: string;
	remoteCwd?: string;
	persist: boolean;
}

const SSH_CHILD_REMOTE_ENV = "PI_SSH_REMOTE";
const SSH_CHILD_REMOTE_CWD_ENV = "PI_SSH_REMOTE_CWD";

function parseSshFlag(value: string): SshTarget {
	const colonIndex = value.indexOf(":");
	const remote = colonIndex === -1 ? value : value.slice(0, colonIndex);
	const remoteCwd = colonIndex === -1 ? undefined : value.slice(colonIndex + 1);
	return { remote, remoteCwd, persist: true };
}

function targetFromState(state: SshSessionState): SshTarget {
	return { remote: state.remote, remoteCwd: state.remoteCwd, persist: false };
}

function targetFromChildEnv(): SshTarget | undefined {
	if (process.env.PI_SUBAGENT_CHILD !== "1") return undefined;
	const remote = process.env[SSH_CHILD_REMOTE_ENV];
	const remoteCwd = process.env[SSH_CHILD_REMOTE_CWD_ENV];
	if (!remote || !remoteCwd) return undefined;
	return { remote, remoteCwd, persist: false };
}

function setChildSshEnv(connection: SshConnection): void {
	process.env[SSH_CHILD_REMOTE_ENV] = connection.remote;
	process.env[SSH_CHILD_REMOTE_CWD_ENV] = connection.remoteCwd;
}

function clearChildSshEnv(): void {
	delete process.env[SSH_CHILD_REMOTE_ENV];
	delete process.env[SSH_CHILD_REMOTE_CWD_ENV];
}

type MutableRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MutableRecord {
	return typeof value === "object" && value !== null;
}

function resolveRemotePath(
	ssh: SshConnection,
	filePath: string,
	baseRemoteCwd: string,
	localRuntimeRoots: LocalRuntimeRoots,
): string | undefined {
	if (isLocalPathRoute(routePath(filePath, localRuntimeRoots))) return undefined;

	const normalizedPath = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	if (normalizedPath === "~") return ssh.remoteHome;
	if (normalizedPath.startsWith("~/")) {
		return posix.normalize(`${ssh.remoteHome}/${normalizedPath.slice(2)}`);
	}
	if (normalizedPath.startsWith("/")) return posix.normalize(normalizedPath);
	return posix.normalize(`${baseRemoteCwd}/${normalizedPath}`);
}

function resolveRemoteCwd(
	ssh: SshConnection,
	cwd: string,
	localRuntimeRoots: LocalRuntimeRoots,
): string | undefined {
	return resolveRemotePath(ssh, cwd, ssh.remoteCwd, localRuntimeRoots);
}

function mergeRemoteCwd(current: string | undefined, next: string | undefined): string | undefined {
	if (!next) return current;
	if (!current) return next;
	return current === next ? current : undefined;
}

function rewriteSubagentCwdField(
	input: MutableRecord,
	ssh: SshConnection,
	localRuntimeRoots: LocalRuntimeRoots,
	currentRemoteCwd: string | undefined,
): { remoteCwd?: string; changed: boolean; conflict: boolean } {
	const inputRemoteCwd = typeof input.cwd === "string"
		? resolveRemoteCwd(ssh, input.cwd, localRuntimeRoots)
		: undefined;
	const baseRemoteCwd = inputRemoteCwd ?? currentRemoteCwd ?? ssh.remoteCwd;
	let changed = rewriteSubagentReadsField(input, ssh, localRuntimeRoots, baseRemoteCwd);

	if (!inputRemoteCwd) return { remoteCwd: currentRemoteCwd, changed, conflict: false };
	const merged = mergeRemoteCwd(currentRemoteCwd, inputRemoteCwd);
	if (!merged) return { changed, conflict: true };
	delete input.cwd;
	changed = true;
	return { remoteCwd: merged, changed, conflict: false };
}

function rewriteSubagentReadsField(
	input: MutableRecord,
	ssh: SshConnection,
	localRuntimeRoots: LocalRuntimeRoots,
	baseRemoteCwd: string,
): boolean {
	if (!Array.isArray(input.reads)) return false;
	let changed = false;
	input.reads = input.reads.map((filePath) => {
		if (typeof filePath !== "string") return filePath;
		const remotePath = resolveRemotePath(ssh, filePath, baseRemoteCwd, localRuntimeRoots);
		if (!remotePath) return filePath;
		changed = changed || remotePath !== filePath;
		return remotePath;
	});
	return changed;
}

function rewriteSubagentRemoteCwds(
	params: MutableRecord,
	ssh: SshConnection,
	localRuntimeRoots: LocalRuntimeRoots,
): { remoteCwd?: string; changed: boolean; error?: string } {
	let remoteCwd: string | undefined;
	let changed = false;

	const apply = (input: unknown): boolean => {
		if (!isRecord(input)) return true;
		const result = rewriteSubagentCwdField(input, ssh, localRuntimeRoots, remoteCwd);
		if (result.conflict) return false;
		remoteCwd = result.remoteCwd;
		changed = changed || result.changed;
		return true;
	};

	const mixedCwdError = "SSH subagents do not support mixed remote cwd values in one run.";
	if (!apply(params)) return { changed, error: mixedCwdError };
	for (const task of Array.isArray(params.tasks) ? params.tasks : []) {
		if (!apply(task)) return { changed, error: mixedCwdError };
	}
	for (const step of Array.isArray(params.chain) ? params.chain : []) {
		if (!apply(step)) return { changed, error: mixedCwdError };
		if (!isRecord(step)) continue;
		const parallel = step.parallel;
		if (Array.isArray(parallel)) {
			for (const task of parallel) {
				if (!apply(task)) return { changed, error: mixedCwdError };
			}
		} else if (!apply(parallel)) {
			return { changed, error: mixedCwdError };
		}
	}

	return { remoteCwd, changed };
}

function prepareSubagentSshEnvironment(
	params: unknown,
	ssh: SshConnection,
	localRuntimeRoots: LocalRuntimeRoots,
): string | undefined {
	if (!isRecord(params)) return undefined;
	const rewrite = rewriteSubagentRemoteCwds(params, ssh, localRuntimeRoots);
	if (rewrite.error) return rewrite.error;
	process.env[SSH_CHILD_REMOTE_ENV] = ssh.remote;
	process.env[SSH_CHILD_REMOTE_CWD_ENV] = rewrite.remoteCwd ?? ssh.remoteCwd;
	return undefined;
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

function withNormalizedPath<T extends { path?: string }>(params: T): T {
	if (!params.path) return params;
	const normalizedPath = normalizeToolPath(params.path);
	return normalizedPath === params.path ? params : { ...params, path: normalizedPath };
}

function debugPathRoute(
	ctx: ExtensionContext,
	enabled: boolean,
	toolName: string,
	path: string | undefined,
	route: SshPathRoute,
): void {
	if (!enabled) return;
	ctx.ui.notify(`ssh route ${toolName}: ${route} ${path ?? "."}`, "info");
}

function formatLocalRuntimeRoots(roots: LocalRuntimeRoots): string {
	return [
		"ssh local writable roots:",
		...roots.writable.map((root) => `- ${root}`),
		"ssh local readonly roots:",
		...roots.readonly.map((root) => `- ${root}`),
	].join("\n");
}

function registerSshToolOverrides(
	pi: ExtensionAPI,
	localCwd: string,
	localRuntimeRoots: LocalRuntimeRoots,
	getConnection: () => SshConnection | null,
	isRoutingDebugEnabled: () => boolean,
): void {
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
			const route = routePath(params.path, localRuntimeRoots);
			debugPathRoute(toolCtx, isRoutingDebugEnabled(), "read", params.path, route);
			if (isLocalPathRoute(route)) {
				return localRead.execute(id, withNormalizedPath(params), signal, onUpdate);
			}
			const ssh = requireConnection(getConnection());
			const tool = createReadTool(ssh.remoteCwd, {
				operations: createRemoteReadOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, toolCtx) {
			const route = routePath(params.path, localRuntimeRoots);
			debugPathRoute(toolCtx, isRoutingDebugEnabled(), "write", params.path, route);
			if (route === "local-readonly") {
				throw new Error(`Refusing to modify host runtime path: ${params.path}`);
			}
			if (route === "local-writable") {
				return localWrite.execute(id, withNormalizedPath(params), signal, onUpdate);
			}
			const ssh = requireConnection(getConnection());
			const tool = createWriteTool(ssh.remoteCwd, {
				operations: createRemoteWriteOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, toolCtx) {
			const route = routePath(params.path, localRuntimeRoots);
			debugPathRoute(toolCtx, isRoutingDebugEnabled(), "edit", params.path, route);
			if (route === "local-readonly") {
				throw new Error(`Refusing to modify host runtime path: ${params.path}`);
			}
			if (route === "local-writable") {
				return localEdit.execute(id, withNormalizedPath(params), signal, onUpdate);
			}
			const ssh = requireConnection(getConnection());
			const tool = createEditTool(ssh.remoteCwd, {
				operations: createRemoteEditOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, toolCtx) {
			if (hasLocalPathTarget(params.command, localRuntimeRoots)) {
				const paths = extractAbsolutePaths(params.command);
				const route = routePath(paths[0], localRuntimeRoots);
				debugPathRoute(toolCtx, isRoutingDebugEnabled(), "bash", params.command, route);
				return localBash.execute(id, params, signal, onUpdate);
			}
			const ssh = requireConnection(getConnection());
			const tool = createBashTool(ssh.remoteCwd, {
				operations: createRemoteBashOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, toolCtx) {
			const route = routePath(params.path, localRuntimeRoots);
			debugPathRoute(toolCtx, isRoutingDebugEnabled(), "ls", params.path, route);
			if (isLocalPathRoute(route)) {
				return localLs.execute(id, withNormalizedPath(params), signal, onUpdate);
			}
			const ssh = requireConnection(getConnection());
			const tool = createLsTool(ssh.remoteCwd, {
				operations: createRemoteLsOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, toolCtx) {
			const route = routePath(params.path, localRuntimeRoots);
			debugPathRoute(toolCtx, isRoutingDebugEnabled(), "find", params.path, route);
			if (isLocalPathRoute(route)) {
				return localFind.execute(id, withNormalizedPath(params), signal, onUpdate);
			}
			const ssh = requireConnection(getConnection());
			const tool = createFindTool(ssh.remoteCwd, {
				operations: createRemoteFindOps(ssh),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(id, params, signal, onUpdate, toolCtx) {
			const route = routePath(params.path, localRuntimeRoots);
			debugPathRoute(toolCtx, isRoutingDebugEnabled(), "grep", params.path, route);
			if (isLocalPathRoute(route)) {
				return localGrep.execute(id, withNormalizedPath(params), signal, onUpdate);
			}
			const ssh = requireConnection(getConnection());
			return executeRemoteGrep(ssh, params, signal);
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", {
		description: "SSH remote: user@host or user@host:/path",
		type: "string",
	});
	pi.registerFlag("ssh-debug-routing", {
		description: "Show SSH path routing decisions",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localRuntimeRoots = createLocalRuntimeRoots();
	let connection: SshConnection | null = null;
	let autocompleteProviderRegistered = false;
	let toolOverridesRegistered = false;
	let subagentLaunchInFlight = false;

	const getConnection = () => connection;
	const isRoutingDebugEnabled = () => pi.getFlag("ssh-debug-routing") === true;
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
				setChildSshEnv(ssh);
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
		const childTarget = targetFromChildEnv();
		const persistedState = getPersistedSshState(ctx);
		const target = arg
			? parseSshFlag(arg)
			: childTarget ?? (persistedState ? targetFromState(persistedState) : undefined);
		if (!target) {
			clearChildSshEnv();
			updateSshStatus(ctx, null);
			return;
		}

		if (!toolOverridesRegistered) {
			assertSshExecutionToolOwnership(pi);
			registerSshToolOverrides(pi, localCwd, localRuntimeRoots, getConnection, isRoutingDebugEnabled);
			toolOverridesRegistered = true;
		}
		if (isRoutingDebugEnabled()) {
			ctx.ui.notify(formatLocalRuntimeRoots(localRuntimeRoots), "info");
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

		setChildSshEnv(connection);
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
		subagentLaunchInFlight = false;
		clearChildSshEnv();
		await ssh?.close();
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		const ssh = getConnection();
		if (!ssh) return;
		if (subagentLaunchInFlight) {
			return { block: true, reason: "SSH mode supports one subagent launch per tool batch." };
		}
		const error = prepareSubagentSshEnvironment(event.input, ssh, localRuntimeRoots);
		if (error) return { block: true, reason: error };
		subagentLaunchInFlight = true;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		subagentLaunchInFlight = false;
		const ssh = getConnection();
		if (ssh) setChildSshEnv(ssh);
		else clearChildSshEnv();
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
