import { getLineAnnotationName } from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";
import type { AuditFinding } from "./audit.ts";
import type { ReviewPatch, ReviewPatchFile, ReviewSide } from "./review-git.ts";
import type { HumanComment, ReviewState } from "./review-state.ts";

export type ReviewMode = "auto" | "split" | "stack";
export type ReviewAutoLayout = Exclude<ReviewMode, "auto">;

export interface ReviewViewOptions {
	mode: ReviewMode;
	lineNumbers: boolean;
	wrap: boolean;
	hunkHeaders: boolean;
	auditFindings: boolean;
}

export const DEFAULT_REVIEW_VIEW_OPTIONS: ReviewViewOptions = {
	mode: "stack",
	lineNumbers: true,
	wrap: false,
	hunkHeaders: true,
	auditFindings: true,
};

const COMMENT_CONTROL_CSS = `
[data-content],
[data-line] {
	user-select: text;
}
[data-column-number] {
	position: relative;
}
[data-utility-button] {
	appearance: none;
	background: transparent;
	border: 0;
	border-radius: 5px;
	color: var(--review-accent);
	cursor: pointer;
	display: grid;
	font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
	height: 24px;
	opacity: 0.55;
	padding: 0;
	place-items: center;
	width: 24px;
}
[data-column-number]:hover [data-utility-button] {
	background: var(--review-accent-soft);
	opacity: 0.78;
}
[data-utility-button]:hover,
[data-utility-button]:focus-visible {
	opacity: 1;
}
[data-utility-button]:focus-visible {
	outline: 2px solid var(--review-accent);
	outline-offset: 1px;
}
[data-disable-line-numbers] [data-column-number] {
	min-width: calc(1lh + 6px);
}
@media (hover: none), (pointer: coarse) {
	[data-utility-button] {
		opacity: 1;
	}
}
`;

interface AnnotationGroup {
	side: ReviewSide;
	line: number;
	findings: AuditFinding[];
	comments: HumanComment[];
}

interface HunkTarget {
	side: ReviewSide;
	line: number;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function sourceLabel(source: ReviewPatch["snapshot"]["source"]): string {
	return source === "staged" ? "Staged" : source === "worktree" ? "Worktree" : "Untracked";
}

function sourceComparison(source: ReviewPatch["snapshot"]["source"]): string {
	return source === "staged"
		? "HEAD → index"
		: source === "worktree"
			? "index → tracked working tree"
			: "/dev/null → untracked files";
}

function targetLabel(
	side: ReviewSide,
	startLine: number,
	endLine = startLine,
): string {
	const lines = startLine === endLine ? `L${startLine}` : `L${startLine}–L${endLine}`;
	return `${side === "additions" ? "new" : "old"} ${lines}`;
}

function hunkTargets(file: ReviewPatchFile): HunkTarget[] {
	return file.fileDiff.hunks.map((hunk) => {
		let additionLine = hunk.additionStart;
		let deletionLine = hunk.deletionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === "context") {
				additionLine += content.lines;
				deletionLine += content.lines;
				continue;
			}
			if (content.deletions > 0) return { side: "deletions", line: deletionLine };
			if (content.additions > 0) return { side: "additions", line: additionLine };
		}
		throw new Error(`Review hunk for ${file.filePath} has no changed lines`);
	});
}

function annotationGroups(
	filePath: string,
	state: ReviewState,
	includeAuditFindings: boolean,
): AnnotationGroup[] {
	const groups = new Map<string, AnnotationGroup>();
	const group = (side: ReviewSide, line: number): AnnotationGroup => {
		const key = `${side}:${line}`;
		let current = groups.get(key);
		if (!current) {
			current = { side, line, findings: [], comments: [] };
			groups.set(key, current);
		}
		return current;
	};
	if (includeAuditFindings)
		for (const finding of state.auditFindings)
			if (finding.filePath === filePath)
				group(finding.side, finding.line).findings.push(finding);
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
	const findings = group.findings.map(
		(finding) => `<article class="annotation audit-finding" data-agent-comment>
	<div class="annotation-label"><strong>Audit finding</strong><span>${escapeHtml(finding.category)} · ${escapeHtml(targetLabel(finding.side, finding.line))}</span></div>
	<p class="finding-message">${escapeHtml(finding.message)}</p>
</article>`,
	);
	const comments = group.comments.map(
		(comment) => `<article class="annotation human-comment">
	<div class="annotation-label"><strong>Your comment</strong><div class="annotation-meta"><span>${escapeHtml(targetLabel(comment.side, comment.startLine, comment.endLine))}</span>${canEdit ? `<div class="comment-actions"><button type="button" class="edit-comment" data-comment-id="${escapeHtml(comment.id)}">Edit</button><button type="button" class="delete-comment" data-comment-id="${escapeHtml(comment.id)}">Delete</button></div>` : ""}</div></div>
	<p>${escapeHtml(comment.body)}</p>
</article>`,
	);
	return `<div class="annotation-group" slot="${escapeHtml(slot)}">${[...findings, ...comments].join("")}</div>`;
}

