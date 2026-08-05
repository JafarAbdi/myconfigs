export const AUDIT_CATEGORIES = [
	"intent",
	"correctness",
	"test-integrity",
	"coherence",
	"context",
	"simplicity",
] as const;

export type AuditCategory = typeof AUDIT_CATEGORIES[number];

export interface AuditReviewer {
	name: string;
	category: AuditCategory;
	model: string;
	lens: string;
	thinking?: "high";
	effort?: "high";
}

export const AUDIT_ROSTER = [
	{
		name: "intent",
		category: "intent",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		effort: undefined,
		lens: "Check the candidate patch against the supplied requirement's required behavior, exclusions, and candidate boundary. When no requirement is supplied, do not invent product intent; report only an unmistakable contradiction with intent established by the changed code and governing context.",
	},
	{
		name: "correctness",
		category: "correctness",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		effort: undefined,
		lens: "Find reachable behavioral, security, data-loss, timing, lifetime, bounds, and error-handling defects caused by the patch. Trace the smallest amount of nearby code needed to prove the failure path, and do not report hypothetical misuse without a reachable caller.",
	},
	{
		name: "tests",
		category: "test-integrity",
		model: "claude-sonnet-5",
		thinking: undefined,
		effort: "high",
		lens: "Statically review test honesty and integrity; never execute tests. Look for deleted or skipped tests, weakened assertions, fixtures or mocks that bypass real behavior, discovery or configuration changes that hide tests, behavioral inequivalence, and material claims lacking the proof required by the change. Do not demand blanket coverage or tests for changes that do not materially need them.",
	},
	{
		name: "coherence",
		category: "coherence",
		model: "openai-codex/gpt-5.6-terra",
		thinking: "high",
		effort: undefined,
		lens: "Detect split-brain or duplicate designs, uneven implementation of one invariant, temporary shortcuts left in the final path, and unjustified concentration of responsibilities introduced by the patch. Report only concrete inconsistencies with a material maintenance or behavioral consequence.",
	},
	{
		name: "context",
		category: "context",
		model: "openai-codex/gpt-5.6-luna",
		thinking: "high",
		effort: undefined,
		lens: "Apply the exact governing repository instructions and established local invariants to the candidate patch. Read nearby context only when needed to establish those facts, and distinguish an actual violated convention from a personal preference.",
	},
	{
		name: "simplicity",
		category: "simplicity",
		model: "claude-sonnet-5",
		thinking: undefined,
		effort: "high",
		lens: "Look for material complexity that the requirement does not justify and that deletion or an existing local mechanism would remove. Do not penalize necessary core changes merely because they touch core code, and do not propose broad cleanup unrelated to the candidate behavior.",
	},
] as const satisfies readonly AuditReviewer[];
