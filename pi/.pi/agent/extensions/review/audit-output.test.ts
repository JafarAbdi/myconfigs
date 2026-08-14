import assert from "node:assert/strict";
import { test } from "node:test";
import { RESULT_TOOL_ENV } from "../subagent/runtimes.ts";
import type { AuditFinding } from "./audit.ts";
import {
	AUDIT_RESULT_TOOL,
	FINDINGS_SCHEMA,
	isAuditResultChild,
	registerAuditResultTool,
} from "./audit-output.ts";

interface AuditResultToolParams {
	findings: Array<Omit<AuditFinding, "category">>;
}

interface RegisteredTool {
	name: string;
	parameters: unknown;
	constrainedSampling?: unknown;
	execute(toolCallId: string, params: AuditResultToolParams): Promise<{
		content: unknown[];
		details: unknown;
		terminate?: boolean;
	}>;
}

test("audit child registration exposes one strict terminating result tool", async () => {
	let registered: RegisteredTool | undefined;
	// SAFETY: registerAuditResultTool only calls pi.registerTool; the fake below implements no other ExtensionAPI member.
	registerAuditResultTool({
		registerTool(tool: RegisteredTool) {
			registered = tool;
		},
	} as Parameters<typeof registerAuditResultTool>[0]);

	assert.ok(registered);
	assert.equal(registered.name, AUDIT_RESULT_TOOL);
	assert.deepEqual(registered.parameters, FINDINGS_SCHEMA);
	assert.deepEqual(registered.constrainedSampling, { type: "json_schema", strict: "require" });
	const details = { findings: [] };
	const result = await registered.execute("call-id", details);
	assert.equal(result.terminate, true);
	assert.equal(result.details, details);
});

test("audit result mode is enabled only by the exact child marker", () => {
	const previous = process.env[RESULT_TOOL_ENV];
	try {
		delete process.env[RESULT_TOOL_ENV];
		assert.equal(isAuditResultChild(), false);
		process.env[RESULT_TOOL_ENV] = "other_result";
		assert.equal(isAuditResultChild(), false);
		process.env[RESULT_TOOL_ENV] = AUDIT_RESULT_TOOL;
		assert.equal(isAuditResultChild(), true);
	} finally {
		if (previous === undefined) delete process.env[RESULT_TOOL_ENV];
		else process.env[RESULT_TOOL_ENV] = previous;
	}
});
