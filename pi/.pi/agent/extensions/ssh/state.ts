import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { SSH_STATE_CUSTOM_TYPE } from "./constants.ts";

const SshSessionStateSchema = Type.Object(
	{
		remote: Type.String({ pattern: "\\S" }),
		remoteCwd: Type.String({ pattern: "^/" }),
	},
	{ additionalProperties: false },
);

export type SshSessionState = Static<typeof SshSessionStateSchema>;

type PersistedStateEntry = { found: false } | { found: true; data: unknown };

type SshStateContext = {
	sessionManager: {
		getEntries(): SessionEntry[];
	};
};

function latestSshStateEntry(ctx: SshStateContext): PersistedStateEntry {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === SSH_STATE_CUSTOM_TYPE) {
			return { found: true, data: entry.data };
		}
	}
	return { found: false };
}

export function hasPersistedSshState(ctx: SshStateContext): boolean {
	return latestSshStateEntry(ctx).found;
}

export function getPersistedSshState(ctx: SshStateContext): SshSessionState | undefined {
	const entry = latestSshStateEntry(ctx);
	if (!entry.found) return undefined;
	if (!Value.Check(SshSessionStateSchema, entry.data)) {
		throw new Error("Invalid persisted SSH state: expected { remote, remoteCwd }");
	}
	return entry.data;
}

export function makeSshSessionState(remote: string, remoteCwd: string): SshSessionState {
	return { remote, remoteCwd };
}
