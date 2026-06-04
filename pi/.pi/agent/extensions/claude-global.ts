/**
 * Load global Claude .md files into pi's system prompt.
 *
 * Reads CLAUDE.md and STYLE.md from ~/.claude/ and prepends them
 * to the system prompt on every agent turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILES = ["CLAUDE.md", "STYLE.md"];

function loadFile(name: string): string | null {
  const p = path.join(os.homedir(), ".claude", name);
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, "utf-8");
  return content.trim() ? `## ${name}\n\n${content}` : null;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const sections = FILES.map(loadFile).filter(Boolean) as string[];
    if (sections.length === 0) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n---\n\n") };
  });
}
