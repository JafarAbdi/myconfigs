import { readFileSync } from "node:fs";

interface PlanningContextOptions {
	cwd: string;
	contextFiles?: readonly { path: string }[];
}

export function planningContextMetadata(
	options: PlanningContextOptions,
): string {
	const paths = options.contextFiles?.map(({ path }) => path) ?? [];
	return [
		"JURUC planning context supplied by Pi:",
		`Working directory: ${options.cwd}`,
		paths.length
			? `Applicable context files (contents already loaded by Pi):\n${paths.map((path) => `- ${path}`).join("\n")}`
			: "Applicable context files: None. Pi discovered no AGENTS.md or CLAUDE.md files.",
		"These are the only applicable context-file paths.",
	].join("\n");
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (const character of argsString) {
		if (quote) {
			if (character === quote) quote = null;
			else current += character;
		} else if (character === "'" || character === '"') quote = character;
		else if (/\s/u.test(character)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else current += character;
	}
	if (current) args.push(current);
	return args;
}

export function expandPromptArguments(
	content: string,
	argsString: string,
): string {
	const args = parseCommandArgs(argsString);
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS"
						? allArgs
						: args[Number(defaultTarget) - 1];
				return value || defaultValue;
			}
			if (sliceStart) {
				const start = Math.max(0, Number(sliceStart) - 1);
				return args
					.slice(start, sliceLength ? start + Number(sliceLength) : undefined)
					.join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number(simple) - 1] ?? "";
		},
	);
}

function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n?/gu, "\n");
	if (!normalized.startsWith("---")) return normalized;
	const end = normalized.indexOf("\n---", 3);
	return end < 0 ? normalized : normalized.slice(end + 4).trim();
}

interface PromptCommand {
	name: string;
	source: string;
	sourceInfo: { path: string };
}

export function canonicalPrompt(
	commands: readonly PromptCommand[],
	name: string,
	argsString: string,
): string {
	const matches = commands.filter(
		(command) => command.name === name && command.source === "prompt",
	);
	if (matches.length !== 1)
		throw new Error(`the canonical /${name} prompt is unavailable or ambiguous`);
	const body = stripFrontmatter(readFileSync(matches[0].sourceInfo.path, "utf8"));
	const expanded = expandPromptArguments(body, argsString);
	if (!expanded.trim()) throw new Error(`the canonical /${name} prompt is empty`);
	return expanded;
}
