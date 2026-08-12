import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createPhase,
	createTask,
	currentStage,
	isSlug,
	listPhases,
	listTasks,
	nextOpenPhase,
	parsePhase,
	phaseFileName,
	isStage,
	readTask,
	serializePhase,
	setPhaseStatus,
	STAGES,
	taskProgress,
	type PhaseHeader,
	type TaskHeader,
} from "./tasks.ts";

function withPhases(files: Record<string, string>, run: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "pi-task-test-"));
	try {
		mkdirSync(join(directory, "phases"), { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(directory, "phases", name), content);
		}
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-tasks-test-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const OPEN: PhaseHeader = { title: "lifecycle broker", status: "open" };
const HEADER: TaskHeader = { repository: "/repo", base: "main", description: "make the rail joint" };

test("a slug is exactly what is safe as a branch, a directory, and a key", () => {
	assert.equal(isSlug("joint-rail"), true);
	assert.equal(isSlug("phase-01"), true);
	assert.equal(isSlug(""), false);
	assert.equal(isSlug("Joint-Rail"), false);
	assert.equal(isSlug("joint rail"), false);
	assert.equal(isSlug("joint--rail"), false);
	assert.equal(isSlug("-joint"), false);
	assert.equal(isSlug("joint-"), false);
	assert.equal(isSlug("../escape"), false);
	assert.equal(isSlug("a/b"), false);
	assert.equal(isSlug("x".repeat(49)), false);
});

test("a serialized phase round-trips its header and body verbatim", () => {
	const body = "What this phase accomplishes.\n\n- `src/a.ts` around line 40: add the broker\n";
	const phase = parsePhase("01-lifecycle-broker.md", serializePhase(OPEN, body));
	assert.equal(phase.name, "01-lifecycle-broker");
	assert.equal(phase.title, "lifecycle broker");
	assert.equal(phase.status, "open");
	assert.equal(phase.body, body);
});

test("a hand-written phase file is read the same as a generated one", () => {
	const phase = parsePhase("02-robot.md", '{"title":"robot separation","status":"done"}\n\nBody text.\n');
	assert.equal(phase.status, "done");
	assert.equal(phase.body, "Body text.\n");
});

test("a header-only phase file has an empty body", () => {
	assert.equal(parsePhase("01-x.md", '{"title":"x","status":"open"}').body, "");
	assert.equal(parsePhase("01-x.md", '{"title":"x","status":"open"}\n').body, "");
});

test("a broken header fails loudly instead of being guessed at", () => {
	assert.throws(() => parsePhase("01-x.md", "# not json\n\nbody"), /not JSON/);
	assert.throws(() => parsePhase("01-x.md", '{"title":"x"}\n\nbody'), /must be/);
	assert.throws(() => parsePhase("01-x.md", '{"title":"x","status":"working"}\n'), /must be/);
	assert.throws(() => parsePhase("01-x.md", '["x","open"]\n'), /must be/);
});

test("phase order is the filename, not the write order", () => {
	withPhases(
		{
			"03-joint-rail.md": serializePhase({ title: "joint rail", status: "open" }, "third"),
			"01-lifecycle-broker.md": serializePhase(OPEN, "first"),
			"02-robot.md": serializePhase({ title: "robot separation", status: "done" }, "second"),
			"notes.txt": "ignored",
		},
		(directory) => {
			assert.deepEqual(
				listPhases(directory).map((phase) => phase.name),
				["01-lifecycle-broker", "02-robot", "03-joint-rail"],
			);
		},
	);
});

test("listing phases of a task that has none yet is empty, not an error", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-task-test-"));
	try {
		assert.deepEqual(listPhases(directory), []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("one broken phase file fails the whole read: progress must never be a guess", () => {
	withPhases(
		{ "01-a.md": serializePhase(OPEN, "a"), "02-b.md": "oops" },
		(directory) => assert.throws(() => listPhases(directory), /02-b\.md/),
	);
});

test("phase file names are numbered by position", () => {
	assert.equal(phaseFileName(1, "lifecycle-broker"), "01-lifecycle-broker.md");
	assert.equal(phaseFileName(12, "joint-rail"), "12-joint-rail.md");
});

test("a created task reads back as it was written", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		const task = readTask(root, "joint-rail");
		assert.deepEqual(task.header, HEADER);
		assert.deepEqual(task.phases, []);
		assert.equal(task.directory, join(root, "joint-rail"));
	});
});

test("a fresh tasks root is created without weakening the slug claim", () => {
	const parent = mkdtempSync(join(tmpdir(), "pi-tasks-parent-test-"));
	const root = join(parent, "tasks");
	try {
		createTask(root, "joint-rail", HEADER);
		assert.deepEqual(readTask(root, "joint-rail").header, HEADER);
		assert.throws(() => createTask(root, "joint-rail", HEADER), /EEXIST/);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("a slug is claimed once: creating it twice fails rather than reusing a branch name", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		assert.throws(() => createTask(root, "joint-rail", HEADER), /EEXIST/);
	});
});

test("malformed task JSON names the task file", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		writeFileSync(join(root, "joint-rail", "task.json"), "{ nope\n");
		assert.throws(() => readTask(root, "joint-rail"), /joint-rail\/task\.json: is not JSON/);
	});
});

