import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewCommand, quoteReviewArgument } from "./review-command.ts";

const ROOT = "/repository";

test("parses the strict grammar with staged as the default source", () => {
	assert.deepEqual(parseReviewCommand("", ROOT), {
		selection: { source: "staged", paths: [] },
	});
	assert.deepEqual(
		parseReviewCommand("worktree --requirement docs/requirement.md -- src test", ROOT),
		{
			selection: { source: "worktree", paths: ["src", "test"] },
			requirementPath: "docs/requirement.md",
		},
	);
	assert.deepEqual(parseReviewCommand("untracked", ROOT), {
		selection: { source: "untracked", paths: [] },
	});
	assert.throws(
		() => parseReviewCommand("--requirement docs/requirement.txt", ROOT),
		/must end in \.md/u,
	);
});

test("preserves an unprefixed legacy Markdown argument with spaces", () => {
	assert.deepEqual(
		parseReviewCommand("  docs/optional plan with spaces.md  ", ROOT),
		{
			selection: { source: "staged", paths: [] },
			requirementPath: "docs/optional plan with spaces.md",
		},
	);
	assert.throws(
		() => parseReviewCommand("worktree optional plan.md", ROOT),
		/paths must follow --/u,
	);
});

test("supports quotes and backslash escapes in requirement and selection paths", () => {
	assert.deepEqual(
		parseReviewCommand(
			`worktree --requirement "docs/plan with spaces.md" -- 'src/a file.ts' src/b\\ file.ts "src/a\\"quote.ts"`,
			ROOT,
		),
		{
			selection: {
				source: "worktree",
				paths: ["src/a file.ts", "src/b file.ts", 'src/a"quote.ts'],
			},
			requirementPath: "docs/plan with spaces.md",
		},
	);
});

test("normalizes lexical repository paths and deduplicates in input order", () => {
	assert.deepEqual(
		parseReviewCommand(
			"untracked -- src/a.ts ./src/a.ts src/generated/../a.ts . ./ missing/file.ts",
			ROOT,
		),
		{
			selection: {
				source: "untracked",
				paths: ["src/a.ts", ".", "missing/file.ts"],
			},
		},
	);
});

test("rejects paths outside the root, absolute paths, NUL, and newlines", () => {
	for (const argument of [
		"-- ../outside.ts",
		"-- src/../../outside.ts",
		"-- /absolute.ts",
		"-- bad\0path.ts",
		"-- first.ts\nsecond.ts",
	]) assert.throws(() => parseReviewCommand(argument, ROOT));
});

test("rejects unknown options, bare paths, and an empty path delimiter", () => {
	assert.throws(() => parseReviewCommand("--unknown", ROOT), /Unknown Review option/u);
	assert.throws(() => parseReviewCommand("-x", ROOT), /Unknown Review option/u);
	assert.throws(() => parseReviewCommand("src/a.ts", ROOT), /paths must follow --/u);
	assert.throws(() => parseReviewCommand("--", ROOT), /requires at least one path/u);
	assert.throws(() => parseReviewCommand("staged --", ROOT), /requires at least one path/u);
	assert.throws(() => parseReviewCommand("-- ''", ROOT), /must not be empty/u);
});

test("rejects unterminated quoting and escapes", () => {
	assert.throws(() => parseReviewCommand("-- 'src/a.ts", ROOT), /unterminated quote/u);
	assert.throws(() => parseReviewCommand("-- src/a.ts\\", ROOT), /unterminated escape/u);
});

test("rejects duplicate or misplaced sources and requirements", () => {
	assert.throws(
		() => parseReviewCommand("staged worktree", ROOT),
		/source may be specified only once/u,
	);
	assert.throws(
		() => parseReviewCommand("--requirement plan.md untracked", ROOT),
		/source may appear only first/u,
	);
	assert.throws(
		() => parseReviewCommand("--requirement one.md --requirement two.md", ROOT),
		/--requirement may be specified only once/u,
	);
	assert.throws(() => parseReviewCommand("--requirement", ROOT), /needs a value/u);
});

test("treats source and option-looking names as literal paths after --", () => {
	assert.deepEqual(parseReviewCommand("staged -- worktree --requirement", ROOT), {
		selection: { source: "staged", paths: ["worktree", "--requirement"] },
	});
});

test("bounds argument count and size", () => {
	assert.throws(
		() => parseReviewCommand(`${Array.from({ length: 513 }, () => "x").join(" ")}`, ROOT),
		/at most 512 arguments/u,
	);
	assert.throws(
		() => parseReviewCommand(`-- ${"x".repeat(4_097)}`, ROOT),
		/must not exceed 4096 bytes each/u,
	);
});

test("quotes completion arguments safely and round-trips special characters", () => {
	assert.equal(quoteReviewArgument("src/a.ts"), "src/a.ts");
	assert.equal(quoteReviewArgument(""), "''");
	const path = "src/a b's\\c.ts";
	const quoted = quoteReviewArgument(path);
	assert.equal(quoted.startsWith("'"), true);
	assert.deepEqual(parseReviewCommand(`-- ${quoted}`, ROOT), {
		selection: { source: "staged", paths: [path] },
	});
});
