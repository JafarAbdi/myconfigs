import {
	quoteReviewArgument,
	splitReviewArgumentPrefix,
} from "./review-command.ts";
import type { ReviewSource } from "./review-git.ts";

const MAX_SUGGESTIONS = 50;
const REVIEW_SOURCES = ["staged", "worktree", "untracked"] as const;
export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export interface ReviewCompletionDependencies {
	listCandidatePaths(source: ReviewSource): Promise<readonly string[]>;
	listRequirementPaths(): Promise<readonly string[]>;
}

interface CompletionContext {
	kind: "options" | "requirement" | "paths";
	source: ReviewSource;
	hasRequirement: boolean;
	selectedPaths: string[];
}

interface PathCompletion {
	path: string;
	directory: boolean;
}

const INITIAL_OPTIONS = [
	{ token: "staged", description: "HEAD → index" },
	{ token: "worktree", description: "Index → tracked worktree" },
	{ token: "untracked", description: "Untracked files" },
	{ token: "--requirement", description: "Attach Markdown requirement" },
	{ token: "--", description: "Select changed paths" },
] as const;

function isReviewSource(value: string): value is ReviewSource {
	return REVIEW_SOURCES.includes(value as ReviewSource);
}

function isRepositoryPath(value: string, allowEmpty = false): boolean {
	if ((!value && !allowEmpty) || value.startsWith("/")) return false;
	let depth = 0;
	for (const part of value.split("/")) {
		if (!part || part === ".") continue;
		if (part !== "..") {
			depth += 1;
			continue;
		}
		if (depth === 0) return false;
		depth -= 1;
	}
	return true;
}

function completionContext(tokens: readonly string[]): CompletionContext | null {
	let source: ReviewSource = "staged";
	let index = 0;
	let hasRequirement = false;

	if (isReviewSource(tokens[0] ?? "")) {
		source = tokens[0] as ReviewSource;
		index = 1;
	}
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--") {
			const selectedPaths = tokens.slice(index + 1);
			if (selectedPaths.some((path) => !isRepositoryPath(path))) return null;
			return { kind: "paths", source, hasRequirement, selectedPaths };
		}
		if (token === "--requirement") {
			if (hasRequirement) return null;
			const requirement = tokens[index + 1];
			if (requirement === undefined)
				return { kind: "requirement", source, hasRequirement, selectedPaths: [] };
			if (!isRepositoryPath(requirement) || !requirement.endsWith(".md")) return null;
			hasRequirement = true;
			index += 2;
			continue;
		}
		return null;
	}
	return { kind: "options", source, hasRequirement, selectedPaths: [] };
}

function replacement(
	completed: readonly string[],
	token: string,
	label: string,
	description: string,
): AutocompleteItem | null {
	try {
		return {
			value: [...completed, token].map(quoteReviewArgument).join(" "),
			label,
			description,
		};
	} catch {
		return null;
	}
}

function optionItems(
	completed: readonly string[],
	partial: string,
	hasRequirement: boolean,
): AutocompleteItem[] {
	return INITIAL_OPTIONS
		.filter(({ token }) => (token === "--" || (token === "--requirement" && !hasRequirement)))
		.filter(({ token }) => token.startsWith(partial))
		.map(({ token, description }) => replacement(completed, token, token, description))
		.filter((item): item is AutocompleteItem => item !== null);
}

function pathCompletions(paths: readonly string[]): PathCompletion[] {
	const completions = new Map<string, PathCompletion>();
	for (const path of paths) {
		if (!isRepositoryPath(path)) continue;
		try {
			quoteReviewArgument(path);
		} catch {
			continue;
		}
		if (!completions.has(path)) completions.set(path, { path, directory: false });
		for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
			const parent = `${path.slice(0, slash)}/`;
			if (!completions.has(parent)) completions.set(parent, { path: parent, directory: true });
		}
	}
	return [...completions.values()].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0
	);
}

function selectedKey(path: string): string {
	return path.endsWith("/") ? path.slice(0, -1) : path;
}

export async function reviewArgumentCompletions(
	prefix: string,
	deps: ReviewCompletionDependencies,
): Promise<AutocompleteItem[] | null> {
	try {
		if (typeof prefix !== "string") return null;
		const parsed = splitReviewArgumentPrefix(prefix);
		if (!parsed) return null;
		const { completed, partial } = parsed;
		if (completed.length === 0) {
			const items = INITIAL_OPTIONS
				.filter(({ token }) => token.startsWith(partial))
				.map(({ token, description }) => replacement([], token, token, description))
				.filter((item): item is AutocompleteItem => item !== null);
			return items.length > 0 ? items : null;
		}

		const context = completionContext(completed);
		if (!context) return null;
		let items: AutocompleteItem[];
		if (context.kind === "options") {
			items = optionItems(completed, partial, context.hasRequirement);
		} else if (context.kind === "requirement") {
			if (!isRepositoryPath(partial, true)) return null;
			const seen = new Set<string>();
			items = (await deps.listRequirementPaths())
				.filter((path) => {
					if (
						!isRepositoryPath(path) ||
						!path.endsWith(".md") ||
						!path.startsWith(partial) ||
						seen.has(path)
					) return false;
					seen.add(path);
					return true;
				})
				.map((path) => replacement(completed, path, path, "Requirement Markdown"))
				.filter((item): item is AutocompleteItem => item !== null);
		} else {
			if (!isRepositoryPath(partial, true)) return null;
			const selected = new Set(context.selectedPaths.map(selectedKey));
			items = pathCompletions(await deps.listCandidatePaths(context.source))
				.filter(({ path }) => path.startsWith(partial) && !selected.has(selectedKey(path)))
				.map(({ path, directory }) => replacement(
					completed,
					path,
					path,
					directory ? "Changed parent directory" : "Changed file",
				))
				.filter((item): item is AutocompleteItem => item !== null);
		}
		items = items.slice(0, MAX_SUGGESTIONS);
		return items.length > 0 ? items : null;
	} catch {
		return null;
	}
}