test("phases created through the model-facing path are numbered, ordered, and flippable", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		createPhase(readTask(root, "joint-rail"), "lifecycle-broker", "lifecycle broker", "first");
		createPhase(readTask(root, "joint-rail"), "robot-separation", "robot separation", "second");
		const created = readTask(root, "joint-rail");
		assert.deepEqual(created.phases.map((phase) => phase.file), [
			"01-lifecycle-broker.md",
			"02-robot-separation.md",
		]);
		assert.equal(nextOpenPhase(created)?.name, "01-lifecycle-broker");
		assert.deepEqual(taskProgress(created), { done: 0, total: 2 });

		setPhaseStatus(created, "01-lifecycle-broker", "done");
		const advanced = readTask(root, "joint-rail");
		assert.equal(nextOpenPhase(advanced)?.name, "02-robot-separation");
		assert.deepEqual(taskProgress(advanced), { done: 1, total: 2 });

		setPhaseStatus(advanced, "02-robot-separation", "done");
		const finished = readTask(root, "joint-rail");
		assert.equal(nextOpenPhase(finished), undefined);
		assert.deepEqual(taskProgress(finished), { done: 2, total: 2 });
	});
});

test("a maximum-length phase slug remains addressable after numbering", () => {
	withRoot((root) => {
		const task = createTask(root, "joint-rail", HEADER);
		const phase = createPhase(task, "x".repeat(48), "long phase", "body");
		assert.equal(phase.name, `01-${"x".repeat(48)}`);
		assert.equal(setPhaseStatus(readTask(root, "joint-rail"), phase.name, "done").status, "done");
	});
});

test("phase numbers come from the files, not the count", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		for (const name of ["a", "b", "c"]) {
			createPhase(readTask(root, "joint-rail"), name, name, "");
		}
		rmSync(join(root, "joint-rail", "phases", "02-b.md"));
		createPhase(readTask(root, "joint-rail"), "d", "d", "");
		assert.deepEqual(
			readTask(root, "joint-rail").phases.map((phase) => phase.name),
			["01-a", "03-c", "04-d"],
		);
	});
});

test("a name another phase already uses is not a collision: the numbers keep them apart", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		createPhase(readTask(root, "joint-rail"), "joint-rail", "joint rail", "");
		createPhase(readTask(root, "joint-rail"), "rail", "rail", "");
		assert.deepEqual(
			readTask(root, "joint-rail").phases.map((phase) => phase.name),
			["01-joint-rail", "02-rail"],
		);
	});
});

test("a phase name that is not a slug is refused: it becomes a file name", () => {
	withRoot((root) => {
		const task = createTask(root, "joint-rail", HEADER);
		assert.throws(() => createPhase(task, "../escape", "escape", ""), /invalid phase name/);
		assert.throws(() => createPhase(task, "Joint Rail", "joint rail", ""), /invalid phase name/);
	});
});

test("an unknown phase names the ones that exist instead of failing blankly", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		createPhase(readTask(root, "joint-rail"), "lifecycle-broker", "lifecycle broker", "first");
		assert.throws(
			() => setPhaseStatus(readTask(root, "joint-rail"), "02-robot", "done"),
			/01-lifecycle-broker/,
		);
	});
});

test("one broken task costs only itself", () => {
	withRoot((root) => {
		createTask(root, "joint-rail", HEADER);
		mkdirSync(join(root, "broken"));
		writeFileSync(join(root, "broken", "task.json"), "{}");
		const catalog = listTasks(root);
		assert.deepEqual(catalog.tasks.map((task) => task.slug), ["joint-rail"]);
		assert.equal(catalog.broken.length, 1);
		assert.match(catalog.broken[0]!, /^broken: /);
	});
});

test("the stage is whichever artifact is missing, and redoing one does not move it back", () => {
	withRoot((root) => {
		// The model's artifacts live under notes/; task.json and phases/ are the extension's.
		const write = (relative: string, text: string) =>
			writeFileSync(join(root, "joint-rail", "notes", relative), text);

		createTask(root, "joint-rail", HEADER);
		assert.equal(currentStage(readTask(root, "joint-rail")), "questions");

		write("questions.md", "1. trace the flow\n");
		assert.equal(currentStage(readTask(root, "joint-rail")), "research");

		write("research.md", "Rails persist before ack.\n");
		assert.equal(currentStage(readTask(root, "joint-rail")), "design");

		write("plan.md", "# Problem\n");
		assert.equal(currentStage(readTask(root, "joint-rail")), "phases");

		createPhase(readTask(root, "joint-rail"), "lifecycle-broker", "lifecycle broker", "first");
		assert.equal(currentStage(readTask(root, "joint-rail")), "implement");

		// Redoing a stage rewrites its artifact; nothing downstream is deleted, so the stage stays.
		write("plan.md", "# Problem\n\nRewritten.\n");
		assert.equal(currentStage(readTask(root, "joint-rail")), "implement");
	});
});

test("stage names round-trip the argument the operator types", () => {
	for (const stage of STAGES) assert.equal(isStage(stage), true);
	assert.equal(isStage("planning"), false);
	assert.equal(isStage(""), false);
});

test("a status flip preserves the body exactly", () => {
	withPhases({ "01-a.md": serializePhase(OPEN, "line one\n\n  indented\n") }, (directory) => {
		const before = listPhases(directory)[0]!;
		writeFileSync(
			join(directory, "phases", before.file),
			serializePhase({ title: before.title, status: "done" }, before.body),
		);
		const after = listPhases(directory)[0]!;
		assert.equal(after.status, "done");
		assert.equal(after.body, before.body);
		assert.equal(
			readFileSync(join(directory, "phases", after.file), "utf-8").split("\n")[0],
			'{"title":"lifecycle broker","status":"done"}',
		);
	});
});
