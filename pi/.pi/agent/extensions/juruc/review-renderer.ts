import { getLineAnnotationName } from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import type { ReviewPatch, ReviewPatchFile } from "./review-git.ts";
import type { ReviewSide } from "./task.ts";
import type {
	AgentAnnotation,
	HumanComment,
	ReviewState,
} from "./review-state.ts";

export type ReviewMode = "auto" | "split" | "stack";
export type ReviewAutoLayout = Exclude<ReviewMode, "auto">;

export interface ReviewViewOptions {
	mode: ReviewMode;
	lineNumbers: boolean;
	wrap: boolean;
	hunkHeaders: boolean;
	agentNotes: boolean;
}

export const DEFAULT_REVIEW_VIEW_OPTIONS: ReviewViewOptions = {
	mode: "auto",
	lineNumbers: true,
	wrap: false,
	hunkHeaders: true,
	agentNotes: true,
};

interface AnnotationGroup {
	side: ReviewSide;
	line: number;
	agents: AgentAnnotation[];
	comments: HumanComment[];
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function targetLabel(
	side: ReviewSide,
	startLine: number,
	endLine = startLine,
): string {
	const lines = startLine === endLine ? `L${startLine}` : `L${startLine}–L${endLine}`;
	return `${side === "additions" ? "new" : "old"} ${lines}`;
}

function annotationGroups(
	filePath: string,
	state: ReviewState,
	includeAgentNotes: boolean,
): AnnotationGroup[] {
	const groups = new Map<string, AnnotationGroup>();
	const group = (side: ReviewSide, line: number): AnnotationGroup => {
		const key = `${side}:${line}`;
		let current = groups.get(key);
		if (!current) {
			current = { side, line, agents: [], comments: [] };
			groups.set(key, current);
		}
		return current;
	};
	if (includeAgentNotes)
		for (const annotation of state.agentAnnotations)
			if (annotation.filePath === filePath)
				group(annotation.side, annotation.line).agents.push(annotation);
	for (const comment of state.humanComments)
		if (comment.filePath === filePath)
			group(comment.side, comment.startLine).comments.push(comment);
	return [...groups.values()].sort(
		(left, right) => left.line - right.line || left.side.localeCompare(right.side),
	);
}

function renderAnnotationGroup(group: AnnotationGroup, canEdit: boolean): string {
	const slot = getLineAnnotationName({
		side: group.side,
		lineNumber: group.line,
	});
	const agents = group.agents.map(
		(annotation) => `<article class="annotation agent-note">
	<div class="annotation-label"><strong>Agent note</strong><span>${escapeHtml(annotation.source)} · ${escapeHtml(targetLabel(annotation.side, annotation.line))}</span></div>
	<p>${escapeHtml(annotation.summary)}</p>
	${annotation.rationale ? `<p class="annotation-rationale">${escapeHtml(annotation.rationale)}</p>` : ""}
</article>`,
	);
	const comments = group.comments.map(
		(comment) => `<article class="annotation human-feedback">
	<div class="annotation-label"><strong>Your feedback</strong><div class="annotation-meta"><span>${escapeHtml(targetLabel(comment.side, comment.startLine, comment.endLine))}</span>${canEdit ? `<div class="comment-actions"><button type="button" class="edit-comment" data-comment-id="${escapeHtml(comment.id)}">Edit</button><button type="button" class="delete-comment" data-comment-id="${escapeHtml(comment.id)}">Delete</button></div>` : ""}</div></div>
	<p>${escapeHtml(comment.body)}</p>
</article>`,
	);
	return `<div class="annotation-group" slot="${escapeHtml(slot)}">${[...agents, ...comments].join("")}</div>`;
}

function renderDecision(state: ReviewState): string {
	if (!state.decision)
		return '<div class="review-status open"><span></span>Awaiting decision</div>';
	const label = state.decision.kind === "approve" ? "Approved" : "Feedback sent";
	return `<div class="review-status completed" title="${escapeHtml(state.decision.decidedAt)}"><span></span>${label}</div>`;
}

function enabled(value: boolean): "on" | "off" {
	return value ? "on" : "off";
}

export function reviewViewSearch(
	options: ReviewViewOptions,
	autoLayout?: ReviewAutoLayout,
): string {
	const search = new URLSearchParams({
		mode: options.mode,
		"line-numbers": enabled(options.lineNumbers),
		wrap: enabled(options.wrap),
		"hunk-headers": enabled(options.hunkHeaders),
		"agent-notes": enabled(options.agentNotes),
	});
	if (options.mode === "auto" && autoLayout)
		search.set("auto-layout", autoLayout);
	return search.toString();
}

function viewHref(
	basePath: string,
	options: ReviewViewOptions,
	overrides: Partial<ReviewViewOptions>,
	autoLayout?: ReviewAutoLayout,
): string {
	const next = { ...options, ...overrides };
	return `${basePath}?${reviewViewSearch(next, next.mode === "auto" ? autoLayout : undefined)}`;
}

function renderModeControls(
	basePath: string,
	options: ReviewViewOptions,
	autoLayout?: ReviewAutoLayout,
): string {
	const link = (mode: ReviewMode, label: string, shortcut: string): string =>
		`<a href="${escapeHtml(viewHref(basePath, options, { mode }, autoLayout))}" data-shortcut="${shortcut}" aria-current="${options.mode === mode ? "page" : "false"}" title="${label} (${shortcut})">${label}</a>`;
	return `<nav class="layout-control" aria-label="Diff layout">
	${link("auto", "Auto", "0")}
	${link("split", "Split", "1")}
	${link("stack", "Stack", "2")}
</nav>`;
}

function renderViewMenu(
	basePath: string,
	options: ReviewViewOptions,
	autoLayout?: ReviewAutoLayout,
): string {
	const option = (
		key: keyof Omit<ReviewViewOptions, "mode">,
		label: string,
		shortcut: string,
	): string => {
		const active = options[key];
		return `<a href="${escapeHtml(viewHref(basePath, options, { [key]: !active }, autoLayout))}" role="menuitemcheckbox" aria-checked="${active}" data-shortcut="${shortcut}"><span>${label}</span><kbd>${shortcut}</kbd><span class="option-check" aria-hidden="true">${active ? "✓" : ""}</span></a>`;
	};
	return `<details class="view-menu">
	<summary>View</summary>
	<div class="view-options" role="menu">
		${option("lineNumbers", "Line numbers", "l")}
		${option("wrap", "Line wrap", "w")}
		${option("hunkHeaders", "Hunk metadata", "m")}
		${option("agentNotes", "Agent notes", "a")}
		<button type="button" id="sidebar-toggle" role="menuitemcheckbox" aria-checked="true" data-shortcut="s"><span>Sidebar</span><kbd>s</kbd><span class="option-check" aria-hidden="true">✓</span></button>
	</div>
</details>`;
}

export class ReviewRenderer {
	private readonly cache = new Map<string, Promise<string>>();
	private readonly patch: ReviewPatch;

