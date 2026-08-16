import assert from "node:assert/strict";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	commitTaskCreation,
	createTask,
	discardTaskCreation,
	finishPhase,
	isSlug,
	listTasks,
	MAX_SLUG_LENGTH,
	MAX_TITLE_LENGTH,
	nextOpenPhase,
	prepareTaskCreation,
	readPlan,
	readTask,
	removeTask,
	taskDir,
	taskPath,
	taskProgress,
	taskState,
	worktreePath,
	type Phase,
	type PhaseInput,
	type Task,
} from "./tasks.ts";

const INPUTS: readonly PhaseInput[] = [
	{ name: "runtime", title: "Runtime", body: "Build the runtime.\n\n- Verify startup." },
	{ name: "tests", title: "Tests", body: "Cover the public behavior." },
];

interface Fixture {
	base: string;
	root: string;
	plan: string;
	repository: string;
}

interface TestState {
	version: 1;
	slug: string;
	plan: string;
	repository: string;
	phases: Phase[];
}

function entry(path: string) {
	return lstatSync(path, { throwIfNoEntry: false });
}

function withFixture(run: (fixture: Fixture) => void): void {
	const base = mkdtempSync(join(tmpdir(), "pi-tasks-test-"));
	const fixture = {
		base,
		root: join(base, "tasks"),
		plan: join(base, "PLAN.md"),
		repository: join(base, "repo"),
	};
	try {
		mkdirSync(fixture.repository);
		writeFileSync(fixture.plan, "# Approved plan\n\nShip it.\n");
		run(fixture);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

function stateOf(task: Task): TestState {
	return {
		version: task.version,
		slug: task.slug,
		plan: task.plan,
		repository: task.repository,
		phases: task.phases,
	};
}

function renderMarkdown(state: TestState): string {
	const checklist = state.phases
		.map((phase) => `- [${phase.status === "done" ? "x" : " "}] ${phase.name} — ${phase.title}`)
		.join("\n");
	const sections = state.phases
		.map((phase) => `## ${phase.name} — ${phase.title}\n\n${phase.body}`)
		.join("\n\n");
	return `# ${state.slug}\n\nPlan: ${state.plan}\n\n## Phases\n\n${checklist}\n\n${sections}\n`;
}

function document(state: TestState, markdown = renderMarkdown(state)): string {
	return `---\n${JSON.stringify(state)}\n---\n${markdown}`;
}

function createFixtureTask(fixture: Fixture, slug = "joint-rail"): Task {
	return createTask(fixture.root, slug, fixture.plan, fixture.repository, INPUTS);
}

function assertMissing(path: string): void {
	assert.equal(entry(path), undefined, path);
}

test("slugs and public limits are strict", () => {
	assert.equal(MAX_SLUG_LENGTH, 48);
	assert.equal(MAX_TITLE_LENGTH, 72);
	assert.equal(isSlug("a".repeat(MAX_SLUG_LENGTH)), true);
	for (const value of [
		"",
		"Joint-Rail",
		"joint rail",
		"joint--rail",
		"-joint",
		"joint-",
		"../joint",
		"a/b",
		"a".repeat(MAX_SLUG_LENGTH + 1),
	]) {
		assert.equal(isSlug(value), false, String(value));
	}
});

test("creation writes one canonical TASK.md with a visible checklist", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		const expectedState = stateOf(task);
		const expectedMarkdown = [
			"# joint-rail",
			"",
			`Plan: ${fixture.plan}`,
			"",
			"## Phases",
			"",
			"- [ ] 01-runtime — Runtime",
			"- [ ] 02-tests — Tests",
			"",
			"## 01-runtime — Runtime",
			"",
			"Build the runtime.",
			"",
			"- Verify startup.",
			"",
			"## 02-tests — Tests",
			"",
			"Cover the public behavior.",
			"",
		].join("\n");

		assert.equal(task.directory, taskDir(fixture.root, "joint-rail"));
		assert.equal(taskPath(task), join(task.directory, "TASK.md"));
		assert.deepEqual(readdirSync(task.directory), ["TASK.md"]);
		assert.equal(readFileSync(taskPath(task), "utf8"), document(expectedState, expectedMarkdown));
		assert.deepEqual(readTask(fixture.root, task.slug), task);
		assert.deepEqual(taskState(task), { kind: "implementation", phase: task.phases[0] });
		assert.equal(nextOpenPhase(task)?.name, "01-runtime");
		assert.deepEqual(taskProgress(task), { done: 0, total: 2 });
	});
});

