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
import { fdExcludeArgs, shellQuote } from "./shell.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createRemoteReadOps(connection: SshConnection): ReadOperations {
	return {
		readFile: async (p) => {
			const remotePath = connection.toRemotePath(p);
			try {
				return await connection.exec(`cat ${shellQuote(remotePath)}`);
			} catch (error) {
				throw new Error(`Remote file read failed: ${remotePath}\n${errorMessage(error)}`);
			}
		},
		access: async (p) => {
			const remotePath = connection.toRemotePath(p);
			try {
				await connection.exec(`test -r ${shellQuote(remotePath)}`);
			} catch (error) {
				throw new Error(`Remote file is not readable: ${remotePath}\n${errorMessage(error)}`);
			}
		},
		detectImageMimeType: async (p) => {
			try {
				const remotePath = connection.toRemotePath(p);
				const r = await connection.exec(`file --mime-type -b ${shellQuote(remotePath)}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

export function createRemoteWriteOps(connection: SshConnection): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const remotePath = connection.toRemotePath(p);
			const b64 = Buffer.from(content).toString("base64");
			try {
				await connection.exec(`printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`);
			} catch (error) {
				throw new Error(`Remote file write failed: ${remotePath}\n${errorMessage(error)}`);
			}
		},
		mkdir: async (dir) => {
			const remotePath = connection.toRemotePath(dir);
			try {
				await connection.exec(`mkdir -p ${shellQuote(remotePath)}`);
			} catch (error) {
				throw new Error(`Remote directory create failed: ${remotePath}\n${errorMessage(error)}`);
			}
		},
	};
}

export function createRemoteEditOps(connection: SshConnection): EditOperations {
	const r = createRemoteReadOps(connection);
	const w = createRemoteWriteOps(connection);
	return {
		readFile: r.readFile,
		writeFile: w.writeFile,
		access: async (p) => {
			const remotePath = connection.toRemotePath(p);
			try {
				await connection.exec(`test -r ${shellQuote(remotePath)} && test -w ${shellQuote(remotePath)}`);
			} catch (error) {
				throw new Error(`Remote file is not editable: ${remotePath}\n${errorMessage(error)}`);
			}
		},
	};
}

export function createRemoteLsOps(connection: SshConnection): LsOperations {
	return {
		exists: async (p) => {
			try {
				await connection.exec(`test -e ${shellQuote(connection.toRemotePath(p))}`);
				return true;
			} catch {
				return false;
			}
		},
		stat: async (p) => {
			const remotePath = connection.toRemotePath(p);
			const command = [
				`if [ -d ${shellQuote(remotePath)} ]; then printf d`,
				`elif [ -e ${shellQuote(remotePath)} ]; then printf f`,
				"else exit 1; fi",
			].join("; ");
			const output = await connection.exec(command);
			const kind = output.toString("utf8");
			return { isDirectory: () => kind === "d" };
		},
		readdir: async (p) => {
			const output = await connection.exec(
				[
					`dir=${shellQuote(connection.toRemotePath(p))}`,
					'find "$dir" -maxdepth 1 -mindepth 1 -exec basename {} \\;',
				].join(" && "),
			);
			return output.toString("utf8").split("\n").filter(Boolean);
		},
	};
}

export function createRemoteFindOps(connection: SshConnection): FindOperations {
	return {
		exists: async (p) => {
			try {
				await connection.exec(`test -e ${shellQuote(connection.toRemotePath(p))}`);
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const searchPath = connection.toRemotePath(cwd);
			const optionExcludes = options.ignore.flatMap((ignore) => {
				if (ignore.includes("node_modules")) return ["node_modules"];
				if (ignore.includes(".git")) return [".git"];
				return [];
			});
			const excludes = fdExcludeArgs([...new Set([...REMOTE_FD_EXCLUDES, ...optionExcludes])]);
			const args = [
				"--glob",
				"--color=never",
				"--hidden",
				"--no-require-git",
				"--max-results",
				String(options.limit),
				...excludes,
				"--",
				pattern,
				searchPath,
			];
			const command = `${shellQuote(connection.requireFdPath())} ${args.map(shellQuote).join(" ")}`;
			const output = await connection.exec(command);
			return output.toString("utf8").split("\n").filter(Boolean);
		},
	};
}

export function createRemoteBashOps(connection: SshConnection): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout }) => {
			const pathDirs = [
				connection.remotePythonUvCommandsBinDir,
				connection.remoteUvBinDir,
				connection.remoteToolBinDir,
			].filter((dir): dir is string => dir !== undefined);
			const pathPrefix = pathDirs.length > 0
				? `export PATH=${pathDirs.map(shellQuote).join(":")}:"$PATH"; `
				: "";
			const cmd = `${pathPrefix}cd ${shellQuote(connection.toRemotePath(cwd))} && ${command}`;
			return connection.execStreaming(cmd, { onData, signal, timeout });
		},
	};
}
