import { posix } from "node:path";
import { SshConnection } from "./connection.ts";
import { isLocalPathRoute, type LocalRuntimeRoots, routePath } from "./path-router.ts";
import { isRecord } from "./util.ts";

// PI_SSH_REMOTE* are our own vars: the parent publishes them and subagent children
// inherit them because pi-subagents spawns children with `{ ...process.env }` (no env
// allowlist). PI_SUBAGENT_CHILD is pi-subagents' own marker, set to "1" only inside a
// spawned child (pi-subagents buildPiArgs / extension entry) — our signal that we are
// the child rather than the parent.
const REMOTE_ENV = "PI_SSH_REMOTE";
const REMOTE_CWD_ENV = "PI_SSH_REMOTE_CWD";
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

type MutableRecord = Record<string, unknown>;

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

/**
 * Read the SSH target the parent published, only when running inside a subagent child.
 *
 * Relies on pi-subagents setting PI_SUBAGENT_CHILD="1" in children, and on the child
 * loading this extension at all: a subagent run can restrict child extensions via its
 * `extensions` field, and if ours is excluded this never runs and the child stays local.
 */
export function readChildSshTarget(): { remote: string; remoteCwd: string } | undefined {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1") return undefined;
	const remote = process.env[REMOTE_ENV];
	const remoteCwd = process.env[REMOTE_CWD_ENV];
	if (!remote || !remoteCwd) return undefined;
	return { remote, remoteCwd };
}

export interface SubagentSshBridge {
	syncToConnection(): void;
	beginLaunch(input: unknown): { error?: string };
	endLaunch(): void;
	shutdown(): void;
}

/**
 * Sole owner of the PI_SSH_REMOTE* env vars that subagent children inherit at spawn.
 *
 * pi-subagents exposes no per-spawn env hook and no agent-config env field, so mutating
 * the parent's process env is the only channel (children inherit it via `{ ...process.env }`).
 * Invariant: while connected the env mirrors the live connection; a launch may temporarily
 * override the cwd for that child, then endLaunch restores it.
 *
 * Correctness depends on a pi-subagents detail: it snapshots process.env synchronously
 * inside the subagent tool's execute() — for foreground, background, and the detached async
 * runner (verified in pi-subagents 0.28). execute() runs between our tool_call (beginLaunch)
 * and tool_result (endLaunch), so the per-launch cwd is always live at spawn time. The
 * single-launch guard exists because one global env can't hold distinct cwds for concurrent
 * launches; if pi-subagents ever gains a per-spawn env hook, prefer that and drop the guard.
 */
export function createSubagentSshBridge(deps: {
	getConnection: () => SshConnection | null;
	localRuntimeRoots: LocalRuntimeRoots;
}): SubagentSshBridge {
	let launchInFlight = false;

	const publish = (remote: string, remoteCwd: string): void => {
		process.env[REMOTE_ENV] = remote;
		process.env[REMOTE_CWD_ENV] = remoteCwd;
	};
	const clear = (): void => {
		delete process.env[REMOTE_ENV];
		delete process.env[REMOTE_CWD_ENV];
	};
	const syncToConnection = (): void => {
		const ssh = deps.getConnection();
		if (ssh) publish(ssh.remote, ssh.remoteCwd);
		else clear();
	};

	return {
		syncToConnection,
		beginLaunch(input: unknown): { error?: string } {
			const ssh = deps.getConnection();
			if (!ssh) return {};
			if (launchInFlight) return { error: "SSH mode supports one subagent launch per tool batch." };
			if (isRecord(input)) {
				const rewrite = rewriteSubagentRemoteCwds(input, ssh, deps.localRuntimeRoots);
				if (rewrite.error) return { error: rewrite.error };
				publish(ssh.remote, rewrite.remoteCwd ?? ssh.remoteCwd);
			}
			launchInFlight = true;
			return {};
		},
		endLaunch(): void {
			launchInFlight = false;
			syncToConnection();
		},
		shutdown(): void {
			launchInFlight = false;
			clear();
		},
	};
}
