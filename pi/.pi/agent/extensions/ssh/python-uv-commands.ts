import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PYTHON_UV_COMMAND_NAMES = ["pip", "pip3", "poetry", "python", "python3"] as const;
export type PythonUvCommandName = (typeof PYTHON_UV_COMMAND_NAMES)[number];

export interface LocalPythonUvCommands {
	rootDir: string;
	archivePath: string;
	binDir: string;
	commands: Record<PythonUvCommandName, string>;
}

const PYTHON_UV_COMMANDS_ARCHIVE = "python-uv-commands.tar.gz";

function pythonUvCommandsRoot(): string {
	return join(homedir(), ".cache", "pi", "ssh-tools", "python-uv-commands");
}

function pipCommand(name: "pip" | "pip3"): string {
	return [
		"#!/bin/bash",
		`echo "Error: ${name} is disabled. Use uv instead:" >&2`,
		'echo "" >&2',
		'echo "  To install a package for a script: uv run --with PACKAGE python script.py" >&2',
		'echo "  To add a dependency to the project: uv add PACKAGE" >&2',
		'echo "" >&2',
		"exit 1",
		"",
	].join("\n");
}

function poetryCommand(): string {
	return [
		"#!/bin/bash",
		"",
		'echo "Error: poetry is disabled. Use uv instead:" >&2',
		'echo "" >&2',
		'echo "  To initialize a project: uv init" >&2',
		'echo "  To add a dependency: uv add PACKAGE" >&2',
		'echo "  To sync dependencies: uv sync" >&2',
		'echo "  To run commands: uv run COMMAND" >&2',
		'echo "" >&2',
		"exit 1",
		"",
	].join("\n");
}

function pythonCommand(name: "python" | "python3"): string {
	return `#!/bin/bash

for arg in "$@"; do
	case "$arg" in
		-mpip|pip)
			echo "Error: '${name} -m pip' is disabled. Use uv instead:" >&2
			echo "" >&2
			echo "  To install a package for a script: uv run --with PACKAGE python script.py" >&2
			echo "  To add a dependency to the project: uv add PACKAGE" >&2
			echo "" >&2
			exit 1
			;;
		-mvenv|venv)
			echo "Error: '${name} -m venv' is disabled. Use uv instead:" >&2
			echo "" >&2
			echo "  To create a virtual environment: uv venv" >&2
			echo "" >&2
			exit 1
			;;
		-mpy_compile|py_compile)
			echo "Error: '${name} -m py_compile' is disabled because it writes .pyc files to __pycache__." >&2
			echo "" >&2
			echo "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null" >&2
			echo "" >&2
			exit 1
			;;
	esac
done

prev=""
for arg in "$@"; do
	if [ "$prev" = "-m" ]; then
		case "$arg" in
			pip)
				echo "Error: '${name} -m pip' is disabled. Use uv instead:" >&2
				echo "" >&2
				echo "  To install a package for a script: uv run --with PACKAGE python script.py" >&2
				echo "  To add a dependency to the project: uv add PACKAGE" >&2
				echo "" >&2
				exit 1
				;;
			venv)
				echo "Error: '${name} -m venv' is disabled. Use uv instead:" >&2
				echo "" >&2
				echo "  To create a virtual environment: uv venv" >&2
				echo "" >&2
				exit 1
				;;
			py_compile)
				echo "Error: '${name} -m py_compile' is disabled because it writes .pyc files to __pycache__." >&2
				echo "" >&2
				echo "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null" >&2
				echo "" >&2
				exit 1
				;;
		esac
	fi
	prev="$arg"
done

resolve_uv_python() {
	local command_dir candidate candidate_dir
	command_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

	candidate="$(uv python find --managed-python 2>/dev/null || true)"
	if [ -n "$candidate" ] && [ -x "$candidate" ]; then
		candidate_dir="$(cd "$(dirname "$candidate")" && pwd)"
		if [ "$candidate_dir" != "$command_dir" ]; then
			echo "$candidate"
			return 0
		fi
	fi

	while IFS= read -r candidate; do
		[ -n "$candidate" ] || continue
		candidate_dir="$(cd "$(dirname "$candidate")" && pwd)"
		[ "$candidate_dir" = "$command_dir" ] && continue
		echo "$candidate"
		return 0
	done < <(type -aP python3 2>/dev/null)

	while IFS= read -r candidate; do
		[ -n "$candidate" ] || continue
		candidate_dir="$(cd "$(dirname "$candidate")" && pwd)"
		[ "$candidate_dir" = "$command_dir" ] && continue
		echo "$candidate"
		return 0
	done < <(type -aP python 2>/dev/null)

	return 1
}

UV_PYTHON="$(resolve_uv_python)"
if [ -z "$UV_PYTHON" ]; then
	echo "Error: Unable to locate a Python interpreter outside python-uv-commands." >&2
	exit 1
fi

exec uv run --python "$UV_PYTHON" python "$@"
`;
}

function commandContents(name: PythonUvCommandName): string {
	if (name === "pip") return pipCommand("pip");
	if (name === "pip3") return pipCommand("pip3");
	if (name === "poetry") return poetryCommand();
	return pythonCommand(name);
}

function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function formatCommandFailure(command: string, code: number | null, stderr: Buffer[]): string {
	const text = Buffer.concat(stderr).toString("utf8").trim();
	return text || `${command} exited with ${code ?? "unknown status"}`;
}

function runCommand(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		const stderr: Buffer[] = [];
		child.stderr.on("data", (data) => stderr.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(formatCommandFailure(command, code, stderr)));
		});
	});
}

function descriptor(rootDir: string): LocalPythonUvCommands {
	const binDir = join(rootDir, "bin");
	return {
		rootDir,
		archivePath: join(rootDir, PYTHON_UV_COMMANDS_ARCHIVE),
		binDir,
		commands: {
			pip: join(binDir, "pip"),
			pip3: join(binDir, "pip3"),
			poetry: join(binDir, "poetry"),
			python: join(binDir, "python"),
			python3: join(binDir, "python3"),
		},
	};
}

export async function ensureLocalPythonUvCommands(): Promise<LocalPythonUvCommands> {
	const rootDir = pythonUvCommandsRoot();
	const parentDir = dirname(rootDir);
	const tmpDir = join(parentDir, `.tmp-python-uv-commands-${process.pid}-${Date.now()}`);
	const tmp = descriptor(tmpDir);

	await mkdir(parentDir, { recursive: true });
	await rm(tmpDir, { recursive: true, force: true });
	await mkdir(tmp.binDir, { recursive: true });
	try {
		const commands = {} as Record<PythonUvCommandName, { sha256: string }>;
		for (const commandName of PYTHON_UV_COMMAND_NAMES) {
			const contents = commandContents(commandName);
			await writeFile(tmp.commands[commandName], contents, "utf8");
			await chmod(tmp.commands[commandName], 0o755);
			commands[commandName] = { sha256: sha256Text(contents) };
		}

		const manifest = { commands, updatedAt: new Date().toISOString() };
		await writeFile(join(tmp.rootDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		await runCommand("tar", ["czf", tmp.archivePath, "-C", tmp.rootDir, "bin", "manifest.json"]);
		await rm(rootDir, { recursive: true, force: true });
		await rename(tmpDir, rootDir);
	} catch (error) {
		await rm(tmpDir, { recursive: true, force: true });
		throw error;
	}

	return descriptor(rootDir);
}
