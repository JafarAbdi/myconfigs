import assert from "node:assert/strict";
import test from "node:test";
import {
	makeSshConnectionDescriptor,
	parseSshConnectionDescriptor,
	readDelegateChildSshDescriptor,
	type SshConnectionDescriptor,
} from "./descriptor.ts";

const descriptor: SshConnectionDescriptor = {
	remote: "dev@example.test",
	remoteCwd: "/srv/project",
};

test("parses the minimal SSH descriptor", () => {
	assert.deepEqual(parseSshConnectionDescriptor(JSON.stringify(descriptor)), descriptor);
	assert.deepEqual(
		makeSshConnectionDescriptor({
			remote: descriptor.remote,
			remoteCwd: descriptor.remoteCwd,
		}),
		descriptor,
	);
});

test("reads descriptors only for marked delegate children", () => {
	assert.equal(
		readDelegateChildSshDescriptor({
			PI_SSH_DESCRIPTOR: JSON.stringify(descriptor),
		}),
		undefined,
	);
	assert.deepEqual(
		readDelegateChildSshDescriptor({
			PI_DELEGATE_CHILD: "1",
			PI_SSH_DESCRIPTOR: JSON.stringify(descriptor),
		}),
		descriptor,
	);
	assert.throws(() => readDelegateChildSshDescriptor({ PI_DELEGATE_CHILD: "1" }), /requires PI_SSH_DESCRIPTOR/u);
});

test("rejects malformed and non-minimal descriptors", () => {
	assert.throws(() => parseSshConnectionDescriptor("not-json"), /expected JSON/u);
	assert.throws(
		() => parseSshConnectionDescriptor(JSON.stringify({ ...descriptor, remoteHome: "/home/dev" })),
		/expected \{ remote, remoteCwd \}/u,
	);
	assert.throws(
		() => parseSshConnectionDescriptor(JSON.stringify({ ...descriptor, remoteCwd: "relative" })),
		/expected \{ remote, remoteCwd \}/u,
	);
});
