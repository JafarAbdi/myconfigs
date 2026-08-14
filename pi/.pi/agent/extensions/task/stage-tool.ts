/** Submit the current planning stage's Markdown artifact.
 *
 * The model supplies prose, never a path. The active stage marker chooses the one file this tool
 * may replace, which keeps planning sessions free of general-purpose file mutation tools.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { SUBMIT_STAGE_TOOL } from "./task-tools.ts";
import { artifactPath, submitArtifact, type Stage, type TaskRef } from "./tasks.ts";

const SUBMIT_STAGE_SCHEMA = Type.Object({
	content: Type.String({
		minLength: 1,
		description: "The complete Markdown document. This replaces the current stage artifact.",
	}),
}, { additionalProperties: false });

type SubmitStageParameters = Static<typeof SUBMIT_STAGE_SCHEMA>;

const ARTIFACT_STAGE_SCHEMA = Type.Union([
	Type.Literal("questions"),
	Type.Literal("research"),
	Type.Literal("design"),
]);

const SUBMIT_STAGE_DETAILS_SCHEMA = Type.Object({
	stage: ARTIFACT_STAGE_SCHEMA,
	file: Type.String(),
}, { additionalProperties: false });

type SubmitStageDetails = Static<typeof SUBMIT_STAGE_DETAILS_SCHEMA>;

interface Submission {
	task: TaskRef;
	stage: Stage;
}

export interface SubmitStageToolDependencies {
	/** Resolve the task and stage from the current session marker. */
	resolve(ctx: ExtensionContext): Submission;
}

export function registerSubmitStageTool(pi: ExtensionAPI, dependencies: SubmitStageToolDependencies): void {
	pi.registerTool({
		name: SUBMIT_STAGE_TOOL,
		label: "Submit Stage",
		description:
			"Save the complete Markdown artifact for the current questions, research, or design stage. " +
			"The active stage chooses the destination; no path is accepted. Replaces an existing artifact.",
		promptSnippet: "Submit the current planning stage's final Markdown artifact",
		parameters: SUBMIT_STAGE_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(SUBMIT_STAGE_TOOL)), 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const { details } = result;
			const output = result.content.find((item) => item.type === "text")?.text ?? "submission failed";
			if (context.isError || !Check(SUBMIT_STAGE_DETAILS_SCHEMA, details)) {
				return new Text(theme.fg("error", output), 0, 0);
			}

			const content = Check(SUBMIT_STAGE_SCHEMA, context.args) ? context.args.content : "";
			let text = theme.fg("muted", `${details.stage} submitted`);
			if (!content) return new Text(text, 0, 0);
			if (!expanded) text += theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`);
			else text += `\n${theme.fg("dim", details.file)}\n\n${content}`;
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, parameters: SubmitStageParameters, _signal, _onUpdate, ctx) {
			const { task, stage } = dependencies.resolve(ctx);
			if (!Check(ARTIFACT_STAGE_SCHEMA, stage)) {
				throw new Error(`the ${stage} stage has no Markdown artifact; use the phase tool instead`);
			}
			const file = artifactPath(task, stage);
			await withFileMutationQueue(file, async () => submitArtifact(task, stage, parameters.content));
			return {
				content: [{ type: "text", text: `saved ${file}` }],
				details: { stage, file } satisfies SubmitStageDetails,
			};
		},
	});
}
