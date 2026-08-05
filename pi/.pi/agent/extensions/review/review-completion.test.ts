import assert from "node:assert/strict";
import test from "node:test";
import {
	reviewArgumentCompletions,
	type ReviewCompletionDependencies,
} from "./review-completion.ts";
import type { ReviewSource } from "./review-git.ts";

function dependencies(overrides: Partial<ReviewCompletionDependencies> = {}): ReviewCompletionDependencies {
	return {
		async listCandidatePaths() { return []; },
		async listRequirementPaths() { return []; },
		...overrides,
	};
}

function values(items: Awaited<ReturnType<typeof reviewArgumentCompletions>>): string[] {
	return items?.map(({ value }) => value) ?? [];
}

test("suggests the approved grammar at the beginning", async () => {
	const items = await reviewArgumentCompletions("", dependencies());
	assert.deepEqual(values(items), [
		"staged",
		"worktree",
		"untracked",
		"--requirement",
		"--",
	]);
	assert.equal(items?.every(({ description }) => Boolean(description)), true);
	assert.deepEqual(values(await reviewArgumentCompletions("work", dependencies())), ["worktree"]);
});

test("returns full-prefix replacements and calls the source-aware path loader", async () => {
	const sources: ReviewSource[] = [];
	let requirementCalls = 0;
	const items = await reviewArgumentCompletions(
		"worktree -- src/a.ts src/b",
		dependencies({
			async listCandidatePaths(source) {
				sources.push(source);
				return ["src/a.ts", "src/b.ts", "test/b.ts"];
			},
			async listRequirementPaths() {
				requirementCalls += 1;
				return [];
			},
		}),
	);
	assert.deepEqual(sources, ["worktree"]);
	assert.equal(requirementCalls, 0);
	assert.deepEqual(values(items), ["worktree -- src/a.ts src/b.ts"]);
	assert.equal(items?.[0].label, "src/b.ts");
});

test("completes only Markdown requirement paths and preserves the source", async () => {
	let pathCalls = 0;
	const deps = dependencies({
		async listCandidatePaths() {
			pathCalls += 1;
			return [];
		},
		async listRequirementPaths() {
			return ["docs/plan.md", "docs/plan.md", "docs/plan.txt", "notes.md"];
		},
	});
	assert.deepEqual(
		values(await reviewArgumentCompletions("untracked --requirement docs/p", deps)),
		["untracked --requirement docs/plan.md"],
	);
	assert.equal(pathCalls, 0);
	assert.deepEqual(
		values(await reviewArgumentCompletions("--requirement notes.md ", deps)),
		["--requirement notes.md --"],
	);
});

test("preserves repeated selected paths, omits them, and derives parent directories", async () => {
	const items = await reviewArgumentCompletions(
		"untracked -- src/a.ts test/c.ts ",
		dependencies({
			async listCandidatePaths() {
				return ["src/a.ts", "src/nested/b.ts", "test/c.ts"];
			},
		}),
	);
	assert.deepEqual(values(items), [
		"untracked -- src/a.ts test/c.ts src/",
		"untracked -- src/a.ts test/c.ts src/nested/",
		"untracked -- src/a.ts test/c.ts src/nested/b.ts",
		"untracked -- src/a.ts test/c.ts test/",
	]);
});

test("quotes candidate and requirement paths with spaces", async () => {
	const deps = dependencies({
		async listCandidatePaths() { return ["src/a file.ts"]; },
		async listRequirementPaths() { return ["docs/review plan.md"]; },
	});
	assert.deepEqual(values(await reviewArgumentCompletions("-- src/a", deps)), [
		"-- 'src/a file.ts'",
	]);
	assert.deepEqual(values(await reviewArgumentCompletions("--requirement docs/r", deps)), [
		"--requirement 'docs/review plan.md'",
	]);
});

test("bounds suggestions and returns null for malformed or unsupported prefixes", async () => {
	let calls = 0;
	const deps = dependencies({
		async listCandidatePaths() {
			calls += 1;
			return Array.from({ length: 60 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`);
		},
		async listRequirementPaths() {
			calls += 1;
			return [];
		},
	});
	assert.equal((await reviewArgumentCompletions("-- ", deps))?.length, 50);
	assert.equal(calls, 1);

	for (const prefix of [
		"staged worktree ",
		"--requirement plan.txt ",
		"src/a.ts ",
		"-- ../outside.ts ",
		"--requirement /outside.md ",
		"--requirement 'unterminated",
		"staged --requirement plan.md --requirement ",
	]) assert.equal(await reviewArgumentCompletions(prefix, deps), null);
	assert.equal(calls, 1);
});