test("malformed structured front matter and noncanonical JSON fail loudly", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		const valid = stateOf(task);
		const cases: readonly [string, RegExp][] = [
			["not a task", /exact front matter delimiter/],
			["---\nnot json\n---\n", /structured header: is not JSON/],
			["---\n{}\nnot-close\n", /exact delimiter/],
			[
				`---\n ${JSON.stringify(valid)}\n---\n${renderMarkdown(valid)}`,
				/not canonical JSON/,
			],
		];
		for (const [content, expected] of cases) {
			writeFileSync(taskPath(task), content);
			assert.throws(() => readTask(fixture.root, task.slug), expected);
		}
	});
});

test("persisted fields, phase ordering, and exact keys are validated", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		const valid = stateOf(task);
		const [firstPhase, secondPhase] = valid.phases;
		assert.ok(firstPhase);
		assert.ok(secondPhase);
		const extra = { ...valid, extra: true };
		const cases: readonly [object, RegExp][] = [
			[{ ...valid, version: 2 }, /"version" must equal 1/],
			[{ ...valid, slug: "other" }, /does not match directory/],
			[{ ...valid, plan: "relative.md" }, /"plan": must be an absolute path/],
			[{ ...valid, repository: "/" }, /"repository": must identify.*basename/],
			[{ ...valid, phases: [] }, /"phases" must contain at least one/],
			[
				{ ...valid, phases: [{ ...firstPhase, name: "02-runtime" }] },
				/expected contiguous phase index 01/,
			],
			[
				{
					...valid,
					phases: [firstPhase, { ...secondPhase, name: "02-runtime" }],
				},
				/duplicate unnumbered name runtime/,
			],
			[
				{
					...valid,
					phases: [
						{ ...firstPhase, status: "open" },
						{ ...secondPhase, status: "done" },
					],
				},
				/done cannot follow an open phase/,
			],
			[extra, /must contain exactly/],
		];
		for (const [state, expected] of cases) {
			writeFileSync(taskPath(task), `---\n${JSON.stringify(state)}\n---\ninvalid projection`);
			assert.throws(() => readTask(fixture.root, task.slug), expected);
		}
	});
});

test("Markdown is only an exact projection of structured state", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		const state = stateOf(task);
		for (const markdown of [
			renderMarkdown(state).replace("- [ ] 01-runtime", "- [x] 01-runtime"),
			renderMarkdown(state).replace("Build the runtime.", "Edited prose."),
			renderMarkdown(state).replace("# joint-rail", "# another-task"),
		]) {
			writeFileSync(taskPath(task), document(state, markdown));
			assert.throws(() => readTask(fixture.root, task.slug), /Markdown projection does not match/);
		}
	});
});

