import assert from "node:assert/strict";
import { test } from "node:test";
import registerUv from "../uv.ts";

type EventHandler = (event: Record<string, any>) => unknown;

function register(): Map<string, EventHandler> {
  const handlers = new Map<string, EventHandler>();
  registerUv({
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
  } as never);
  return handlers;
}

function bashEvent(command: string, toolName = "bash"): Record<string, any> {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName,
    input: { command },
  };
}

test("uv prepends its Python shim to ordinary bash commands", async () => {
  const toolCall = register().get("tool_call");
  assert.ok(toolCall);
  const event = bashEvent("git diff --cached");
  assert.equal(await toolCall(event), undefined);
  assert.notEqual(event.input.command, "git diff --cached");
  assert.match(event.input.command, /^export PATH=/);
  assert.ok(event.input.command.endsWith("git diff --cached"));
});

test("host_bash receives the same local shim outside SSH mode", async () => {
  const toolCall = register().get("tool_call");
  assert.ok(toolCall);
  const event = bashEvent("echo hello", "host_bash");
  await toolCall(event);
  assert.match(event.input.command, /^export PATH=/);
  assert.ok(event.input.command.endsWith("echo hello"));
});

test("disabled Python package tooling is blocked before command rewriting", async () => {
  const toolCall = register().get("tool_call");
  assert.ok(toolCall);
  const event = bashEvent("pip install requests");
  const result = await toolCall(event) as { block?: boolean; reason?: string } | undefined;
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /pip is disabled/);
  assert.equal(event.input.command, "pip install requests");
});

test("user bash receives the same disabled-tool guidance", () => {
  const userBash = register().get("user_bash");
  assert.ok(userBash);
  const result = userBash({ command: "python -m venv .venv" }) as {
    result?: { output?: string; exitCode?: number };
  };
  assert.equal(result.result?.exitCode, 1);
  assert.match(result.result?.output ?? "", /python -m venv.*disabled/i);
});
