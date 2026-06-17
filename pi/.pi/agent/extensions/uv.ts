/**
 * UV Extension - Forces uv-based Python workflows.
 *
 * Prepends a bin dir of error stubs (python/python3/pip/pip3/poetry) to PATH so
 * bare invocations fail with guidance to use `uv run python ...`. The stubs never
 * call uv, so no nested `uv run` lock can form. SSH backends own their own copy of
 * these stubs, so this PATH injection is skipped in SSH mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureLocalPythonUvCommands } from "./lib/python-uv-commands.ts";

const pythonShimBinPromise = ensureLocalPythonUvCommands().then((commands) => commands.binDir);
pythonShimBinPromise.catch(() => {});

// PI_SSH_REMOTE is published by the ssh extension (ssh/subagent-env.ts) whenever an SSH
// connection is active, including inside subagent children. Its presence means execution
// is remote, so the local python-shim PATH injection below must be skipped.
function isSshModeActive(): boolean {
  return Boolean(process.env.PI_SSH_REMOTE);
}

function getBlockedCommandMessage(command: string): string | null {
  const pipCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip\s*(?:$|\s)/m;
  const pip3CommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip3\s*(?:$|\s)/m;
  const poetryCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?poetry\s*(?:$|\s)/m;

  const pythonPipPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*pip\b|\s-mpip\b)/m;
  const pythonVenvPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*venv\b|\s-mvenv\b)/m;
  const pythonPyCompilePattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*py_compile\b|\s-mpy_compile\b)/m;

  if (pipCommandPattern.test(command)) {
    return [
      "Error: pip is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pip3CommandPattern.test(command)) {
    return [
      "Error: pip3 is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (poetryCommandPattern.test(command)) {
    return [
      "Error: poetry is disabled. Use uv instead:",
      "",
      "  To initialize a project: uv init",
      "  To add a dependency: uv add PACKAGE",
      "  To sync dependencies: uv sync",
      "  To run commands: uv run COMMAND",
      "",
    ].join("\n");
  }

  if (pythonPipPattern.test(command)) {
    return [
      "Error: 'python -m pip' is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pythonVenvPattern.test(command)) {
    return [
      "Error: 'python -m venv' is disabled. Use uv instead:",
      "",
      "  To create a virtual environment: uv venv",
      "",
    ].join("\n");
  }

  if (pythonPyCompilePattern.test(command)) {
    return [
      "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
      "",
    ].join("\n");
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const blockedMessage = getBlockedCommandMessage(event.input.command);
    if (blockedMessage) {
      return { block: true, reason: blockedMessage };
    }

    if (isSshModeActive()) return;

    const shimBin = await pythonShimBinPromise;
    event.input.command = [`export PATH="${shimBin}:$PATH"`, event.input.command].join("\n");
  });

  pi.on("user_bash", (event) => {
    const blockedMessage = getBlockedCommandMessage(event.command);
    if (!blockedMessage) return;

    return {
      result: {
        output: blockedMessage,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
