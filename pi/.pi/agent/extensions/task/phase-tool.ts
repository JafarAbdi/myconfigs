/**
 * The `phase` tool — the only way a model changes the plan's structure.
 *
 * It lets the planning conversation change structure without hand-editing JSON: every change
 * arrives as validated arguments, and an invalid one is a tool error the model sees and corrects.
 * It is registered unconditionally so its availability never depends on an in-memory mode. The
 * implementer receives the phase prose directly and is not granted this tool; the operator records
 * completion after reading its report.
 *
 * Rendering stays compact until the operator asks to see the persisted call-time detail.
 */

import { type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { PHASE_TOOL } from "./task-tools.ts";
import {
	createPhase,
	MAX_TITLE_LENGTH,
	setPhaseStatus,
	taskProgress,
	type Task,
} from "./tasks.ts";

const MAX_BODY_LENGTH = 32_000;

const PHASE_ACTION_SCHEMA = Type.Union([
	Type.Literal("list"),
	Type.Literal("show"),
	Type.Literal("create"),
	Type.Literal("set-status"),
]);
const PHASE_NAME_SCHEMA = Type.String({ minLength: 1 });
const PHASE_STATUS_SCHEMA = Type.Union([Type.Literal("open"), Type.Literal("done")]);

const PHASE_SCHEMA = Type.Object({
	action: PHASE_ACTION_SCHEMA,
	name: Type.Union([
		// Created slugs are validated by createPhase; existing names include their numeric prefix.
		PHASE_NAME_SCHEMA,
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
	status: Type.Union([PHASE_STATUS_SCHEMA, Type.Null()], {
		description: "set-status only, null otherwise.",
	}),
	// Every property is required and nullable rather than optional: strict JSON-schema sampling
	// admits no optional property, so this is how a per-action argument is expressed — the same
	// shape as `review/review-intent.ts:56-71`. `additionalProperties: false` is required with it.
}, { additionalProperties: false });

type PhaseToolParameters = Static<typeof PHASE_SCHEMA>;

const PHASE_DETAILS_SCHEMA = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		done: Type.Integer({ minimum: 0 }),
		total: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("show"), name: PHASE_NAME_SCHEMA }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("create"), name: PHASE_NAME_SCHEMA }, { additionalProperties: false }),
	Type.Object({
		action: Type.Literal("set-status"),
		name: PHASE_NAME_SCHEMA,
		status: PHASE_STATUS_SCHEMA,
	}, { additionalProperties: false }),
]);

type PhaseToolDetails = Static<typeof PHASE_DETAILS_SCHEMA>;

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
			const action = Check(PHASE_ACTION_SCHEMA, args.action) ? args.action : "…";
			const name = Check(PHASE_NAME_SCHEMA, args.name) ? ` ${args.name}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("phase")) + theme.fg("dim", ` ${action}${name}`), 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const output = result.content.find((item) => item.type === "text")?.text ?? "phase failed";
			if (context.isError || !Check(PHASE_DETAILS_SCHEMA, result.details)) {
				return new Text(theme.fg("error", output), 0, 0);
			}

			const { details } = result;
			let detail = "";
			if (details.action === "list" || details.action === "show") detail = output;
			if (details.action === "create" && Check(PHASE_SCHEMA, context.args) && context.args.action === "create") {
				const title = context.args.title ?? "";
				const body = context.args.body ?? "";
				detail = title + (body ? `\n\n${body}` : "");
			}

			let text = theme.fg("muted", summary(details));
			if (!detail) return new Text(text, 0, 0);
			if (!expanded) text += theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`);
			else text += `\n${detail}`;
			return new Text(text, 0, 0);
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
