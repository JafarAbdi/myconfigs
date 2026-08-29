import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRemoteAtAutocompleteProvider } from "./autocomplete.ts";
import { SshConnection } from "./connection.ts";
import { createRemoteBashOps, createRemoteFindOps } from "./operations.ts";

const SFTP_SERVER = "/usr/lib/openssh/sftp-server";
const SYSTEM_BINARIES = ["bash", "cat", "chmod", "env", "head", "mkdir", "mv", "rm", "setsid", "sort"];

interface FakeRemote {
	directory: string;
	hostHome: string;
	remoteBin: string;
	remoteHome: string;
	toolLog: string;
	unameLog: string;
	restoreEnvironment: () => void;
}

async function writeExecutable(path: string, content: string): Promise<void> {
	await writeFile(path, content);
	await chmod(path, 0o755);
}

async function createFakeRemote(): Promise<FakeRemote> {
	const directory = await mkdtemp(join(tmpdir(), "pi-ssh-bootstrap-test-"));
	const hostBin = join(directory, "host-bin");
	const hostHome = join(directory, "host-home");
	const remoteBin = join(directory, "remote-bin");
	const remoteHome = join(directory, "remote-home");
	const toolLog = join(directory, "tools.log");
	const unameLog = join(directory, "uname.log");
	await Promise.all([mkdir(hostBin), mkdir(hostHome), mkdir(remoteBin), mkdir(remoteHome)]);

	for (const binary of SYSTEM_BINARIES) await symlink(`/usr/bin/${binary}`, join(remoteBin, binary));
	await writeExecutable(
		join(remoteBin, "uname"),
		`#!/bin/bash
printf '%s\n' "$*" >> "$SSH_UNAME_LOG"
case "$1" in
  -s) printf 'Linux\n' ;;
  -m) printf 'x86_64\n' ;;
  *) exit 2 ;;
esac
`,
	);
	await writeExecutable(
		join(hostBin, "ssh"),
		`#!/bin/bash
set -eu
args=("$@")
count=$#
if (( count >= 3 )) && [[ "\${args[count-3]}" == "-s" && "\${args[count-1]}" == "sftp" ]]; then
  cd "$SSH_REMOTE_HOME"
  exec "$SFTP_SERVER"
fi
for ((index = 0; index < count; index++)); do
  if [[ "\${args[index]}" == "fake-remote" ]]; then
    export HOME="$SSH_REMOTE_HOME"
    export PATH="$SSH_REMOTE_PATH"
    exec "\${args[@]:index+1}"
  fi
done
exit 2
`,
	);

	const previous = {
		HOME: process.env.HOME,
		PATH: process.env.PATH,
		SFTP_SERVER: process.env.SFTP_SERVER,
		SSH_REMOTE_HOME: process.env.SSH_REMOTE_HOME,
		SSH_REMOTE_PATH: process.env.SSH_REMOTE_PATH,
		SSH_TOOL_LOG: process.env.SSH_TOOL_LOG,
		SSH_UNAME_LOG: process.env.SSH_UNAME_LOG,
	};
	process.env.HOME = hostHome;
	process.env.PATH = `${hostBin}:${previous.PATH ?? ""}`;
	process.env.SFTP_SERVER = SFTP_SERVER;
	process.env.SSH_REMOTE_HOME = remoteHome;
	process.env.SSH_REMOTE_PATH = remoteBin;
	process.env.SSH_TOOL_LOG = toolLog;
	process.env.SSH_UNAME_LOG = unameLog;

	return {
		directory,
		hostHome,
		remoteBin,
		remoteHome,
		toolLog,
		unameLog,
		restoreEnvironment: () => {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

function fakeToolContent(output = ""): string {
	return `#!/bin/bash
printf '%s %s\n' "$0" "$*" >> "$SSH_TOOL_LOG"
${output}
`;
}

async function closeAndRemove(connection: SshConnection | undefined, remote: FakeRemote): Promise<void> {
	await connection?.close();
	remote.restoreEnvironment();
	await rm(remote.directory, { recursive: true, force: true });
}

test("prefers absolute remote-native search tools without detecting a platform", async () => {
	const remote = await createFakeRemote();
	let connection: SshConnection | undefined;
	try {
		const cache = join(remote.remoteHome, ".cache", "pi", "ssh-tools");
		await mkdir(cache, { recursive: true });
		for (const tool of ["fd", "rg", "fzf"]) {
			await writeExecutable(join(remote.remoteBin, tool), fakeToolContent());
			await writeExecutable(join(cache, tool), fakeToolContent("exit 99"));
		}
		connection = new SshConnection("fake-remote");
		const phases: string[] = [];
		const connecting = connection.connect((phase) => phases.push(phase));
		assert.equal(connection.connect(), connecting);
		await connecting;
		assert.deepEqual(phases, ["connecting", "checking tools"]);
		assert.equal(connection.fdPath, join(remote.remoteBin, "fd"));
		assert.equal(connection.rgPath, join(remote.remoteBin, "rg"));
		assert.equal(connection.fzfPath, join(remote.remoteBin, "fzf"));
		await assert.rejects(readFile(remote.unameLog), { code: "ENOENT" });
	} finally {
		await closeAndRemove(connection, remote);
	}
});

test("reuses the exact remote cache without detecting a platform", async () => {
	const remote = await createFakeRemote();
	let connection: SshConnection | undefined;
	try {
		const cache = join(remote.remoteHome, ".cache", "pi", "ssh-tools");
		await mkdir(cache, { recursive: true });
		for (const tool of ["fd", "rg", "fzf"]) {
			await writeExecutable(join(cache, tool), fakeToolContent());
		}
		connection = new SshConnection("fake-remote");
		const phases: string[] = [];
		await connection.connect((phase) => phases.push(phase));
		assert.deepEqual(phases, ["connecting", "checking tools"]);
		assert.equal(connection.fdPath, join(cache, "fd"));
		assert.equal(connection.rgPath, join(cache, "rg"));
		assert.equal(connection.fzfPath, join(cache, "fzf"));
		await assert.rejects(readFile(remote.unameLog), { code: "ENOENT" });
	} finally {
		await closeAndRemove(connection, remote);
	}
});

test("uploads missing cached tools once and uses explicit paths and the cache PATH", async () => {
	const remote = await createFakeRemote();
	let connection: SshConnection | undefined;
	try {
		const hostCache = join(remote.hostHome, ".cache", "pi", "ssh-tools", "linux_amd64");
		await mkdir(hostCache, { recursive: true });
		await writeExecutable(join(hostCache, "fd"), fakeToolContent("printf 'candidate\\n'"));
		await writeExecutable(join(hostCache, "rg"), fakeToolContent("exit 1"));
		await writeExecutable(join(hostCache, "fzf"), fakeToolContent("cat"));

		connection = new SshConnection("fake-remote");
		const phases: string[] = [];
		await connection.connect((phase) => phases.push(phase));
		assert.deepEqual(phases, ["connecting", "checking tools", "uploading fd", "uploading rg", "uploading fzf"]);
		const remoteCache = join(remote.remoteHome, ".cache", "pi", "ssh-tools");
		assert.equal(connection.fdPath, join(remoteCache, "fd"));
		assert.equal(connection.rgPath, join(remoteCache, "rg"));
		assert.equal(connection.fzfPath, join(remoteCache, "fzf"));
		assert.equal((await readFile(remote.unameLog, "utf8")).trim().split("\n").length, 2);
		assert.deepEqual((await readdir(remoteCache)).sort(), ["fd", "fzf", "rg"]);
		for (const tool of ["fd", "rg", "fzf"]) {
			assert.equal((await stat(join(remoteCache, tool))).mode & 0o777, 0o755);
		}

		assert.deepEqual(await createRemoteFindOps(connection).glob("*", ".", { limit: 10, ignore: [] }), ["candidate"]);
		const current = {
			getSuggestions: async () => null,
			applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
		};
		const provider = createRemoteAtAutocompleteProvider(
			current,
			() => connection ?? null,
			(error) => {
				throw error;
			},
		);
		const controller = new AbortController();
		const suggestions = await provider.getSuggestions(["@can"], 0, 4, { signal: controller.signal });
		assert.equal(suggestions?.items[0]?.value, "@candidate");

		let bashOutput = "";
		await createRemoteBashOps(connection).exec(
			`printf '%s\\n' "$PATH"; printf '%s|%s' "$PI_FORWARDED" "\${LOCAL_ONLY-unset}"`,
			".",
			{
				onData: (data) => {
					bashOutput += data.toString("utf8");
				},
				env: { PI_FORWARDED: "yes", LOCAL_ONLY: "no" },
			},
		);
		assert.equal(bashOutput, `${remoteCache}:${remote.remoteBin}\nyes|unset`);
		const toolLog = await readFile(remote.toolLog, "utf8");
		assert.match(toolLog, new RegExp(`^${join(remoteCache, "fd")} `, "mu"));
		assert.match(toolLog, new RegExp(`^${join(remoteCache, "fzf")} `, "mu"));

		await connection.close();
		connection = new SshConnection("fake-remote");
		await writeFile(remote.unameLog, "");
		await connection.connect();
		assert.equal(await readFile(remote.unameLog, "utf8"), "");
	} finally {
		await closeAndRemove(connection, remote);
	}
});
