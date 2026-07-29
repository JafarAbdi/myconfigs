import assert from "node:assert/strict";
import { SshConnection } from "./connection.ts";
import {
	applySshConnectionDescriptor,
	makeSshConnectionDescriptor,
	parseSshConnectionDescriptor,
	readDelegateChildSshDescriptor,
	type SshConnectionDescriptor,
} from "./descriptor.ts";

const descriptor: SshConnectionDescriptor = {
	remote: "dev@example.test",
	remoteCwd: "/srv/project",
	remoteHome: "/home/dev",
	fdPath: "/opt/pi/bin/fd",
	rgPath: "/usr/bin/rg",
	fzfPath: "/opt/pi/bin/fzf",
	remoteToolBinDir: "/opt/pi/bin",
	remotePythonUvCommandsBinDir: "/opt/pi/python/bin",
	remoteUvBinDir: "/home/dev/.local/bin",
};

assert.deepEqual(parseSshConnectionDescriptor(JSON.stringify(descriptor)), descriptor);
assert.equal(readDelegateChildSshDescriptor({ PI_SSH_DESCRIPTOR: JSON.stringify(descriptor) }), undefined);
assert.deepEqual(
	readDelegateChildSshDescriptor({
		PI_DELEGATE_CHILD: "1",
		PI_SSH_DESCRIPTOR: JSON.stringify(descriptor),
	}),
	descriptor,
);
assert.throws(
	() => readDelegateChildSshDescriptor({ PI_DELEGATE_CHILD: "1" }),
	/requires PI_SSH_DESCRIPTOR/,
);
assert.throws(() => parseSshConnectionDescriptor("not-json"), /expected JSON/);
assert.throws(
	() => parseSshConnectionDescriptor(JSON.stringify({ ...descriptor, fdPath: "bin/fd" })),
	/fdPath must be an absolute remote path/,
);

const connection = new SshConnection(descriptor.remote, "/tmp/local");
applySshConnectionDescriptor(connection, descriptor);
assert.equal(connection.remoteCwd, descriptor.remoteCwd);
assert.equal(connection.remoteHome, descriptor.remoteHome);
assert.equal(connection.requireFdPath(), descriptor.fdPath);
assert.equal(connection.requireRgPath(), descriptor.rgPath);
assert.equal(connection.requireFzfPath(), descriptor.fzfPath);
assert.equal(connection.remoteToolBinDir, descriptor.remoteToolBinDir);
assert.equal(connection.remotePythonUvCommandsBinDir, descriptor.remotePythonUvCommandsBinDir);
assert.equal(connection.remoteUvBinDir, descriptor.remoteUvBinDir);
assert.deepEqual(makeSshConnectionDescriptor(connection), descriptor);

console.log("ssh descriptor: ok");
