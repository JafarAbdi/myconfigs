import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { SshConnection } from "./connection.ts";

export const SSH_DESCRIPTOR_ENV = "PI_SSH_DESCRIPTOR";
export const DELEGATE_CHILD_ENV = "PI_DELEGATE_CHILD";

const AbsolutePath = Type.String({ pattern: "^/" });

const SshConnectionDescriptorSchema = Type.Object({
	remote: Type.String({ pattern: "\\S" }),
	remoteCwd: AbsolutePath,
	remoteHome: AbsolutePath,
	fdPath: AbsolutePath,
	rgPath: AbsolutePath,
	fzfPath: AbsolutePath,
	remoteToolBinDir: Type.Optional(AbsolutePath),
	remotePythonUvCommandsBinDir: Type.Optional(AbsolutePath),
	remoteUvBinDir: Type.Optional(AbsolutePath),
});

export type SshConnectionDescriptor = Static<typeof SshConnectionDescriptorSchema>;

export function parseSshConnectionDescriptor(serialized: string | undefined): SshConnectionDescriptor {
	if (!serialized) throw new Error(`SSH delegate child requires ${SSH_DESCRIPTOR_ENV}`);

	let data: unknown;
	try {
		data = JSON.parse(serialized);
	} catch {
		throw new Error(`Invalid SSH descriptor in ${SSH_DESCRIPTOR_ENV}: expected JSON`);
	}
	if (!Value.Check(SshConnectionDescriptorSchema, data)) {
		throw new Error("Invalid SSH descriptor: expected a valid descriptor object");
	}
	return data;
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
