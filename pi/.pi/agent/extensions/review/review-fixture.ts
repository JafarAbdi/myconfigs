import { readFileSync } from "node:fs";
import type { AuditFinding } from "./audit.ts";
import { reviewPatchFromText, type ReviewPatch } from "./review-git.ts";

export const DEMO_REPOSITORY_ROOT = "/repository";
export const DEMO_HEAD_OID = "2222222222222222222222222222222222222222";

export function demoReviewPatch(): ReviewPatch {
	return reviewPatchFromText(
		readFileSync(new URL("./review-fixture.patch", import.meta.url), "utf8"),
		DEMO_REPOSITORY_ROOT,
		DEMO_HEAD_OID,
	);
}

export function demoAuditFinding(
	overrides: Partial<AuditFinding> = {},
): AuditFinding {
	return {
		category: "correctness",
		filePath: "src/greeting.ts",
		side: "additions",
		line: 2,
		summary: "Whitespace-only names now take a new fallback path.",
		evidence: "The staged line replaces the supplied name after trimming it.",
		failure: "Callers may receive a greeting for a different audience than intended.",
		repair: "Confirm the fallback requirement or remove the fallback.",
		...overrides,
	};
}
