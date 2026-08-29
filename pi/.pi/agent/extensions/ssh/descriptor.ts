import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { SshConnection } from "./connection.ts";

export const SSH_DESCRIPTOR_ENV = "PI_SSH_DESCRIPTOR";
export const DELEGATE_CHILD_ENV = "PI_DELEGATE_CHILD";

const SshConnectionDescriptorSchema = Type.Object(
	{
		remote: Type.String({ pattern: "\\S" }),
		remoteCwd: Type.String({ pattern: "^/" }),
	},
	{ additionalProperties: false },
);

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
		throw new Error("Invalid SSH descriptor: expected { remote, remoteCwd }");
	}
	return data;
}

export function makeSshConnectionDescriptor(
	connection: Pick<SshConnection, "remote" | "remoteCwd">,
): SshConnectionDescriptor {
	return { remote: connection.remote, remoteCwd: connection.remoteCwd };
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
