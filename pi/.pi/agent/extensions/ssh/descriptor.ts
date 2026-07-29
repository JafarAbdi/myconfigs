import type { SshConnection } from "./connection.ts";
import { isRecord } from "./util.ts";

export const SSH_DESCRIPTOR_ENV = "PI_SSH_DESCRIPTOR";
export const DELEGATE_CHILD_ENV = "PI_DELEGATE_CHILD";

export interface SshConnectionDescriptor {
	remote: string;
	remoteCwd: string;
	remoteHome: string;
	fdPath: string;
	rgPath: string;
	fzfPath: string;
	remoteToolBinDir?: string;
	remotePythonUvCommandsBinDir?: string;
	remoteUvBinDir?: string;
}

function requireString(data: Record<string, unknown>, key: string): string {
	const value = data[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Invalid SSH descriptor: ${key} must be a non-empty string`);
	}
	return value;
}

function requireAbsolutePath(data: Record<string, unknown>, key: string): string {
	const value = requireString(data, key);
	if (!value.startsWith("/")) {
		throw new Error(`Invalid SSH descriptor: ${key} must be an absolute remote path`);
	}
	return value;
}

function optionalAbsolutePath(data: Record<string, unknown>, key: string): string | undefined {
	if (data[key] === undefined) return undefined;
	return requireAbsolutePath(data, key);
}

export function parseSshConnectionDescriptor(serialized: string | undefined): SshConnectionDescriptor {
	if (!serialized) throw new Error(`SSH delegate child requires ${SSH_DESCRIPTOR_ENV}`);

	let data: unknown;
	try {
		data = JSON.parse(serialized);
	} catch {
		throw new Error(`Invalid SSH descriptor in ${SSH_DESCRIPTOR_ENV}: expected JSON`);
	}
	if (!isRecord(data)) throw new Error("Invalid SSH descriptor: expected an object");

	return {
		remote: requireString(data, "remote"),
		remoteCwd: requireAbsolutePath(data, "remoteCwd"),
		remoteHome: requireAbsolutePath(data, "remoteHome"),
		fdPath: requireAbsolutePath(data, "fdPath"),
		rgPath: requireAbsolutePath(data, "rgPath"),
		fzfPath: requireAbsolutePath(data, "fzfPath"),
		remoteToolBinDir: optionalAbsolutePath(data, "remoteToolBinDir"),
		remotePythonUvCommandsBinDir: optionalAbsolutePath(data, "remotePythonUvCommandsBinDir"),
		remoteUvBinDir: optionalAbsolutePath(data, "remoteUvBinDir"),
	};
}

export function makeSshConnectionDescriptor(connection: SshConnection): SshConnectionDescriptor {
	return {
		remote: connection.remote,
		remoteCwd: connection.remoteCwd,
		remoteHome: connection.remoteHome,
		fdPath: connection.requireFdPath(),
		rgPath: connection.requireRgPath(),
		fzfPath: connection.requireFzfPath(),
		remoteToolBinDir: connection.remoteToolBinDir,
		remotePythonUvCommandsBinDir: connection.remotePythonUvCommandsBinDir,
		remoteUvBinDir: connection.remoteUvBinDir,
	};
}

export function applySshConnectionDescriptor(
	connection: SshConnection,
	descriptor: SshConnectionDescriptor,
): void {
	connection.setRemoteCwd(descriptor.remoteCwd);
	connection.remoteHome = descriptor.remoteHome;
	connection.fdPath = descriptor.fdPath;
	connection.rgPath = descriptor.rgPath;
	connection.fzfPath = descriptor.fzfPath;
	connection.remoteToolBinDir = descriptor.remoteToolBinDir;
	connection.remotePythonUvCommandsBinDir = descriptor.remotePythonUvCommandsBinDir;
	connection.remoteUvBinDir = descriptor.remoteUvBinDir;
}

export function readDelegateChildSshDescriptor(
	env: NodeJS.ProcessEnv = process.env,
): SshConnectionDescriptor | undefined {
	if (env[DELEGATE_CHILD_ENV] !== "1") return undefined;
	return parseSshConnectionDescriptor(env[SSH_DESCRIPTOR_ENV]);
}

export function publishSshConnectionDescriptor(connection: SshConnection): void {
	process.env[SSH_DESCRIPTOR_ENV] = JSON.stringify(makeSshConnectionDescriptor(connection));
}

export function clearSshConnectionDescriptor(): void {
	delete process.env[SSH_DESCRIPTOR_ENV];
}
