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

/** What the terminal actually shows, once hyperlink and truncation codes are removed. */
const plain = (line: string) => line.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m/gu, "");

function reviewTask(title: string): TaskDocument {
	let current = confirmTaskQuestions(
		createTaskDocument({
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
		}),
		{
			sharedUnderstanding: "Show the review link.",
			decisions: [],
			acceptedAssumptions: [],
			researchTargets: [],
		},
	);
	current = completeTaskResearch(current);
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

test("a live review renders one BEL-terminated OSC 8 link after the compact detail", () => {
	const line = statusLine(awaitingDecision(), { width: 80, reviewUrl: URL_SENTINEL });
	assert.equal(line, `Q✓ R✓ S✓ P✓ I✓ · review 1 · preparing · ${LINK}`);
	assert.equal(visibleWidth(line), visibleWidth("Q✓ R✓ S✓ P✓ I✓ · review 1 · preparing · Open review ↗"));
	assert.equal(line.includes(URL_SENTINEL), true);
	assert.equal(statusLine(awaitingDecision(), { width: 80 }), "Q✓ R✓ S✓ P✓ I✓ · review 1 · preparing");
});

test("the review link stays whole or is dropped, and the plain detail absorbs truncation", () => {
	const task = awaitingDecision();
	const plain = "Q✓ R✓ S✓ P✓ I✓ · review 1 · preparing";
	const full = visibleWidth(`${plain} · ${REVIEW_LINK_TEXT}`);
	for (let width = 0; width <= full + 4; width += 1) {
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
		assert.equal(linked, width >= visibleWidth("Q✓ R✓ S✓ P✓ I✓") + visibleWidth(` · ${REVIEW_LINK_TEXT}`));
	}
	assert.equal(statusLine(task, { width: 0, reviewUrl: URL_SENTINEL }), "");
});

test("a long phase title is truncated to width with and without the link", () => {
	const task = reviewTask("Connect every managed discovery session to its fresh runtime");
	const narrow = statusLine(task, { width: 46 });
	assert.equal(plain(narrow), "Q✓ R✓ S✓ P✓ I● · phase 1/1 · Connect every ma…");
	assert.equal(visibleWidth(narrow), 46);
	const linked = statusLine(task, { width: 46, reviewUrl: URL_SENTINEL });
	assert.equal(plain(linked), "Q✓ R✓ S✓ P✓ I● · phase 1/1 · … · Open review ↗");
	assert.equal(linked.includes(LINK), true);
	assert.equal(visibleWidth(linked), 46);
});

test("the widget factory renders exactly one line at the requested width", () => {
	const component = statusWidget(awaitingDecision(), URL_SENTINEL)(undefined as never, undefined as never);
	const lines = component.render(80);
	assert.equal(lines.length, 1);
	assert.equal(lines[0], statusLine(awaitingDecision(), { width: 80, reviewUrl: URL_SENTINEL }));
	const narrow = statusWidget(awaitingDecision())(undefined as never, undefined as never).render(24);
	assert.equal(narrow.length, 1);
	assert.equal(plain(narrow[0]), "Q✓ R✓ S✓ P✓ I✓ · review…");
	component.invalidate();
});
