/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: recursive rm outside /tmp, sudo, chmod/chown 777
 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BashCommandInput = Type.Object({ command: Type.String() });

const dangerousPatterns = [/\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

/**
 * A recursive rm is dangerous unless every target is a literal path under /tmp/.
 * Variables, quotes around variables, relative paths, and `..` segments all fail the
 * literal check and stay gated.
 */
export function isDangerousRm(command: string): boolean {
	for (const match of command.matchAll(/\brm\s+([^;&|\n]*)/gi)) {
		const words = match[1].trim().split(/\s+/).filter(Boolean);
		const recursive = words.some((word) => /^-\w*r/i.test(word) || word === "--recursive");
		if (!recursive) continue;
		const targets = words
			.filter((word) => !word.startsWith("-"))
			.map((word) => word.replace(/^["']|["']$/g, ""));
		const tmpOnly =
			targets.length > 0 &&
			targets.every((target) => target.startsWith("/tmp/") && !target.includes(".."));
		if (!tmpOnly) return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "host_bash") return undefined;

		if (!Value.Check(BashCommandInput, event.input)) return undefined;
		const command = event.input.command;
		const isDangerous = dangerousPatterns.some((p) => p.test(command)) || isDangerousRm(command);

		if (isDangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, [
				"Yes",
				"No",
				"No, type reason",
			]);

			if (choice === "No, type reason") {
				const reason = await ctx.ui.input("Reject reason:", "Blocked by user");
				return {
					block: true,
					reason: `User rejected this because: ${reason?.trim() || "no reason provided"}`,
				};
			}

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