	constructor(patch: ReviewPatch) {
		this.patch = patch;
	}

	private prerender(
		file: ReviewPatchFile,
		options: ReviewViewOptions,
		resolvedMode: ReviewAutoLayout,
		groups: AnnotationGroup[],
	): Promise<string> {
		const anchors = groups.map(({ side, line }) => ({ side, lineNumber: line }));
		const key = JSON.stringify([
			file.filePath,
			options.mode,
			resolvedMode,
			options.lineNumbers,
			options.wrap,
			options.hunkHeaders,
			options.agentNotes,
			anchors.map(({ side, lineNumber }) => `${side}:${lineNumber}`),
		]);
		let rendered = this.cache.get(key);
		if (!rendered) {
			rendered = preloadFileDiff({
				fileDiff: file.fileDiff,
				annotations: anchors,
				options: {
					diffStyle: resolvedMode === "stack" ? "unified" : "split",
					diffIndicators: "bars",
					themeType: "dark",
					disableFileHeader: true,
					disableLineNumbers: !options.lineNumbers,
					hunkSeparators: options.hunkHeaders ? "metadata" : "simple",
					lineDiffType: "word-alt",
					overflow: options.wrap ? "wrap" : "scroll",
				},
			}).then(({ prerenderedHTML }) => prerenderedHTML);
			this.cache.set(key, rendered);
		}
		return rendered;
	}