test("all creation input is validated before the tasks root is created", () => {
	withFixture((fixture) => {
		const blankPlan = join(fixture.base, "blank.md");
		writeFileSync(blankPlan, " \n");
		const missingPlan = join(fixture.base, "missing.md");
		const nonStringBody = { name: "runtime", title: "Runtime", body: "body" } satisfies PhaseInput;
		const extraProperty = { name: "runtime", title: "Runtime", body: "body" } satisfies PhaseInput;
		Reflect.set(nonStringBody, "body", 1);
		Reflect.set(extraProperty, "extra", true);
		const [firstInput, secondInput] = INPUTS;
		assert.ok(firstInput);
		assert.ok(secondInput);
		const duplicate = [firstInput, { ...secondInput, name: firstInput.name }];
		const calls: readonly [() => void, RegExp][] = [
			[
				() => createTask(join(fixture.base, "root-1"), "../bad", fixture.plan, fixture.repository, INPUTS),
				/invalid task slug/,
			],
			[
				() => createTask(join(fixture.base, "root-2"), "task", "relative", fixture.repository, INPUTS),
				/"plan": must be an absolute path/,
			],
			[
				() => createTask(join(fixture.base, "root-3"), "task", fixture.plan, "relative", INPUTS),
				/"repository": must be an absolute path/,
			],
			[
				() => createTask(join(fixture.base, "root-4"), "task", missingPlan, fixture.repository, INPUTS),
				/file does not exist/,
			],
			[
				() => createTask(join(fixture.base, "root-5"), "task", blankPlan, fixture.repository, INPUTS),
				/plan: must be a nonblank string/,
			],
			[
				() => createTask(join(fixture.base, "root-6"), "task", fixture.plan, fixture.repository, []),
				/at least one phase/,
			],
			[
				() => createTask(join(fixture.base, "root-7"), "task", fixture.plan, fixture.repository, [
					{ name: "01-runtime", title: "Runtime", body: "body" },
				]),
				/must not include a numeric phase prefix/,
			],
			[
				() => createTask(join(fixture.base, "root-8"), "task", fixture.plan, fixture.repository, duplicate),
				/duplicate unnumbered name/,
			],
			[
				() => createTask(join(fixture.base, "root-9"), "task", fixture.plan, fixture.repository, [
					{ name: "runtime", title: "x".repeat(MAX_TITLE_LENGTH + 1), body: "body" },
				]),
				/at most 72 characters/,
			],
			[
				() => createTask(join(fixture.base, "root-10"), "task", fixture.plan, fixture.repository, [
					{ name: "runtime", title: "Runtime", body: " \n" },
				]),
				/\.body: must be a nonblank string/,
			],
			[
				() => createTask(
					join(fixture.base, "root-11"),
					"task",
					fixture.plan,
					fixture.repository,
					[nonStringBody],
				),
				/\.body: must be a nonblank string/,
			],
			[
				() => createTask(
					join(fixture.base, "root-12"),
					"task",
					fixture.plan,
					fixture.repository,
					[extraProperty],
				),
				/must contain exactly/,
			],
		];
		for (const [index, [call, expected]] of calls.entries()) {
			assert.throws(call, expected);
			assertMissing(join(fixture.base, `root-${index + 1}`));
		}
	});
});

test("a prepared creation owns the slug claim until commit or discard", () => {
	withFixture((fixture) => {
		const winner = prepareTaskCreation(
			fixture.root,
			"joint-rail",
			fixture.plan,
			fixture.repository,
			INPUTS,
		);
		assertMissing(winner.task.directory);
		assert.notEqual(entry(winner.stagedDirectory), undefined);
		assert.deepEqual(readdirSync(winner.stagedDirectory), ["TASK.md"]);
		assert.throws(
			() => prepareTaskCreation(
				fixture.root,
				"joint-rail",
				fixture.plan,
				fixture.repository,
				INPUTS,
			),
			/EEXIST/,
		);
		assert.notEqual(entry(winner.stagedDirectory), undefined);
		assert.deepEqual(commitTaskCreation(winner), winner.task);
		assertMissing(winner.stagedDirectory);

		const corrupted = prepareTaskCreation(
			fixture.root,
			"corrupted",
			fixture.plan,
			fixture.repository,
			INPUTS,
		);
		writeFileSync(join(corrupted.stagedDirectory, "TASK.md"), "broken");
		assert.throws(() => commitTaskCreation(corrupted), /front matter delimiter/);
		assertMissing(corrupted.task.directory);
		discardTaskCreation(corrupted);

		const discarded = prepareTaskCreation(
			fixture.root,
			"discarded",
			fixture.plan,
			fixture.repository,
			INPUTS,
		);
		discardTaskCreation(discarded);
		assertMissing(discarded.stagedDirectory);
		assertMissing(discarded.task.directory);
		assert.throws(() => createFixtureTask(fixture), /already exists/);
	});
});

