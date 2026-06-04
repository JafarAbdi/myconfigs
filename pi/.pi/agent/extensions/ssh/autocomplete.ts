import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { SshConnection } from "./connection.ts";
import { REMOTE_AUTOCOMPLETE_SUGGESTIONS_MAX, REMOTE_FD_CANDIDATES_MAX, REMOTE_FD_EXCLUDES } from "./constants.ts";
import { fdExcludeArgs, shellQuote, toDisplayPath } from "./shell.ts";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export type CompletionErrorReporter = (error: unknown) => void;

type RemoteSearch = { baseDir: string; displayBase: string; query: string };
type RemoteDirectorySearch = RemoteSearch & { isQuoted: boolean };

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractRemoteAtPrefix(textBeforeCursor: string): string | undefined {
	const quoteStart = findUnclosedQuoteStart(textBeforeCursor);
	if (quoteStart !== null) {
		if (quoteStart > 0 && textBeforeCursor[quoteStart - 1] === "@") {
			return isTokenStart(textBeforeCursor, quoteStart - 1) ? textBeforeCursor.slice(quoteStart - 1) : undefined;
		}
		return undefined;
	}

	const lastDelimiterIndex = findLastDelimiter(textBeforeCursor);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	if (textBeforeCursor[tokenStart] === "@") {
		return textBeforeCursor.slice(tokenStart);
	}
	return undefined;
}

function parseRemoteAtPrefix(prefix: string): { query: string; isQuoted: boolean } {
	if (prefix.startsWith('@"')) {
		return { query: prefix.slice(2), isQuoted: true };
	}
	return { query: prefix.slice(1), isQuoted: false };
}

function normalizeRemoteQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (normalized === "." || normalized === "./") {
		return "";
	}
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function pathBasename(remotePath: string): string {
	const trimmed = remotePath.endsWith("/") ? remotePath.slice(0, -1) : remotePath;
	const slashIndex = trimmed.lastIndexOf("/");
	return slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);
}

function buildAtCompletionValue(remotePath: string, isDirectory: boolean, isQuotedPrefix: boolean): string {
	const needsQuotes = isQuotedPrefix || remotePath.includes(" ");
	if (!needsQuotes) {
		return `@${remotePath}`;
	}

	const path = isDirectory && !remotePath.endsWith("/") ? `${remotePath}/` : remotePath;
	return `@"${path}"`;
}

function remoteFilterStage(fzfPath: string, query: string): string {
	const cap = `head -n ${REMOTE_AUTOCOMPLETE_SUGGESTIONS_MAX}`;
	if (!query) return `sort | ${cap}`;
	return `${shellQuote(fzfPath)} --filter ${shellQuote(query)} | ${cap}`;
}

function resolveRemoteSearch(rawQuery: string): RemoteSearch {
	const normalizedQuery = normalizeRemoteQuery(rawQuery);
	const slashIndex = normalizedQuery.lastIndexOf("/");
	if (slashIndex === -1) {
		return { baseDir: ".", displayBase: "", query: normalizedQuery };
	}

	const displayBase = normalizedQuery.slice(0, slashIndex + 1);
	return {
		baseDir: displayBase || ".",
		displayBase,
		query: normalizedQuery.slice(slashIndex + 1),
	};
}

export function parseHiddenFlag(input: string): { includeHidden: boolean; rest: string } {
	const trimmed = input.trimStart();
	const match = /^-h(\s+|$)/.exec(trimmed);
	if (match) {
		return { includeHidden: true, rest: trimmed.slice(match[0].length) };
	}
	return { includeHidden: false, rest: input };
}

function parseRemoteDirectorySearch(argumentPrefix: string): RemoteDirectorySearch {
	const trimmed = argumentPrefix.trimStart();
	const isQuoted = trimmed.startsWith('"');
	const rawQuery = isQuoted ? trimmed.slice(1) : trimmed;
	const search = rawQuery === "~" ? { baseDir: "~/", displayBase: "~/", query: "" } : resolveRemoteSearch(rawQuery);
	return { ...search, isQuoted };
}

function remoteBaseDirExpression(baseDir: string): string {
	if (baseDir === "~" || baseDir === "~/") {
		return '"$HOME"';
	}
	if (baseDir.startsWith("~/")) {
		return `"$HOME"/${shellQuote(baseDir.slice(2))}`;
	}
	return shellQuote(baseDir);
}

function createRemoteFindCommand(remoteCwd: string, fdPath: string, fzfPath: string, search: RemoteSearch): string {
	const baseDir = shellQuote(search.baseDir);
	const fdArgs = [
		"--base-directory",
		search.baseDir,
		"--max-results",
		String(REMOTE_FD_CANDIDATES_MAX),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		...fdExcludeArgs(REMOTE_FD_EXCLUDES),
	];

	const markDirectoriesCommand = [
		'while IFS= read -r p; do [ -n "$p" ] || continue',
		"raw=$" + "{p#./}",
		"clean=$" + "{raw%/}",
		`if [ -d ${baseDir}/"$clean" ]; then printf '%s/\\n' "$clean"`,
		"else printf '%s\\n' \"$clean\"; fi; done",
	].join("; ");
	const fdCommand = `${shellQuote(fdPath)} ${fdArgs.map(shellQuote).join(" ")}`;
	const filter = remoteFilterStage(fzfPath, search.query);
	return [`cd ${shellQuote(remoteCwd)}`, `${fdCommand} | ${filter} | ${markDirectoriesCommand}`].join(" && ");
}

