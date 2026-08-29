import assert from "node:assert/strict";
import test from "node:test";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SSH_STATE_CUSTOM_TYPE } from "./constants.ts";
import { getPersistedSshState, hasPersistedSshState, makeSshSessionState } from "./state.ts";

function contextWithEntries(entries: SessionEntry[]) {
	return { sessionManager: { getEntries: () => entries } };
}

function sshEntry<T>(data: T): CustomEntry<T> {
	return {
		type: "custom",
		id: "test-entry",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: SSH_STATE_CUSTOM_TYPE,
		data,
	};
}

test("returns no state when the session has no SSH entry", () => {
	const context = contextWithEntries([]);
	assert.equal(hasPersistedSshState(context), false);
	assert.equal(getPersistedSshState(context), undefined);
});

test("returns the latest minimal SSH state", () => {
	const state = makeSshSessionState("dev@example.test", "/srv/project");
	const context = contextWithEntries([sshEntry({ remote: "old.example.test", remoteCwd: "/old" }), sshEntry(state)]);
	assert.equal(hasPersistedSshState(context), true);
	assert.deepEqual(getPersistedSshState(context), state);
});

test("marks malformed and obsolete state as present, then fails loudly", () => {
	for (const data of [
		undefined,
		{ remote: "host", remoteCwd: "relative" },
		{ version: 1, remote: "host", remoteCwd: "/work" },
	]) {
		const context = contextWithEntries([sshEntry(data)]);
		assert.equal(hasPersistedSshState(context), true);
		assert.throws(() => getPersistedSshState(context), /Invalid persisted SSH state/u);
	}
});
