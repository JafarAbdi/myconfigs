import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReviewSelection, ReviewSource } from "./review-git.ts";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_ARGUMENTS = 512;
const SAFE_TOKEN = /^[A-Za-z0-9_./:@%+,=-]+$/u;
const FORBIDDEN_INPUT = /[\0\r\n\u2028\u2029]/u;

export interface ParsedReviewCommand {
	selection: ReviewSelection;
	requirementPath?: string;
}

export interface ReviewArgumentPrefix {
	completed: string[];
	partial: string;
}

function isReviewSource(value: string): value is ReviewSource {
	return value === "staged" || value === "worktree" || value === "untracked";
}

function assertArgumentSize(value: string): void {
	if (Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES)
		throw new Error(`Review arguments must not exceed ${MAX_ARGUMENT_BYTES} bytes each`);
}

function scanArguments(raw: string): { tokens: string[]; hasPartial: boolean } {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | "\"" | undefined;
	let escaping = false;
	let started = false;

	const push = (): void => {
		assertArgumentSize(token);
		if (tokens.length === MAX_ARGUMENTS)
			throw new Error(`Review accepts at most ${MAX_ARGUMENTS} arguments`);
		tokens.push(token);
		token = "";
		started = false;
	};

	for (const character of raw) {
		if (escaping) {
			token += character;
			escaping = false;
			continue;
		}
		if (quote === "'") {
			if (character === quote) quote = undefined;
			else token += character;
			continue;
		}
		if (character === "\\") {
			escaping = true;
			started = true;
			continue;
		}
		if (quote === "\"") {
			if (character === quote) quote = undefined;
			else token += character;
			continue;
		}
		if (character === "'" || character === "\"") {
			quote = character;
			started = true;
			continue;
		}
		if (character === " " || character === "\t") {
			if (started) push();
			continue;
		}
		token += character;
		started = true;
	}
	if (escaping) throw new Error("Review argument ends with an unterminated escape");
	if (quote) throw new Error("Review argument contains an unterminated quote");
	const hasPartial = started;
	if (started) push();
	return { tokens, hasPartial };
}

export function splitReviewArgumentPrefix(raw: string): ReviewArgumentPrefix | undefined {
	if (FORBIDDEN_INPUT.test(raw) || Buffer.byteLength(raw, "utf8") > MAX_COMMAND_BYTES)
		return undefined;
	try {
		const { tokens, hasPartial } = scanArguments(raw);
		return hasPartial
			? { completed: tokens.slice(0, -1), partial: tokens.at(-1) ?? "" }
			: { completed: tokens, partial: "" };
	} catch {
		return undefined;
	}
}

function normalizeRepositoryPath(
	repositoryRoot: string,
	value: string,
	label: string,
): string {
	if (!value) throw new Error(`${label} must not be empty`);
	if (isAbsolute(value)) throw new Error(`${label} must be repository-relative`);
	const normalized = relative(repositoryRoot, resolve(repositoryRoot, value));
	if (normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized))
		throw new Error(`${label} escapes the repository root`);
	return normalized || ".";
}

function normalizeRequirement(repositoryRoot: string, value: string): string {
	const normalized = normalizeRepositoryPath(repositoryRoot, value, "Review requirement path");
	if (!normalized.endsWith(".md"))
		throw new Error("Review requirement path must end in .md");
	return normalized;
}

export function parseReviewCommand(
	raw: string,
	repositoryRoot: string,
): ParsedReviewCommand {
	if (FORBIDDEN_INPUT.test(raw))
		throw new Error("Review arguments must not contain NUL or newlines");
	if (Buffer.byteLength(raw, "utf8") > MAX_COMMAND_BYTES)
		throw new Error(`Review arguments must not exceed ${MAX_COMMAND_BYTES} bytes in total`);
	if (!isAbsolute(repositoryRoot) || repositoryRoot.includes("\0"))
		throw new Error("Review repository root must be an absolute path");
	const root = resolve(repositoryRoot);
	const trimmed = raw.trim();
	const tokens = scanArguments(raw).tokens;
	const first = tokens[0];
	const grammarPrefix = first !== undefined && (
		isReviewSource(first) || first === "--requirement" || first === "--" || first.startsWith("-")
	);
	if (trimmed.endsWith(".md") && !grammarPrefix) {
		return {
			selection: { source: "staged", paths: [] },
			requirementPath: normalizeRequirement(root, trimmed),
		};
	}

	let source: ReviewSource = "staged";
	let explicitSource = false;
	let requirementPath: string | undefined;
	const paths: string[] = [];
	const seenPaths = new Set<string>();
	let index = 0;

	if (isReviewSource(tokens[0] ?? "")) {
		source = tokens[0] as ReviewSource;
		explicitSource = true;
		index = 1;
	}
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--") {
			if (index + 1 === tokens.length)
				throw new Error("Review -- requires at least one path");
			for (const value of tokens.slice(index + 1)) {
				const path = normalizeRepositoryPath(root, value, "Review path");
				if (!seenPaths.has(path)) {
					seenPaths.add(path);
					paths.push(path);
				}
			}
			break;
		}
		if (isReviewSource(token)) {
			if (explicitSource) throw new Error("Review source may be specified only once");
			throw new Error("Review source may appear only first");
		}
		if (token === "--requirement") {
			if (requirementPath !== undefined)
				throw new Error("Review --requirement may be specified only once");
			const value = tokens[index + 1];
			if (value === undefined || value === "--")
				throw new Error("Review --requirement needs a value");
			requirementPath = normalizeRequirement(root, value);
			index += 2;
			continue;
		}
		if (token.startsWith("-")) throw new Error(`Unknown Review option: ${token}`);
		throw new Error(`Review paths must follow --: ${token}`);
	}

	return {
		selection: { source, paths },
		...(requirementPath === undefined ? {} : { requirementPath }),
	};
}

export function quoteReviewArgument(value: string): string {
	if (FORBIDDEN_INPUT.test(value))
		throw new Error("Review arguments must not contain NUL or newlines");
	assertArgumentSize(value);
	if (SAFE_TOKEN.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
