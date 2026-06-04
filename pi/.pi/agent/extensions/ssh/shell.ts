export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function fdExcludeArgs(excludes: readonly string[]): string[] {
	return excludes.flatMap((exclude) => ["--exclude", exclude]);
}

export function rgExcludeArgs(excludes: readonly string[]): string[] {
	return excludes.flatMap((exclude) => ["--glob", `!**/${exclude}/**`]);
}

export function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return normalized;
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const segments = normalized
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegex(segment));
	if (segments.length === 0) {
		return normalized;
	}

	let pattern = segments.join("[\\\\/]");
	if (hasTrailingSeparator) {
		pattern += "[\\\\/]";
	}
	return pattern;
}
