import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { SSH_STATE_CUSTOM_TYPE } from "./constants.ts";

const SshSessionStateSchema = Type.Object({
	version: Type.Literal(1),
	remote: Type.String({ pattern: "\\S" }),
	remoteCwd: Type.String({ pattern: "\\S" }),
});

export type SshSessionState = Static<typeof SshSessionStateSchema>;

export function getPersistedSshState(ctx: ExtensionContext): SshSessionState | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom") continue;
		if (entry.customType !== SSH_STATE_CUSTOM_TYPE) continue;
		return Value.Check(SshSessionStateSchema, entry.data) ? entry.data : undefined;
	}
	return undefined;
}

export function makeSshSessionState(remote: string, remoteCwd: string): SshSessionState {
	return { version: 1, remote, remoteCwd };
}