function renderGeneralFeedback(state: ReviewState): string {
	if (!state.generalComment) {
		return state.decision
			? ""
			: `<section class="general-feedback empty-general-feedback" aria-label="General feedback">
	<button type="button" id="add-general-comment" class="button quiet">Add general feedback</button>
</section>`;
	}
	const actions = state.decision
		? ""
		: `<div class="comment-actions"><button type="button" class="edit-general-comment">Edit</button><button type="button" class="delete-general-comment">Delete</button></div>`;
	return `<section class="general-feedback" aria-label="General feedback">
	<article class="annotation human-comment general-comment">
		<div class="annotation-label"><strong>General feedback</strong><div class="annotation-meta"><span>Entire candidate</span>${actions}</div></div>
		<p>${escapeHtml(state.generalComment.body)}</p>
	</article>
</section>`;
}

function renderDecision(state: ReviewState): string {
	if (!state.decision)
		return '<div id="review-status" class="review-status open"><span></span>Awaiting decision</div>';
	const label = state.decision.kind === "approve" ? "Approved" : "Feedback sent";
	return `<div id="review-status" class="review-status completed" title="${escapeHtml(state.decision.decidedAt)}"><span></span>${label}</div>`;
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
		"audit-findings": enabled(options.auditFindings),
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

function renderNavigationControl(
	kind: "hunk" | "agent-comment",
	label: "Hunk" | "Agent",
	count: number,
	previousShortcut: string,
	nextShortcut: string,
): string {
	const disabled = count === 0 ? " disabled" : "";
	return `<nav class="navigation-control" aria-label="${label} navigation">
	<button type="button" id="previous-${kind}" aria-label="Previous ${label.toLowerCase()}" title="Previous ${label.toLowerCase()} (${previousShortcut})" disabled>↑</button>
	<span id="${kind}-position">${count === 0 ? `No ${label.toLowerCase()}s` : `${label}s ${count}`}</span>
	<button type="button" id="next-${kind}" aria-label="Next ${label.toLowerCase()}" title="Next ${label.toLowerCase()} (${nextShortcut})"${disabled}>↓</button>
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
		${option("auditFindings", "Audit findings", "a")}
		<button type="button" id="sidebar-toggle" role="menuitemcheckbox" aria-checked="false" data-shortcut="s"><span>Sidebar</span><kbd>s</kbd><span class="option-check" aria-hidden="true"></span></button>
	</div>
</details>`;
}

export class ReviewRenderer {
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
		return preloadFileDiff({
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
				unsafeCSS: COMMENT_CONTROL_CSS,
			},
		}).then(({ prerenderedHTML }) => prerenderedHTML);
	}

	private async renderFile(
		file: ReviewPatchFile,
		index: number,
		state: ReviewState,
		options: ReviewViewOptions,
		resolvedMode: ReviewAutoLayout,
	): Promise<string> {
		const groups = annotationGroups(file.filePath, state, options.auditFindings);
		const previous = file.previousPath
			? `<span class="previous-path">from ${escapeHtml(file.previousPath)}</span>`
			: "";
		const diff = file.fileDiff.hunks.length
			? `<diffs-container data-file-path="${escapeHtml(file.filePath)}"><template shadowrootmode="open">${await this.prerender(file, options, resolvedMode, groups)}</template>${groups.map((group) => renderAnnotationGroup(group, state.decision === null)).join("")}</diffs-container>`
			: '<div class="no-text-hunks">Git reported no changed text lines for this file.</div>';
		const changeType = file.type === "change"
			? ""
			: `<span class="change-type">${escapeHtml(file.type)}</span>`;
		const targets = escapeHtml(JSON.stringify(hunkTargets(file)));
		return `<section id="file-${index}" class="file-section" data-review-file="${escapeHtml(file.filePath)}" data-hunk-targets="${targets}">
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
		const source = sourceLabel(this.patch.snapshot.source);
		const scope = this.patch.snapshot.paths.length === 0
			? "all source paths"
			: `selected: ${JSON.stringify(this.patch.snapshot.paths)}`;
		const files = this.patch.empty
			? `<section class="empty-diff"><h2>No ${source.toLowerCase()} changes to review</h2><p>The exact selected Git candidate is empty.</p></section>`
			: (await Promise.all(
				this.patch.files.map((file, index) =>
					this.renderFile(file, index, state, options, resolvedMode),
				),
			)).join("");
		const sidebar = this.patch.files.map((file, index) =>
			`<a href="#file-${index}"${index === 0 ? ' aria-current="location"' : ""} title="${escapeHtml(file.filePath)}"><span class="sidebar-path">${escapeHtml(file.filePath)}</span><span class="file-counts"><span class="additions">+${file.changed.additions.length}</span><span class="deletions">-${file.changed.deletions.length}</span></span></a>`,
		).join("");
		const completed = state.decision !== null;
		const humanCommentCount = state.humanComments.length + (state.generalComment ? 1 : 0);
		const hunkCount = this.patch.files.reduce(
			(total, file) => total + file.fileDiff.hunks.length,
			0,
		);
		const approveDisabled = completed || humanCommentCount > 0;
		const feedbackDisabled = completed ||
			(state.auditFindings.length === 0 && humanCommentCount === 0);
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>Review</title>
	<link rel="stylesheet" href="${escapeHtml(basePath)}review.css">
</head>
<body class="sidebar-hidden" data-api-base="${escapeHtml(basePath)}api/" data-mode="${options.mode}" data-resolved-mode="${resolvedMode}" data-layout="${resolvedMode === "stack" ? "unified" : "split"}" data-completed="${completed}">
	<header class="topbar">
		<div class="review-title" title="${source} candidate · ${escapeHtml(sourceComparison(this.patch.snapshot.source))} · HEAD ${escapeHtml(state.snapshot.headOid)}"><strong>${source} review</strong><span>${this.patch.files.length} file${this.patch.files.length === 1 ? "" : "s"}</span></div>
		<div class="topbar-actions">
			${renderDecision(state)}
			${renderNavigationControl("hunk", "Hunk", hunkCount, "[", "]")}
			${options.auditFindings ? renderNavigationControl("agent-comment", "Agent", state.auditFindings.length, "{", "}") : ""}
			${renderModeControls(basePath, options, autoLayout)}
			${renderViewMenu(basePath, options, autoLayout)}
		</div>
	</header>
	<main class="review-shell">
		<aside class="file-sidebar" aria-label="Changed files"><div class="sidebar-heading">Files</div><nav>${sidebar}</nav></aside>
		<div class="review-content">
			<section class="review-context"><span>${source} · ${escapeHtml(sourceComparison(this.patch.snapshot.source))} · ${escapeHtml(scope)}</span><span id="review-instruction">${completed ? "Read-only completion receipt." : "Click + on a changed line to comment; Shift-click + to extend a contiguous range."}</span></section>
			${renderGeneralFeedback(state)}
			<div class="files">${files}</div>
		</div>
	</main>
	<section id="comment-composer" class="comment-composer" hidden aria-label="Comment editor">
		<div><span id="comment-heading" class="eyebrow">Your comment</span><strong id="comment-target"></strong></div>
		<textarea id="comment-body" maxlength="10000" rows="3" placeholder="Describe one concrete correction…"></textarea>
		<div class="composer-actions"><button type="button" id="cancel-comment" class="button quiet">Cancel</button><button type="button" id="save-comment" class="button primary"><span id="save-comment-label">Save comment</span> <kbd>Ctrl/⌘ Enter</kbd></button></div>
	</section>
	<footer class="decision-bar">
		<div class="decision-inner">
			<p id="browser-status" role="status" aria-live="polite">${state.decision ? `${state.decision.kind === "approve" ? "Approved" : "Feedback sent"}. Decision recorded; this tab may be closed.` : `${humanCommentCount} saved comment${humanCommentCount === 1 ? "" : "s"}.`}</p>
			<div class="decision-actions">
				<button type="button" class="button approve" data-decision="approve"${approveDisabled ? " disabled" : ""}>Approve</button>
				<button type="button" class="button feedback" data-decision="send-feedback"${feedbackDisabled ? " disabled" : ""}>Send Feedback</button>
			</div>
		</div>
	</footer>
	<script type="module" src="${escapeHtml(basePath)}review.js"></script>
</body>
</html>`;
	}
}
