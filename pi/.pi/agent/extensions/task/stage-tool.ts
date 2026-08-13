/** Submit the current planning stage's Markdown artifact.
 *
 * The model supplies prose, never a path. The active stage marker chooses the one file this tool
 * may replace, which keeps planning sessions free of general-purpose file mutation tools.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { SUBMIT_STAGE_TOOL } from "./task-tools.ts";
import { artifactPath, submitArtifact, type Stage, type TaskRef } from "./tasks.ts";

const SUBMIT_STAGE_SCHEMA = Type.Object({
	content: Type.String({
		minLength: 1,
		description: "The complete Markdown document. This replaces the current stage artifact.",
	}),
}, { additionalProperties: false });

type SubmitStageParameters = Static<typeof SUBMIT_STAGE_SCHEMA>;

interface Submission {
	task: TaskRef;
	stage: Stage;
}

interface SubmitStageDetails {
	stage: Stage;
	file: string;
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

		renderResult(result, _options, theme) {
			const details = result.details as SubmitStageDetails | undefined;
			const text = details ? `${details.stage} submitted` : "submission failed";
			return new Text(theme.fg(details ? "muted" : "error", text), 0, 0);
		},

		async execute(_toolCallId, parameters: SubmitStageParameters, _signal, _onUpdate, ctx) {
			const { task, stage } = dependencies.resolve(ctx);
			const file = artifactPath(task, stage);
			await withFileMutationQueue(file, async () => submitArtifact(task, stage, parameters.content));
			return {
				content: [{ type: "text", text: `saved ${file}` }],
				details: { stage, file } satisfies SubmitStageDetails,
			};
		},
	});
}