test("the task catalog keeps valid tasks and surfaces each broken entry", () => {
	withFixture((fixture) => {
		createFixtureTask(fixture, "z-task");
		createFixtureTask(fixture, "a-task");
		mkdirSync(join(fixture.root, "broken"));
		writeFileSync(join(fixture.root, "broken", "TASK.md"), "not structured");
		writeFileSync(join(fixture.root, "plain-file"), "not a directory");
		mkdirSync(join(fixture.root, ".a-task.claim"));

		const catalog = listTasks(fixture.root);
		assert.deepEqual(catalog.tasks.map((task) => task.slug), ["a-task", "z-task"]);
		assert.equal(catalog.broken.length, 2);
		const [brokenTask, plainFile] = catalog.broken;
		assert.ok(brokenTask);
		assert.ok(plainFile);
		assert.match(brokenTask, /^broken: .*TASK\.md/);
		assert.match(plainFile, /^plain-file: .*must be a directory/);
	});
	withFixture((fixture) => {
		assert.deepEqual(listTasks(fixture.root), { tasks: [], broken: [] });
	});
});

test("phases finish in order and rewrite the canonical checklist atomically", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		const before = readFileSync(taskPath(task), "utf8");
		assert.throws(() => finishPhase(task, "02-tests"), /out of order/);
		assert.throws(() => finishPhase(task, "99-missing"), /unknown phase/);
		assert.equal(readFileSync(taskPath(task), "utf8"), before);

		const first = finishPhase(task, "01-runtime");
		assert.equal(first.status, "done");
		const advanced = readTask(fixture.root, task.slug);
		assert.equal(nextOpenPhase(advanced)?.name, "02-tests");
		assert.deepEqual(taskProgress(advanced), { done: 1, total: 2 });
		const afterFirst = readFileSync(taskPath(task), "utf8");
		assert.match(afterFirst, /- \[x\] 01-runtime — Runtime/);
		assert.match(afterFirst, /- \[ \] 02-tests — Tests/);
		assert.deepEqual(readdirSync(task.directory), ["TASK.md"]);
		assert.throws(() => finishPhase(task, "01-runtime"), /already done/);

		finishPhase(task, "02-tests");
		const complete = readTask(fixture.root, task.slug);
		assert.deepEqual(taskState(complete), { kind: "complete" });
		assert.deepEqual(taskProgress(complete), { done: 2, total: 2 });
		assert.match(readFileSync(taskPath(task), "utf8"), /- \[x\] 02-tests — Tests/);
		assert.throws(() => finishPhase(task, "02-tests"), /already done/);
	});
});

test("removing a task deletes only its validated task directory", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		removeTask(fixture.root, task.slug);
		assertMissing(task.directory);
		assert.notEqual(entry(fixture.plan), undefined);
		assert.notEqual(entry(fixture.repository), undefined);
		assert.throws(() => removeTask(fixture.root, task.slug), /directory does not exist/);
	});
});

test("readPlan always reads the current regular nonblank source plan", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		assert.equal(readPlan(task), "# Approved plan\n\nShip it.\n");
		writeFileSync(fixture.plan, "# Revised live plan\n");
		assert.equal(readPlan(task), "# Revised live plan\n");
		assert.equal(readTask(fixture.root, task.slug).plan, fixture.plan);

		writeFileSync(fixture.plan, " \n");
		assert.throws(() => readPlan(task), /plan: must be a nonblank string/);
		rmSync(fixture.plan);
		mkdirSync(fixture.plan);
		assert.throws(() => readPlan(task), /must be a regular file/);
		rmSync(fixture.plan, { recursive: true });
		assert.throws(() => readPlan(task), /file does not exist/);
	});
});

test("worktreePath is the repository sibling derived from basename and slug", () => {
	withFixture((fixture) => {
		const task = createFixtureTask(fixture);
		assert.equal(worktreePath(task), join(fixture.base, "repo-joint-rail"));
		assert.throws(
			() => worktreePath({ repository: "relative/repo", slug: task.slug }),
			/must be an absolute path/,
		);
		assert.throws(
			() => worktreePath({ repository: fixture.repository, slug: "../bad" }),
			/invalid task slug/,
		);
	});
});