function createRemoteDirectoryCommand(
	remoteCwd: string,
	fdPath: string,
	fzfPath: string,
	search: RemoteDirectorySearch,
	includeHidden: boolean,
): string {
	const baseDir = remoteBaseDirExpression(search.baseDir);
	const fdArgs = [
		"--max-results",
		String(REMOTE_FD_CANDIDATES_MAX),
		"--type",
		"d",
		"--follow",
		...(includeHidden ? ["--hidden"] : []),
		...fdExcludeArgs(REMOTE_FD_EXCLUDES),
	];

	const markDirectoriesCommand = [
		'while IFS= read -r p; do [ -n "$p" ] || continue',
		"raw=$" + "{p#./}",
		"clean=$" + "{raw%/}",
		"printf '%s/\\n' \"$clean\"",
		"done",
	].join("; ");
	const fdCommand = `${shellQuote(fdPath)} --base-directory ${baseDir} ${fdArgs.map(shellQuote).join(" ")}`;
	const filter = remoteFilterStage(fzfPath, search.query);
	return [`cd ${shellQuote(remoteCwd)}`, `${fdCommand} | ${filter} | ${markDirectoriesCommand}`].join(" && ");
}

function buildDirectoryCompletionValue(remotePath: string, isQuotedPrefix: boolean): string {
	if (!isQuotedPrefix && !remotePath.includes(" ")) {
		return remotePath;
	}
	return `"${remotePath}"`;
}

function formatRemoteDirectoryCompletionItems(entries: string[], search: RemoteDirectorySearch): AutocompleteItem[] {
	const seen = new Set<string>();
	return entries
		.map((entry) => toDisplayPath(entry.trim()))
		.filter((entry) => entry.length > 0 && entry !== "./")
		.filter((entry) => {
			if (seen.has(entry)) return false;
			seen.add(entry);
			return true;
		})
		.slice(0, REMOTE_AUTOCOMPLETE_SUGGESTIONS_MAX)
		.map((entry) => {
			const directory = entry.endsWith("/") ? entry : `${entry}/`;
			const displayPath = `${search.displayBase}${directory}`;
			return {
				value: buildDirectoryCompletionValue(displayPath, search.isQuoted),
				label: `${pathBasename(displayPath)}/`,
				description: displayPath,
			};
		});
}

export async function getRemoteDirectoryCompletions(
	connection: SshConnection,
	argumentPrefix: string,
	onError: CompletionErrorReporter,
): Promise<AutocompleteItem[] | null> {
	const { includeHidden, rest } = parseHiddenFlag(argumentPrefix);
	const search = parseRemoteDirectorySearch(rest);
	try {
		const output = await connection.exec(
			createRemoteDirectoryCommand(
				connection.remoteCwd,
				connection.requireFdPath(),
				connection.requireFzfPath(),
				search,
				includeHidden,
			),
		);
		return formatRemoteDirectoryCompletionItems(output.toString("utf8").split("\n"), search);
	} catch (error) {
		onError(error);
		return null;
	}
}

function formatRemoteAutocompleteItems(
	entries: string[],
	search: RemoteSearch,
	isQuotedPrefix: boolean,
): AutocompleteItem[] {
	const seen = new Set<string>();
	return entries
		.map((entry) => toDisplayPath(entry.trim()))
		.filter((entry) => entry.length > 0 && entry !== "./")
		.filter((entry) => {
			if (seen.has(entry)) return false;
			seen.add(entry);
			return true;
		})
		.slice(0, REMOTE_AUTOCOMPLETE_SUGGESTIONS_MAX)
		.map((entry) => {
			const isDirectory = entry.endsWith("/");
			const displayPath = `${search.displayBase}${entry}`;
			return {
				value: buildAtCompletionValue(displayPath, isDirectory, isQuotedPrefix),
				label: `${pathBasename(displayPath)}${isDirectory ? "/" : ""}`,
				description: displayPath,
			};
		});
}

export function createRemoteAtAutocompleteProvider(
	current: AutocompleteProvider,
	getConnection: () => SshConnection | null,
	onError: CompletionErrorReporter,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const connection = getConnection();
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const prefix = extractRemoteAtPrefix(textBeforeCursor);
			if (!connection || prefix === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const parsed = parseRemoteAtPrefix(prefix);
			const search = resolveRemoteSearch(parsed.query);
			try {
				const output = await connection.exec(
					createRemoteFindCommand(connection.remoteCwd, connection.requireFdPath(), connection.requireFzfPath(), search),
					{
						signal: options.signal,
					},
				);
				if (options.signal.aborted) {
					return null;
				}

				const items = formatRemoteAutocompleteItems(output.toString("utf8").split("\n"), search, parsed.isQuoted);
				return items.length > 0 ? { items, prefix } : null;
			} catch (error) {
				if (!options.signal.aborted) {
					onError(error);
				}
				return null;
			}
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
