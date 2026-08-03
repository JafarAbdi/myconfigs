import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	composeLifecycleLine,
	lifecycleDetail,
	lifecycleRail,
	type RailCell,
	railCellText,
} from "./status.ts";
import type { TaskDocument } from "./task.ts";

export const REVIEW_LINK_TEXT = "Open review ↗";
/** The calm minimum between the lifecycle line and the right-aligned action. */
const ACTION_GAP = 3;

/**
 * BEL-terminated OSC 8, because some terminals make only BEL-terminated links
 * clickable. Terminals without hyperlink support show the plain text instead.
 */
function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export interface StatusLineOptions {
	width: number;
	/** The live capability URL of this task's open review round, if one is serving. */
	reviewUrl?: string;
	/** Absent outside the TUI, where the same line is rendered as plain text. */
	theme?: Theme;
}

/**
 * One width-safe status line: the marked rail, the plain-spoken context, and the review
 * action against the right edge. The context absorbs every truncation, so the action is
 * rendered whole or not at all and never splits its OSC 8 run.
 */
export function statusLine(task: TaskDocument, options: StatusLineOptions): string {
	const { width, reviewUrl, theme } = options;
	const rail = lifecycleRail(task);
	const paint = (cell: RailCell) => {
		const text = railCellText(cell);
		if (!theme) return text;
		// The opened stage carries full weight; a ready one is the same accent unbolded, so
		// the eye finds the next step without mistaking it for a live session.
		if (cell.role === "opened") return theme.bold(theme.fg("accent", text));
		if (cell.role === "ready") return theme.fg("accent", text);
		if (cell.role === "future") return theme.fg("dim", text);
		// Done stays legible without competing with the current cell: the tick keeps its
		// success colour while the label recedes.
		return `${theme.fg("success", cell.marker)} ${theme.fg("muted", cell.label)}`;
	};
	const detail = lifecycleDetail(task);
	const painted = theme ? theme.fg(task.stage === "done" ? "success" : "text", detail) : detail;
	const line = composeLifecycleLine(rail.map(paint), painted);
	if (reviewUrl) {
		// The rail is the floor: with less room than rail, gap, and action, the action goes.
		const budget = width - visibleWidth(REVIEW_LINK_TEXT) - ACTION_GAP;
		if (budget >= visibleWidth(rail.map(railCellText).join("  "))) {
			const action = hyperlink(theme ? theme.fg("accent", REVIEW_LINK_TEXT) : REVIEW_LINK_TEXT, reviewUrl);
			return `${truncateToWidth(line, budget, "…", true)}${" ".repeat(ACTION_GAP)}${action}`;
		}
	}
	return truncateToWidth(line, width, "…");
}

/** The managed-session widget; Pi re-renders it at the current terminal width. */
export function statusWidget(
	task: TaskDocument,
	reviewUrl?: string,
): (tui: TUI, theme: Theme) => Component {
	// Every render recomputes its theme colours, so a theme change needs no cached state.
	return (_tui, theme) => ({
		render: (width: number) => [statusLine(task, { width, theme, ...(reviewUrl ? { reviewUrl } : {}) })],
		invalidate: () => {},
	});
}