	private async renderFile(
		file: ReviewPatchFile,
		index: number,
		state: ReviewState,
		options: ReviewViewOptions,
		resolvedMode: ReviewAutoLayout,
	): Promise<string> {
		const groups = annotationGroups(file.filePath, state, options.agentNotes);
		const previous = file.previousPath
			? `<span class="previous-path">from ${escapeHtml(file.previousPath)}</span>`
			: "";
		const diff = file.fileDiff.hunks.length
			? `<diffs-container data-file-path="${escapeHtml(file.filePath)}"><template shadowrootmode="open">${await this.prerender(file, options, resolvedMode, groups)}</template>${groups.map((group) => renderAnnotationGroup(group, state.decision === null)).join("")}</diffs-container>`
			: '<div class="no-text-hunks">Git reported no changed text lines for this file.</div>';
		const changeType = file.type === "change"
			? ""
			: `<span class="change-type">${escapeHtml(file.type)}</span>`;
		return `<section id="file-${index}" class="file-section" data-review-file="${escapeHtml(file.filePath)}">
	<header class="file-header"><div><h2>${escapeHtml(file.filePath)}</h2>${previous}</div>${changeType}</header>
	${diff}
</section>`;
	}

	async render(
		state: ReviewState,
		options: ReviewViewOptions,
		basePath: string,
		autoLayout?: ReviewAutoLayout,
	): Promise<string> {
		const resolvedMode = options.mode === "auto" ? (autoLayout ?? "split") : options.mode;
		const files = this.patch.empty
			? `<section class="empty-diff"><h2>No changes to review</h2><p>The exact base and head resolve to an empty cumulative Git patch.</p></section>`
			: (
				await Promise.all(
					this.patch.files.map((file, index) =>
						this.renderFile(file, index, state, options, resolvedMode),
					),
				)
			).join("");
		const sidebar = this.patch.files.map((file, index) =>
			`<a href="#file-${index}"${index === 0 ? ' aria-current="location"' : ""} title="${escapeHtml(file.filePath)}"><span class="sidebar-path">${escapeHtml(file.filePath)}</span><span class="file-counts"><span class="additions">+${file.changed.additions.length}</span><span class="deletions">-${file.changed.deletions.length}</span></span></a>`,
		).join("");
		const completed = state.decision !== null;
		const approveDisabled = completed || state.humanComments.length > 0;
		const reviewRange = `${state.patch.baseOid}...${state.patch.headOid}`;
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>JURUC local review</title>
	<link rel="stylesheet" href="${escapeHtml(basePath)}review.css">
</head>
<body data-api-base="${escapeHtml(basePath)}api/" data-review-range="${escapeHtml(reviewRange)}" data-mode="${options.mode}" data-resolved-mode="${resolvedMode}" data-layout="${resolvedMode === "stack" ? "unified" : "split"}">
	<header class="topbar">
		<div class="review-title" title="Exact range: ${escapeHtml(reviewRange)}"><strong>Review</strong><span>${this.patch.files.length} file${this.patch.files.length === 1 ? "" : "s"}</span></div>
		<div class="topbar-actions">
			${renderDecision(state)}
			${renderModeControls(basePath, options, autoLayout)}
			${renderViewMenu(basePath, options, autoLayout)}
		</div>
	</header>
	<main class="review-shell">
		<aside class="file-sidebar" aria-label="Changed files"><div class="sidebar-heading">Files</div><nav>${sidebar}</nav></aside>
		<div class="review-content">
			<section class="review-context"><span>Cumulative diff</span><span>Select a changed line to comment; Shift-select a range.</span></section>
			<div class="files">${files}</div>
		</div>
	</main>
	<section id="comment-composer" class="comment-composer" hidden aria-label="Feedback editor">
		<div><span id="comment-heading" class="eyebrow">Your feedback</span><strong id="comment-target"></strong></div>
		<textarea id="comment-body" maxlength="10000" rows="3" placeholder="Describe one concrete correction…"></textarea>
		<div class="composer-actions"><button type="button" id="cancel-comment" class="button quiet">Cancel</button><button type="button" id="save-comment" class="button primary"><span id="save-comment-label">Save feedback</span> <kbd>Ctrl/⌘ Enter</kbd></button></div>
	</section>
	<footer class="decision-bar">
		<div class="decision-inner">
			<p id="browser-status" role="status" aria-live="polite">${completed ? "This review is complete." : `${state.humanComments.length} saved feedback comment${state.humanComments.length === 1 ? "" : "s"}.`}</p>
			<div class="decision-actions">
				<button type="button" class="button approve" data-decision="approve"${approveDisabled ? " disabled" : ""}>Approve</button>
				<button type="button" class="button feedback" data-decision="send-feedback"${completed || state.humanComments.length === 0 ? " disabled" : ""}>Send Feedback</button>
			</div>
		</div>
	</footer>
	<script type="module" src="${escapeHtml(basePath)}review.js"></script>
</body>
</html>`;
	}
}
