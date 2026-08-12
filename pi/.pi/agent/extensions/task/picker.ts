/**
 * The task picker — the dashboard and the only place tasks are created or destroyed by hand.
 *
 * It shows what is derivable and nothing else: each task's slug and how far its phases have got.
 * Creating a task is an explicit entry rather than a consequence of typing an unknown name, so a
 * typo can never start one. Deleting asks the command for a confirmation instead of confirming
 * here: the numbers that make that decision (commits the branch has, files not committed) are
 * Git's, and the plain dialog is where destructive answers belong.
 */

import {
	DynamicBorder,
	type ExtensionContext,
	keyHint,
	rawKeyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { currentStage, hasWorktree, taskProgress, type Task } from "./tasks.ts";

export type PickerChoice =
	| { kind: "new" }
	| { kind: "open"; slug: string }
	| { kind: "delete"; slug: string };

const NEW_TASK_LABEL = "+ new task";
const MAX_VISIBLE = 10;

/** The stage, or how many phases are done — the only progress that exists. */
export function taskSummary(task: Task): string {
	const stage = currentStage(task);
	if (stage !== "implement") return `${stage} stage`;
	if (!hasWorktree(task)) return "ready for a worktree";
	const { done, total } = taskProgress(task);
	return done === total ? `${total} phases done` : `${done}/${total} phases`;
}

/** One entry per row: the create entry first, then every task, filtered as one list. */
interface Row {
	slug: string | undefined;
	label: string;
	detail: string;
}

function rowsFor(tasks: Task[]): Row[] {
	return [
		{ slug: undefined, label: NEW_TASK_LABEL, detail: "" },
		...tasks.map((task) => ({
			slug: task.slug,
			label: task.slug,
			detail: `${taskSummary(task)} · ${task.header.description}`,
		})),
	];
}

class TaskPicker extends Container implements Focusable {
	private readonly search = new Input();
	private readonly list = new Container();
	private rows: Row[];
	private filtered: Row[];
	private selected = 0;
	private focus = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		tasks: Task[],
		private readonly done: (choice: PickerChoice | undefined) => void,
	) {
		super();
		this.rows = rowsFor(tasks);
		this.filtered = this.rows;

		this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Tasks (${tasks.length})`)), 1, 0));
		this.addChild(new Spacer(1));
		this.search.onSubmit = () => this.choose();
		this.addChild(this.search);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				[
					keyHint("tui.select.confirm", "open"),
					rawKeyHint(Key.ctrl("d"), "delete"),
					keyHint("tui.select.cancel", "close"),
				].join(theme.fg("dim", " • ")),
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		this.renderList();
	}

	get focused(): boolean {
		return this.focus;
	}

	set focused(value: boolean) {
		this.focus = value;
		this.search.focused = value;
	}

	private renderList(): void {
		this.list.clear();
		if (this.filtered.length === 0) {
			this.list.addChild(new Text(this.theme.fg("muted", "  no matching task"), 0, 0));
			return;
		}
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
		);
		const end = Math.min(start + MAX_VISIBLE, this.filtered.length);
		for (let index = start; index < end; index += 1) {
			const row = this.filtered[index]!;
			const isSelected = index === this.selected;
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const label = this.theme.fg(isSelected ? "accent" : "text", row.label);
			const detail = row.detail ? this.theme.fg("muted", ` · ${row.detail}`) : "";
			this.list.addChild(new Text(`${prefix}${label}${detail}`, 0, 0));
		}
		if (start > 0 || end < this.filtered.length) {
			this.list.addChild(
				new Text(this.theme.fg("dim", `  (${this.selected + 1}/${this.filtered.length})`), 0, 0),
			);
		}
	}

	private applyFilter(): void {
		this.filtered = fuzzyFilter(this.rows, this.search.getValue(), (row) => `${row.label} ${row.detail}`);
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
		this.renderList();
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selected = (this.selected + delta + this.filtered.length) % this.filtered.length;
		this.renderList();
	}

	private choose(): void {
		const row = this.filtered[this.selected];
		if (!row) return;
		this.done(row.slug === undefined ? { kind: "new" } : { kind: "open", slug: row.slug });
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) return this.move(-1);
		if (this.keybindings.matches(data, "tui.select.down")) return this.move(1);
		if (this.keybindings.matches(data, "tui.select.confirm")) return this.choose();
		if (this.keybindings.matches(data, "tui.select.cancel")) return this.done(undefined);
		if (matchesKey(data, Key.ctrl("d"))) {
			const row = this.filtered[this.selected];
			if (row?.slug) this.done({ kind: "delete", slug: row.slug });
			return;
		}
		this.search.handleInput(data);
		this.applyFilter();
		this.tui.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.renderList();
	}
}

export function pickTask(ctx: ExtensionContext, tasks: Task[]): Promise<PickerChoice | undefined> {
	return ctx.ui.custom<PickerChoice | undefined>((tui, theme, keybindings, done) =>
		new TaskPicker(tui, theme, keybindings, tasks, done)
	);
}
