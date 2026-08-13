/**
 * The `phase` tool — the only way a model changes the plan's structure.
 *
 * It lets the planning conversation change structure without hand-editing JSON: every change
 * arrives as validated arguments, and an invalid one is a tool error the model sees and corrects.
 * It is registered unconditionally so its availability never depends on an in-memory mode. The
 * implementer receives the phase prose directly and is not granted this tool; the operator records
 * completion after reading its report.
 *
 * Rendering is deliberately one line. The point of a tool over a file edit is exposure, not screen.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { PHASE_TOOL } from "./task-tools.ts";
import {
	createPhase,
	MAX_TITLE_LENGTH,
	setPhaseStatus,
	taskProgress,
	type PhaseStatus,
	type Task,
} from "./tasks.ts";

const MAX_BODY_LENGTH = 32_000;

const PHASE_SCHEMA = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("show"),
		Type.Literal("create"),
		Type.Literal("set-status"),
	]),
	name: Type.Union([
		// Created slugs are validated by createPhase; existing names include their numeric prefix.
		Type.String({ minLength: 1 }),
		Type.Null(),
	], {
		description:
			"Lower-case kebab-case identifier; null for list. For create it names the new phase; for " +
			"show and set-status it is the existing name exactly as list reports it, number included.",
	}),
	title: Type.Union([Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH }), Type.Null()], {
		description: "Short prose title; create only, null otherwise.",
	}),
	body: Type.Union([Type.String({ maxLength: MAX_BODY_LENGTH }), Type.Null()], {
		description:
			"The phase itself: what it accomplishes, the concrete per-file changes, and how to verify " +
			"it. Plain, concise Markdown; use the smallest diagram or diff only when clearer than prose. " +
			"This is what the implementer reads. Create only, null otherwise.",
	}),
	status: Type.Union([Type.Literal("open"), Type.Literal("done"), Type.Null()], {
		description: "set-status only, null otherwise.",
	}),
	// Every property is required and nullable rather than optional: strict JSON-schema sampling
	// admits no optional property, so this is how a per-action argument is expressed — the same
	// shape as `review/review-intent.ts:56-71`. `additionalProperties: false` is required with it.
}, { additionalProperties: false });

type PhaseToolParameters = Static<typeof PHASE_SCHEMA>;

type PhaseToolDetails =
	| { action: "list"; done: number; total: number }
	| { action: "show"; name: string }
	| { action: "create"; name: string }
	| { action: "set-status"; name: string; status: PhaseStatus };

function isDetails(value: unknown): value is PhaseToolDetails {
	return typeof value === "object" && value !== null && "action" in value;
}

function summary(details: PhaseToolDetails): string {
	if (details.action === "list") return `phase list · ${details.done}/${details.total} done`;
	if (details.action === "show") return `phase ${details.name}`;
	if (details.action === "create") return `phase ${details.name} created`;
	return `phase ${details.name} → ${details.status}`;
}

export interface PhaseToolDependencies {
	/** The task this session drives, resolved from its branch or stage marker. Throws when absent. */
	resolveTask(ctx: ExtensionContext): Task;
}

export function registerPhaseTool(pi: ExtensionAPI, dependencies: PhaseToolDependencies): void {
	pi.registerTool({
		name: PHASE_TOOL,
		label: "Phase",
		description:
			"Read and change the phases of the current task. `list` reports every phase with its " +
			"status, `show` returns one phase in full, `create` appends one phase, and `set-status` " +
			"marks a phase open or done. The phases are the plan's state — nothing else records it.",
		promptSnippet: "List, create, and complete the phases of the current task",
		parameters: PHASE_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },

		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "…";
			const name = typeof args.name === "string" ? ` ${args.name}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("phase")) + theme.fg("dim", ` ${action}${name}`), 0, 0);
		},

		renderResult(result, _options, theme) {
			if (!isDetails(result.details)) {
				const first = result.content[0];
				return new Text(theme.fg("error", first?.type === "text" ? first.text : "phase failed"), 0, 0);
			}
			return new Text(theme.fg("muted", summary(result.details)), 0, 0);
		},

		async execute(_toolCallId, parameters: PhaseToolParameters, _signal, _onUpdate, ctx) {
			const task = dependencies.resolveTask(ctx);

			if (parameters.action === "list") {
				const { done, total } = taskProgress(task);
				const lines = task.phases.map((phase) => `${phase.name}\t${phase.status}\t${phase.title}`);
				return {
					content: [{ type: "text", text: lines.join("\n") || "no phases yet" }],
					details: { action: "list", done, total } satisfies PhaseToolDetails,
				};
			}

			if (parameters.action === "show") {
				const { name } = parameters;
				if (!name) throw new Error("show requires name");
				const phase = task.phases.find((candidate) => candidate.name === name);
				if (!phase) {
					const known = task.phases.map((candidate) => candidate.name).join(", ") || "none";
					throw new Error(`unknown phase ${name}; phases are: ${known}`);
				}
				return {
					content: [{ type: "text", text: `${phase.name} — ${phase.title} (${phase.status})\n\n${phase.body}` }],
					details: { action: "show", name: phase.name } satisfies PhaseToolDetails,
				};
			}

			if (parameters.action === "create") {
				const { name, title, body } = parameters;
				if (!name || !title) throw new Error("create requires name and title");
				const phase = createPhase(task, name, title, body ?? "");
				return {
					content: [{ type: "text", text: `created ${phase.name}` }],
					details: { action: "create", name: phase.name } satisfies PhaseToolDetails,
				};
			}

			const { name, status } = parameters;
			if (!name || !status) throw new Error("set-status requires name and status");
			const phase = setPhaseStatus(task, name, status);
			return {
				content: [{ type: "text", text: `${phase.name} is ${status}` }],
				details: { action: "set-status", name: phase.name, status } satisfies PhaseToolDetails,
			};
		},
	});
}
