/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 *
 * Test-freeze: when a `.pi-protect-tests` marker file exists in the project
 * cwd, test files are also protected. The /implement workflow creates this marker
 * during its implementation phase (and removes it after) so the implementer
 * cannot weaken, skip, or delete tests to make them pass. A marker file is
 * used instead of an env var because the extension runs in the pi process,
 * not in the shell where bash tool calls run.
 *
 * Override the default test globs by writing comma-separated substrings into
 * the marker file (e.g. `echo "src/,e2e/" > .pi-protect-tests`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_PROTECTED = [".env", ".git/", "node_modules/"];
const MARKER = ".pi-protect-tests";

const DEFAULT_TEST_GLOBS = [
	".test.",
	".spec.",
	"_test.",
	"/tests/",
	"/test/",
	"__tests__/",
	"e2e/",
];

function frozenTestGlobs(): string[] {
	const marker = join(process.cwd(), MARKER);
	if (!existsSync(marker)) {
		return [];
	}
	const custom = readFileSync(marker, "utf8")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return custom.length > 0 ? custom : DEFAULT_TEST_GLOBS;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const path = event.input.path as string;
		const testGlobs = frozenTestGlobs();
		const protectedPaths = [...BASE_PROTECTED, ...testGlobs];

		const hit = protectedPaths.find((p) => path.includes(p));
		if (hit) {
			const reason = testGlobs.includes(hit)
				? `Test file "${path}" is frozen (${MARKER} present). Fix the code, not the test.`
				: `Path "${path}" is protected`;
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			return { block: true, reason };
		}

		return undefined;
	});
}
