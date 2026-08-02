import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { COMMIT_INSPECTION_COMMANDS } from "../juruc/commit-message.ts";
import registerUv from "../uv.ts";
import { acquireTestLock } from "../juruc/test-lock.ts";

type EventHandler = (event: Record<string, unknown>) => unknown;

function register(): Map<string, EventHandler> {
  const handlers = new Map<string, EventHandler>();
  registerUv({
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
  } as never);
  return handlers;
}

function bashEvent(input: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_call", toolCallId: "call-1", toolName: "bash", input };
}

test("configured UV/JURUC stack preserves exact Bash input through execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "juruc-uv-stack-test-"));
  const prompts = join(root, "prompts");
  mkdirSync(prompts);
  const grill = join(prompts, "grill.md");
  const commit = join(prompts, "commit-message.md");
  writeFileSync(grill, "grill\n");
  writeFileSync(commit, "commit\n");
  const releaseLock = await acquireTestLock("juruc-extension-node-modules.lock");
  const extensionDirectory = dirname(new URL("../juruc/runtime-harness.ts", import.meta.url).pathname);
  const localModules = join(extensionDirectory, "node_modules");
  const piExecutable = process.env.PATH?.split(delimiter).map((directory) => join(directory, "pi")).find(existsSync);
  const piPackage = process.env.PI_PACKAGE_DIR ?? (piExecutable ? join(dirname(realpathSync(piExecutable)), "..") : undefined);
  if (!piPackage || existsSync(localModules)) throw new Error("Pi test dependency setup is unavailable");
  mkdirSync(join(localModules, "@earendil-works"), { recursive: true });
  for (const name of ["pi-ai", "pi-tui"])
    symlinkSync(join(piPackage, "node_modules", "@earendil-works", name), join(localModules, "@earendil-works", name), "dir");
  symlinkSync(piPackage, join(localModules, "@earendil-works", "pi-coding-agent"), "dir");
  symlinkSync(join(piPackage, "node_modules", "typebox"), join(localModules, "typebox"), "dir");
  const { createRuntimeHarness } = await import("../juruc/runtime-harness.ts");
  const { SessionManager } = await import(`file://${piPackage}/dist/index.js`);
  let harness: Awaited<ReturnType<typeof createRuntimeHarness>> | undefined;
  try {
    harness = await createRuntimeHarness({
    agentDir: join(root, "agent"),
    cwd: root,
    sessionManager: SessionManager.create(root),
    promptTemplates: [grill, commit],
    beforeJuruc: [registerUv],
    afterJuruc: [registerUv],
    });
    const command = COMMIT_INSPECTION_COMMANDS[0];
    const event = bashEvent({ command });
    const result = await harness.runtime.session.extensionRunner.emitToolCall(event as never);
    assert.equal(result, undefined);
    assert.deepEqual(event.input, { command });
    let executed: string | undefined;
    await harness.runtime.session.executeBash(command, undefined, {
      operations: {
        exec: async (actual) => {
          executed = actual;
          return { exitCode: 0 };
        },
      },
    });
    assert.equal(executed, command, "the spied executor receives the unchanged exact command");

    for (const input of [{ command, timeout: 1 }, { command, unknownKey: true }]) {
      const original = structuredClone(input);
      const nearMiss = bashEvent(input);
      const nearResult = await harness.runtime.session.extensionRunner.emitToolCall(nearMiss as never);
      assert.equal(nearResult, undefined);
      assert.notDeepEqual(nearMiss.input, original);
      executed = undefined;
      await harness.runtime.session.executeBash((nearMiss.input as { command: string }).command, undefined, {
        operations: { exec: async (actual) => { executed = actual; return { exitCode: 0 }; } },
      });
      assert.notEqual(executed, command);
    }

    const blocked = bashEvent({ command: "pip install requests" });
    const blockedResult = await harness.runtime.session.extensionRunner.emitToolCall(blocked as never) as { block?: boolean };
    assert.equal(blockedResult?.block, true);
  } finally {
    await harness?.dispose();
    rmSync(localModules, { recursive: true, force: true });
    releaseLock();
    rmSync(root, { recursive: true, force: true });
  }
});

test("uv passthrough leaves exact permitted commit-inspection input byte/key unchanged", async () => {
  const handlers = register();
  const toolCall = handlers.get("tool_call");
  assert.ok(toolCall);

  for (const command of COMMIT_INSPECTION_COMMANDS) {
    const event = bashEvent({ command });
    const result = await toolCall(event);
    assert.equal(result, undefined);
    assert.deepEqual(event.input, { command });
  }
});

test("uv passthrough still rewrites a permitted command carrying a timeout or unknown key", async () => {
  const handlers = register();
  const toolCall = handlers.get("tool_call");
  assert.ok(toolCall);
  const command = COMMIT_INSPECTION_COMMANDS[0];

  const withTimeout = bashEvent({ command, timeout: 5000 });
  await toolCall(withTimeout);
  const mutatedTimeout = (withTimeout.input as { command: string }).command;
  assert.notEqual(mutatedTimeout, command);
  assert.ok(mutatedTimeout.endsWith(command));

  const withUnknownKey = bashEvent({ command, unknownKey: true });
  await toolCall(withUnknownKey);
  const mutatedUnknown = (withUnknownKey.input as { command: string }).command;
  assert.notEqual(mutatedUnknown, command);
  assert.ok(mutatedUnknown.endsWith(command));
});

test("uv passthrough exemption is scoped to the bash tool, not host_bash", async () => {
  const handlers = register();
  const toolCall = handlers.get("tool_call");
  assert.ok(toolCall);
  const command = COMMIT_INSPECTION_COMMANDS[0];

  const event = { type: "tool_call", toolCallId: "call-1", toolName: "host_bash", input: { command } };
  await toolCall(event);
  const mutated = (event.input as { command: string }).command;
  assert.notEqual(mutated, command);
  assert.ok(mutated.endsWith(command));
});

test("uv passthrough still rewrites bash commands outside the commit-inspection allowlist", async () => {
  const handlers = register();
  const toolCall = handlers.get("tool_call");
  assert.ok(toolCall);

  const event = bashEvent({ command: "echo hello" });
  await toolCall(event);
  const mutated = (event.input as { command: string }).command;
  assert.notEqual(mutated, "echo hello");
  assert.ok(mutated.endsWith("echo hello"));
});

test("uv passthrough still blocks disabled python tooling regardless of commit-inspection input shape", async () => {
  const handlers = register();
  const toolCall = handlers.get("tool_call");
  assert.ok(toolCall);

  const event = bashEvent({ command: "pip install requests" });
  const result = await toolCall(event) as { block?: boolean; reason?: string } | undefined;
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /pip is disabled/);
});
