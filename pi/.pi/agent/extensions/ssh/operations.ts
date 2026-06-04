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

export function createRemoteReadOps(connection: SshConnection): ReadOperations {
	return {
		readFile: (p) => connection.exec(`cat ${shellQuote(connection.toRemotePath(p))}`),
		access: (p) => connection.exec(`test -r ${shellQuote(connection.toRemotePath(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await connection.exec(`file --mime-type -b ${shellQuote(connection.toRemotePath(p))}`);
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
			const b64 = Buffer.from(content).toString("base64");
			await connection.exec(`printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(connection.toRemotePath(p))}`);
		},
		mkdir: (dir) => connection.exec(`mkdir -p ${shellQuote(connection.toRemotePath(dir))}`).then(() => {}),
	};
}

export function createRemoteEditOps(connection: SshConnection): EditOperations {
	const r = createRemoteReadOps(connection);
	const w = createRemoteWriteOps(connection);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
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
			const output = await connection.exec(
				`if [ -d ${shellQuote(connection.toRemotePath(p))} ]; then printf d; elif [ -e ${shellQuote(connection.toRemotePath(p))} ]; then printf f; else exit 1; fi`,
			);
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
			const pathPrefix = pathDirs.length > 0 ? `export PATH=${pathDirs.map(shellQuote).join(":")}:"$PATH"; ` : "";
			const cmd = `${pathPrefix}cd ${shellQuote(connection.toRemotePath(cwd))} && ${command}`;
			return connection.execStreaming(cmd, { onData, signal, timeout });
		},
	};
}
