import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireTestLock } from "./test-lock.ts";
import {
	acceptTaskPlan,
	activateTaskPlan,
	completeTaskPhase,
	completeTaskResearch,
	confirmTaskQuestions,
	confirmTaskSpecification,
	createTaskDocument,
	type TaskDocument,
} from "./task.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const extensionsDirectory = dirname(extensionDirectory);
const releaseTestLock = await acquireTestLock("juruc-extension-node-modules.lock");
const localModules = join(extensionsDirectory, "node_modules");
const piExecutable = process.env.PATH?.split(delimiter)
	.map((directory) => join(directory, "pi"))
	.find(existsSync);
const piPackage = process.env.PI_PACKAGE_DIR ??
	(piExecutable ? join(dirname(realpathSync(piExecutable)), "..") : undefined);
if (!piPackage) throw new Error("pi package not found through PI_PACKAGE_DIR or PATH");
if (existsSync(localModules)) throw new Error(`${localModules} already exists; refusing to replace it`);
mkdirSync(join(localModules, "@earendil-works"), { recursive: true });
symlinkSync(
	join(piPackage, "node_modules", "@earendil-works", "pi-tui"),
	join(localModules, "@earendil-works", "pi-tui"),
	"dir",
);
function cleanup(): void {
	rmSync(localModules, { recursive: true, force: true });
	releaseTestLock();
}
process.once("exit", cleanup);

const { REVIEW_LINK_TEXT, statusLine, statusWidget } = await import("./status-widget.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const URL_SENTINEL = "http://127.0.0.1:45123/pWLZ4V2xEqQ8n1r7/?mode=auto";
const LINK = `\x1b]8;;${URL_SENTINEL}\x07${REVIEW_LINK_TEXT}\x1b]8;;\x07`;

/** Every rail is five marked cells, so all three stages below are exactly as wide. */
const QUESTIONS_RAIL = "● Q  ○ R  ○ S  ○ P  ○ I";
const IMPLEMENTATION_RAIL = "✓ Q  ✓ R  ✓ S  ✓ P  ● I";
const REVIEW_RAIL = "✓ Q  ✓ R  ✓ S  ✓ P  ✓ I";

/** What the terminal actually shows, once hyperlink and truncation codes are removed. */
const plain = (line: string) => line.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m/gu, "");

