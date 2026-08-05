import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESULT_TOOL_ENV } from "../subagent/runtimes.ts";

export const AUDIT_RESULT_TOOL = "review_audit_result";
export const MAX_AUDIT_FINDINGS = 500;
export const MAX_PATH_LENGTH = 4_096;
export const MAX_MESSAGE_LENGTH = 240;

export const FINDINGS_SCHEMA = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			maxItems: MAX_AUDIT_FINDINGS,
			items: {
				type: "object",
				properties: {
					filePath: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
					side: { type: "string", enum: ["additions", "deletions"] },
					line: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
					message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
				},
				required: ["filePath", "side", "line", "message"],
				additionalProperties: false,
			},
		},
	},
	required: ["findings"],
	additionalProperties: false,
} as const;

export function isAuditResultChild(): boolean {
	return process.env[RESULT_TOOL_ENV] === AUDIT_RESULT_TOOL;
}

export function registerAuditResultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: AUDIT_RESULT_TOOL,
		label: "Submit audit",
		description: "Submit the complete final audit findings exactly once as the final action.",
		promptSnippet: "Submit final audit findings as strict structured output",
		promptGuidelines: [`Use ${AUDIT_RESULT_TOOL} exactly once as your final action; do not return final prose.`],
		parameters: FINDINGS_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "require" },
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Audit findings submitted." }],
				details: params,
				terminate: true,
			};
		},
	});
}
