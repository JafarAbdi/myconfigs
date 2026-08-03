import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { lifecycleLine, lifecycleRail } from "./status.ts";
import type { TaskDocument } from "./task.ts";

export const REVIEW_LINK_TEXT = "Open review ↗";
const REVIEW_LINK_TAIL = ` · ${REVIEW_LINK_TEXT}`;

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
}

/**
 * One width-safe status line. The plain lifecycle detail absorbs every truncation,
 * so the review link is rendered whole or not at all and never splits its OSC 8 run.
 */
export function statusLine(task: TaskDocument, options: StatusLineOptions): string {
	const { width, reviewUrl } = options;
	const line = lifecycleLine(task);
	if (reviewUrl) {
		const budget = width - visibleWidth(REVIEW_LINK_TAIL);
		if (budget >= visibleWidth(lifecycleRail(task)))
			return `${truncateToWidth(line, budget, "…")} · ${hyperlink(REVIEW_LINK_TEXT, reviewUrl)}`;
	}
	return truncateToWidth(line, width, "…");
}

/** The managed-session widget; Pi re-renders it at the current terminal width. */
export function statusWidget(
	task: TaskDocument,
	reviewUrl?: string,
): (tui: TUI, theme: Theme) => Component {
	return () => ({
		render: (width: number) => [statusLine(task, { width, ...(reviewUrl ? { reviewUrl } : {}) })],
		invalidate: () => {},
	});
}