/** One distinct zero-width code per theme role, so the roles are visible in assertions. */
const CODE: Record<string, string> = { text: "39", accent: "36", muted: "90", dim: "2", success: "32" };
const theme = {
	fg: (color: string, text: string) => `\x1b[${CODE[color]}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const paint = (color: string) => (body: string) => theme.fg(color, body);
const [muted, dim, accent, body] = [paint("muted"), paint("dim"), paint("accent"), paint("text")];
/** The three cell shapes: a success tick beside a muted label, bold accent, and flat dim. */
const done = (label: string) => `${paint("success")("✓")} ${muted(label)}`;
const active = (cell: string) => theme.bold(accent(cell));

/** The action is flush against the right edge; the padding is whatever is left over. */
const rightAligned = (left: string, width: number) =>
	`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(REVIEW_LINK_TEXT))}${LINK}`;

function newTask(): TaskDocument {
	return createTaskDocument({
		slug: "widget-task",
		title: "Widget task",
		request: "Show the review link.",
		repository: {
			sourceRoot: "/source",
			baseBranch: "main",
			sourceHead: "1".repeat(40),
			branch: "widget-task",
			worktree: "/worktrees/widget-task",
		},
	});
}

function researchTask(): TaskDocument {
	return confirmTaskQuestions(newTask(), {
		sharedUnderstanding: "Show the review link.",
		decisions: [],
		acceptedAssumptions: [],
		researchTargets: [],
	});
}

function reviewTask(title: string): TaskDocument {
	let current = completeTaskResearch(researchTask());
	current = confirmTaskSpecification(current, {
		summary: "Show it.",
		requirements: ["Show the link."],
		nonGoals: [],
		constraints: [],
		acceptanceCriteria: ["The link is whole."],
		decisions: [],
	});
	return activateTaskPlan(acceptTaskPlan(current, {
		phases: [{
			id: "show-link",
			title,
			goal: "Show the link.",
			fileScopes: ["status-widget.ts"],
			instructions: ["Render the link."],
			verification: ["test status"],
		}],
	}));
}

function awaitingDecision(title = "Show link"): TaskDocument {
	return completeTaskPhase(
		reviewTask(title),
		"Done.",
		[{ command: "test status", exitCode: 0, summary: "Passed." }],
		"2".repeat(40),
	);
}

test("the questions line is one clean rail, three spaces, and one word", () => {
	assert.equal(statusLine(newTask(), { width: 80 }), `${QUESTIONS_RAIL}   Questions`);
	assert.equal(
		statusLine(newTask(), { width: 80, theme: theme as never }),
		`${active("● Q")}  ${dim("○ R")}  ${dim("○ S")}  ${dim("○ P")}  ${dim("○ I")}   ${
			body("Questions")
		}`,
	);
});

test("the TUI ticks what is done, accents where the task is, and dims what is ahead", () => {
	// Research is the one line that carries all three cell states at once.
	assert.equal(statusLine(researchTask(), { width: 80 }), `✓ Q  ● R  ○ S  ○ P  ○ I   Research`);
	assert.equal(
		statusLine(researchTask(), { width: 80, theme: theme as never }),
		`${done("Q")}  ${active("● R")}  ${dim("○ S")}  ${dim("○ P")}  ${dim("○ I")}   ${
			body("Research")
		}`,
	);
	assert.equal(
		statusLine(reviewTask("Show link"), { width: 80, theme: theme as never }),
		`${done("Q")}  ${done("R")}  ${done("S")}  ${done("P")}  ${active("● I")}   ${
			body("Phase 1/1 · Show link")
		}`,
	);
	// Review is past the rail, so every cell is ticked and only the action carries accent.
	const line = statusLine(awaitingDecision(), { width: 80, theme: theme as never, reviewUrl: URL_SENTINEL });
	assert.equal(
		line.startsWith(`${done("Q")}  ${done("R")}  ${done("S")}  ${done("P")}  ${done("I")}`),
		true,
	);
	assert.equal(line.includes(`\x1b]8;;${URL_SENTINEL}\x07${accent(REVIEW_LINK_TEXT)}\x1b]8;;\x07`), true);
	assert.equal(visibleWidth(line), 80);
});

test("a live review renders one BEL-terminated OSC 8 link against the right edge", () => {
	const line = statusLine(awaitingDecision(), { width: 80, reviewUrl: URL_SENTINEL });
	assert.equal(line, rightAligned(`${REVIEW_RAIL}   Review 1 · Preparing`, 80));
	assert.equal(visibleWidth(line), 80);
	assert.equal(line.includes(URL_SENTINEL), true);
	// Without the action the line keeps its natural length instead of padding out.
	assert.equal(
		statusLine(awaitingDecision(), { width: 80 }),
		`${REVIEW_RAIL}   Review 1 · Preparing`,
	);
});

test("the review link stays whole or is dropped, and the context absorbs truncation", () => {
	const task = awaitingDecision();
	const floor = visibleWidth(REVIEW_RAIL) + 3 + visibleWidth(REVIEW_LINK_TEXT);
	for (let width = 0; width <= floor + 20; width += 1) {
		const line = statusLine(task, { width, reviewUrl: URL_SENTINEL });
		assert.ok(
			visibleWidth(line) <= width,
			`width ${width} rendered ${visibleWidth(line)} visible columns`,
		);
		const linked = line.includes("\x1b]8;;");
		assert.equal(
			linked,
			line.includes(LINK),
			`width ${width} rendered a partial OSC 8 sequence`,
		);
		// The rail is the floor: below it the link is absent rather than clipped.
		assert.equal(linked, width >= floor);
		// Every linked line fills the viewport exactly, so the action sits on the edge.
		if (linked) assert.equal(visibleWidth(line), width);
	}
	assert.equal(statusLine(task, { width: 0, reviewUrl: URL_SENTINEL }), "");
});

test("a long phase title is truncated to width with and without the link", () => {
	const task = reviewTask("Connect every managed discovery session to its fresh runtime");
	const narrow = statusLine(task, { width: 46 });
	assert.equal(plain(narrow), `${IMPLEMENTATION_RAIL}   Phase 1/1 · Connect…`);
	assert.equal(visibleWidth(narrow), 46);
	const linked = statusLine(task, { width: 46, reviewUrl: URL_SENTINEL });
	assert.equal(plain(linked), `${IMPLEMENTATION_RAIL}   Pha…   ${REVIEW_LINK_TEXT}`);
	assert.equal(linked.includes(LINK), true);
	assert.equal(visibleWidth(linked), 46);
});

test("the widget factory renders exactly one themed line at the requested width", () => {
	const component = statusWidget(awaitingDecision(), URL_SENTINEL)(undefined as never, theme as never);
	const lines = component.render(80);
	assert.equal(lines.length, 1);
	assert.equal(
		lines[0],
		statusLine(awaitingDecision(), { width: 80, theme: theme as never, reviewUrl: URL_SENTINEL }),
	);
	const narrow = statusWidget(awaitingDecision())(undefined as never, theme as never).render(24);
	assert.equal(narrow.length, 1);
	assert.equal(plain(narrow[0]), `${REVIEW_RAIL}…`);
	component.invalidate();
});
