// Shared generator for the uv.ts and ssh/ python shims, kept under lib/ on purpose: pi
// auto-loads every top-level extensions/*.ts as an extension and errors if it has no
// default export. Non-extension modules must live in a subdir (pi only descends into
// subdirs for index.ts/package.json).
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "./proc.ts";

export const PYTHON_UV_COMMAND_NAMES = ["pip", "pip3", "poetry", "python", "python3"] as const;
export type PythonUvCommandName = (typeof PYTHON_UV_COMMAND_NAMES)[number];

export interface LocalPythonUvCommands {
	rootDir: string;
	archivePath: string;
	binDir: string;
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
	return [
		"#!/bin/bash",
		`echo "Error: bare ${name} is disabled. Use uv instead:" >&2`,
		'echo "" >&2',
		'echo "  To run a script: uv run python script.py" >&2',
		'echo "  To run a module: uv run python -m module" >&2',
		'echo "  To run inline code: uv run python -c CODE" >&2',
		'echo "" >&2',
		"exit 1",
		"",
	].join("\n");
}

function commandContents(name: PythonUvCommandName): string {
	if (name === "pip") return pipCommand("pip");
	if (name === "pip3") return pipCommand("pip3");
	if (name === "poetry") return poetryCommand();
	return pythonCommand(name);
}

export function pythonUvCommandsCacheKey(): string {
	const hash = createHash("sha256");
	for (const name of PYTHON_UV_COMMAND_NAMES) {
		hash.update(`${name}\0${commandContents(name)}\0`);
	}
	return hash.digest("hex").slice(0, 16);
}

async function writePythonUvCommandScripts(binDir: string): Promise<void> {
	await mkdir(binDir, { recursive: true });
	for (const name of PYTHON_UV_COMMAND_NAMES) {
		const target = join(binDir, name);
		await writeFile(target, commandContents(name), "utf8");
		await chmod(target, 0o755);
	}
}

function descriptor(rootDir: string): LocalPythonUvCommands {
	const binDir = join(rootDir, "bin");
	return {
		rootDir,
		archivePath: join(rootDir, PYTHON_UV_COMMANDS_ARCHIVE),
		binDir,
	};
}

export async function ensureLocalPythonUvCommands(): Promise<LocalPythonUvCommands> {
	const rootDir = pythonUvCommandsRoot();
	const parentDir = dirname(rootDir);
	const tmpDir = join(parentDir, `.tmp-python-uv-commands-${process.pid}-${Date.now()}`);
	const tmp = descriptor(tmpDir);

	await mkdir(parentDir, { recursive: true });
	await rm(tmpDir, { recursive: true, force: true });
	try {
		await writePythonUvCommandScripts(tmp.binDir);
		await runCommand("tar", ["czf", tmp.archivePath, "-C", tmp.rootDir, "bin"]);
		await rm(rootDir, { recursive: true, force: true });
		await rename(tmpDir, rootDir);
	} catch (error) {
		await rm(tmpDir, { recursive: true, force: true });
		throw error;
	}

	return descriptor(rootDir);
}
