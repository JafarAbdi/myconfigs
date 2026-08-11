#!/usr/bin/env -S deno run --quiet --allow-read

import { diagramKind, render } from "npm:grok-mermaid@0.2.2";

const prefix = "grok-mermaid";

function fail(message: string): never {
  console.error(`${prefix}: ${message}`);
  Deno.exit(1);
}

function printUsage(): void {
  console.error(`Usage: render.ts [FILE|-]

Render Mermaid source from FILE or standard input to Unicode box-drawing art.`);
}

async function readSource(path: string | undefined): Promise<string> {
  if (path === undefined || path === "-") {
    return await new Response(Deno.stdin.readable).text();
  }

  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`cannot read ${JSON.stringify(path)}: ${message}`);
  }
}

const [path, ...extraArgs] = Deno.args;

if (path === "--help" || path === "-h") {
  printUsage();
  Deno.exit(0);
}
if (extraArgs.length > 0) {
  printUsage();
  fail("expected at most one input file");
}

const source = await readSource(path);
const art = render(source);

if (art === null) {
  const kind = diagramKind(source);
  fail(
    kind === null
      ? "input is blank or uses an unsupported diagram type"
      : `${kind} diagram could not be rendered; check its syntax or complexity`,
  );
}

console.log(art.plain.join("\n"));
console.error(`${prefix}: width ${art.width} columns`);
for (const warning of art.warnings) {
  console.error(`${prefix}: warning: ${warning}`);
}
