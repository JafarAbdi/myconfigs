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
