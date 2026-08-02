import { readFileSync } from "node:fs";
import { reviewPatchFromText, type ReviewPatch } from "./review-git.ts";
import type { AgentAnnotation } from "./review-state.ts";

export const DEMO_BASE_OID = "1111111111111111111111111111111111111111";
export const DEMO_HEAD_OID = "2222222222222222222222222222222222222222";

export const DEMO_AGENT_ANNOTATIONS: readonly AgentAnnotation[] = [
	{
		filePath: "src/greeting.ts",
		side: "additions",
		line: 2,
		source: "Demo correctness reviewer",
		summary: "Whitespace-only names now receive a readable fallback.",
		rationale: "Advisory context only; the operator decides whether any correction is needed.",
	},
];

export function demoReviewPatch(): ReviewPatch {
	return reviewPatchFromText(
		readFileSync(new URL("./review-fixture.patch", import.meta.url), "utf8"),
		DEMO_BASE_OID,
		DEMO_HEAD_OID,
	);
}
