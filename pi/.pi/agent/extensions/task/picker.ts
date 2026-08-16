import {
	DynamicBorder,
	type ExtensionContext,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	type KeybindingsManager,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { taskProgress, type Task } from "./tasks.ts";

const MAX_VISIBLE = 10;

export type TaskPickerChoice =
	| { kind: "open"; slug: string }
	| { kind: "delete"; slug: string };

export function taskLabel(task: Task): string {
	const progress = taskProgress(task);
	const suffix = progress.done === progress.total ? " complete" : "";
	return `${task.slug} · ${progress.done}/${progress.total}${suffix}`;
}

class TaskPicker extends Container implements Focusable {
	private readonly search = new Input();
	private readonly list: SelectList;
	private focus = false;

	constructor(
		private readonly tui: TUI,
		theme: Theme,
		private readonly keybindings: KeybindingsManager,
		tasks: readonly Task[],
		private readonly done: (choice: TaskPickerChoice | undefined) => void,
	) {
		super();
		const items = tasks.map((task) => ({ value: task.slug, label: taskLabel(task) }));
		this.list = new SelectList(items, Math.min(items.length, MAX_VISIBLE), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: () => theme.fg("muted", "  No matching tasks"),
		});
		this.list.onSelect = (item) => this.done({ kind: "open", slug: item.value });
		this.list.onCancel = () => this.done(undefined);

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Tasks (${tasks.length})`)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.search);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text([
			keyHint("tui.select.confirm", "open"),
			keyHint("app.session.delete", "delete"),
			keyHint("tui.select.cancel", "close"),
		].join(theme.fg("dim", " · ")), 1, 0));
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}

	get focused(): boolean {
		return this.focus;
	}

	set focused(value: boolean) {
		this.focus = value;
		this.search.focused = value;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.session.delete")) {
			const selected = this.list.getSelectedItem();
			if (selected) this.done({ kind: "delete", slug: selected.value });
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.up") ||
			this.keybindings.matches(data, "tui.select.down") ||
			this.keybindings.matches(data, "tui.select.confirm") ||
			this.keybindings.matches(data, "tui.select.cancel")
		) {
			this.list.handleInput(data);
		} else {
			this.search.handleInput(data);
			this.list.setFilter(this.search.getValue());
		}
		this.tui.requestRender();
	}
}

export async function pickTask(
	ctx: ExtensionContext,
	tasks: readonly Task[],
): Promise<TaskPickerChoice | undefined> {
	if (tasks.length === 0) {
		ctx.ui.notify("No tasks. Create one with /task <plan-file>.", "info");
		return undefined;
	}
	return ctx.ui.custom<TaskPickerChoice | undefined>((tui, theme, keybindings, done) =>
		new TaskPicker(tui, theme, keybindings, tasks, done)
	);
}
