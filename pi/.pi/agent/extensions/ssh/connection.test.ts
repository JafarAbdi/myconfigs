import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SshConnection } from "./connection.ts";
import {
	createRemoteBashOps,
	createRemoteEditOps,
	createRemoteLsOps,
	createRemoteReadOps,
	createRemoteWriteOps,
} from "./operations.ts";

const SFTP_SERVER = "/usr/lib/openssh/sftp-server";

test("validates remote command timeouts before spawning", () => {
	const connection = new SshConnection("unused");
	for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(
			() => connection.execStreaming("true", { onData: () => {}, timeout }),
			/Invalid timeout: must be a finite number of seconds/u,
		);
	}
	assert.throws(
		() => connection.execStreaming("true", { onData: () => {}, timeout: 2_147_483.648 }),
		/Invalid timeout: maximum is 2147483\.647 seconds/u,
	);
});

test("uses OpenSSH exec and a persistent SFTP subsystem", { timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ssh-connection-test-"));
	const binDirectory = join(directory, "bin");
	const sshPath = join(binDirectory, "ssh");
	const logPath = join(directory, "ssh.log");
	await mkdir(binDirectory);
	await writeFile(
		sshPath,
		`#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$SSH_TEST_LOG"
args=("$@")
count=$#
if (( count >= 3 )) && [[ "\${args[count-3]}" == "-s" && "\${args[count-1]}" == "sftp" ]]; then
  exec "$SFTP_SERVER"
fi
for ((index = 0; index < count; index++)); do
  if [[ "\${args[index]}" == "fake-remote" ]]; then
    exec "\${args[@]:index+1}"
  fi
done
exit 2
`,
	);
	await chmod(sshPath, 0o755);

	const previousPath = process.env.PATH;
	const previousLog = process.env.SSH_TEST_LOG;
	const previousServer = process.env.SFTP_SERVER;
	process.env.PATH = `${binDirectory}:${previousPath ?? ""}`;
	process.env.SSH_TEST_LOG = logPath;
	process.env.SFTP_SERVER = SFTP_SERVER;

	const connection = new SshConnection("fake-remote");
	try {
		await connection.connect();
		await connection.resolveRemoteCwd(directory);
		const read = createRemoteReadOps(connection);
		const write = createRemoteWriteOps(connection);
		const edit = createRemoteEditOps(connection);
		const ls = createRemoteLsOps(connection);
		await write.mkdir("nested/directory");
		await write.mkdir("nested/directory");
		await write.writeFile("nested/directory/file.txt", "remote data");
		assert.equal((await read.readFile("nested/directory/file.txt")).toString(), "remote data");
		await edit.access("nested/directory/file.txt");
		assert.equal(await ls.exists("nested/directory/file.txt"), true);
		assert.equal(await ls.exists("missing"), false);
		assert.equal((await ls.stat("nested/directory")).isDirectory(), true);
		assert.deepEqual(await ls.readdir("nested/directory"), ["file.txt"]);
		await connection.sftp.writeFile(connection.toRemotePath("image.png"), Buffer.from("89504e470d0a1a0a", "hex"));
		assert.equal(await read.detectImageMimeType?.("image.png"), "image/png");
		assert.equal((await connection.exec("printf command-data")).toString(), "command-data");
		let listing = "";
		await createRemoteBashOps(connection).exec("find . -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort", ".", {
			onData: (data) => {
				listing += data.toString("utf8");
			},
		});
		assert.match(listing, /^image\.png$/mu);

		const controller = new AbortController();
		const cancelled = connection.execStreaming("printf ready; sleep 30 & wait", {
			signal: controller.signal,
			onData: (data) => {
				if (data.includes("ready")) controller.abort();
			},
		});
		await assert.rejects(cancelled, /^Error: aborted$/u);
	} finally {
		await connection.close();
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousLog === undefined) delete process.env.SSH_TEST_LOG;
		else process.env.SSH_TEST_LOG = previousLog;
		if (previousServer === undefined) delete process.env.SFTP_SERVER;
		else process.env.SFTP_SERVER = previousServer;
	}

	const invocations = await readFile(logPath, "utf8");
	assert.match(invocations, /-s fake-remote sftp/u);
	assert.match(invocations, /fake-remote env -u BASH_ENV bash/u);
	await rm(directory, { recursive: true, force: true });
});
