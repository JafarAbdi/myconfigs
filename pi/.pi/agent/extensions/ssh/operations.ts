import { posix } from "node:path";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { SshConnection } from "./connection.ts";
import { REMOTE_FD_EXCLUDES } from "./constants.ts";
import { RemoteFileNotFoundError, type SftpAttrs, type SftpClient } from "./sftp.ts";
import { fdExcludeArgs, shellQuote } from "./shell.ts";

const FILE_TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;

function isDirectory(attrs: SftpAttrs): boolean {
	if (attrs.permissions === undefined) {
		throw new Error("SFTP STAT response did not include file permissions");
	}
	return (attrs.permissions & FILE_TYPE_MASK) === DIRECTORY_TYPE;
}

function detectImageMimeType(header: Buffer): string | null {
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
	if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (header.length >= 6) {
		const signature = header.subarray(0, 6).toString("ascii");
		if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
	}
	if (
		header.length >= 12 &&
		header.subarray(0, 4).toString("ascii") === "RIFF" &&
		header.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d) return "image/bmp";
	return null;
}

async function mkdirp(sftp: SftpClient, directory: string): Promise<void> {
	const normalized = posix.normalize(directory);
	if (!posix.isAbsolute(normalized)) throw new Error(`Remote directory must be absolute: ${directory}`);
	let current = "/";
	for (const part of normalized.split("/").filter(Boolean)) {
		current = posix.join(current, part);
		try {
			await sftp.mkdir(current);
		} catch (mkdirError) {
			try {
				if (isDirectory(await sftp.stat(current))) continue;
			} catch (statError) {
				if (!(statError instanceof RemoteFileNotFoundError)) throw statError;
			}
			throw mkdirError;
		}
	}
}

export function createRemoteReadOps(connection: SshConnection): ReadOperations {
	return {
		readFile: (path) => connection.sftp.readFile(connection.toRemotePath(path)),
		access: (path) => connection.sftp.access(connection.toRemotePath(path), "read"),
		detectImageMimeType: async (path) =>
			detectImageMimeType(await connection.sftp.readFile(connection.toRemotePath(path), 12)),
	};
}

export function createRemoteWriteOps(connection: SshConnection): WriteOperations {
	return {
		writeFile: (path, content) =>
			connection.sftp.writeFile(connection.toRemotePath(path), Buffer.from(content, "utf8")),
		mkdir: (directory) => mkdirp(connection.sftp, connection.toRemotePath(directory)),
	};
}

export function createRemoteEditOps(connection: SshConnection): EditOperations {
	const read = createRemoteReadOps(connection);
	const write = createRemoteWriteOps(connection);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: (path) => connection.sftp.access(connection.toRemotePath(path), "read-write"),
	};
}

export function createRemoteLsOps(connection: SshConnection): LsOperations {
	return {
		exists: (path) => connection.sftp.exists(connection.toRemotePath(path)),
		stat: async (path) => {
			const attrs = await connection.sftp.stat(connection.toRemotePath(path));
			return { isDirectory: () => isDirectory(attrs) };
		},
		readdir: (path) => connection.sftp.readdir(connection.toRemotePath(path)),
	};
}

export function createRemoteFindOps(connection: SshConnection): FindOperations {
	return {
		exists: (path) => connection.sftp.exists(connection.toRemotePath(path)),
		glob: async (pattern, cwd, options) => {
			const args = [
				"--glob",
				"--color=never",
				"--hidden",
				"--no-require-git",
				"--max-results",
				String(options.limit),
				...fdExcludeArgs(REMOTE_FD_EXCLUDES),
				"--",
				pattern,
				connection.toRemotePath(cwd),
			];
			const output = await connection.exec(
				`${shellQuote(connection.requireFdPath())} ${args.map((arg) => shellQuote(arg)).join(" ")}`,
			);
			return output.toString("utf8").split("\n").filter(Boolean);
		},
	};
}

function remoteExportPrefix(connection: SshConnection, env?: NodeJS.ProcessEnv): string {
	const exports = [`export PATH=${shellQuote(connection.remoteToolCacheDir)}:"$PATH"`];
	for (const [key, value] of Object.entries(env ?? {})) {
		if (!key.startsWith("PI_") || value === undefined) continue;
		exports.push(`export ${key}=${shellQuote(value)}`);
	}
	return `${exports.join("; ")}; `;
}

export function createRemoteBashOps(connection: SshConnection): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			const remoteCommand = `${remoteExportPrefix(connection, env)}cd ${shellQuote(connection.toRemotePath(cwd))} && ${command}`;
			return connection.execStreaming(remoteCommand, {
				onData,
				signal,
				timeout,
			});
		},
	};
}
