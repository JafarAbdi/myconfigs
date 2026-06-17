import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SSH_STATE_CUSTOM_TYPE } from "./constants.ts";
import { isRecord } from "./util.ts";

export interface SshSessionState {
	version: 1;
	remote: string;
	remoteCwd: string;
}

function parseSshSessionState(data: unknown): SshSessionState | undefined {
	if (!isRecord(data)) return undefined;
	if (data.version !== 1) return undefined;
	if (typeof data.remote !== "string" || !data.remote.trim()) return undefined;
	if (typeof data.remoteCwd !== "string" || !data.remoteCwd.trim()) return undefined;
	return { version: 1, remote: data.remote, remoteCwd: data.remoteCwd };
}

export function getPersistedSshState(ctx: ExtensionContext): SshSessionState | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as unknown;
		if (!isRecord(entry)) continue;
		if (entry.type !== "custom") continue;
		if (entry.customType !== SSH_STATE_CUSTOM_TYPE) continue;
		return parseSshSessionState(entry.data);
	}
	return undefined;
}

export function makeSshSessionState(remote: string, remoteCwd: string): SshSessionState {
	return { version: 1, remote, remoteCwd };
}
