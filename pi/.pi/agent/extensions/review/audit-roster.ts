export const AUDIT_CATEGORIES = [
	"contract",
	"correctness",
	"test-integrity",
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
		name: "contract",
		category: "contract",
		model: "openai-codex/gpt-5.6-terra",
		thinking: "high",
		effort: undefined,
		lens: "Find material violations of the requirement, repository rules, or one invariant applied inconsistently. Do not invent intent or report preferences.",
	},
	{
		name: "correctness",
		category: "correctness",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		effort: undefined,
		lens: "Find reachable bugs caused by the patch: wrong behavior, security, data loss, races, lifetime, bounds, or error handling. Ignore hypothetical misuse.",
	},
	{
		name: "tests",
		category: "test-integrity",
		model: "claude-sonnet-5",
		thinking: undefined,
		effort: "high",
		lens: "Find tests hidden, deleted, skipped, weakened, or made behaviorally dishonest, and material behavior left unproved. Never run tests or demand blanket coverage.",
	},
	{
		name: "simplicity",
		category: "simplicity",
		model: "claude-sonnet-5",
		thinking: undefined,
		effort: "high",
		lens: "Find material complexity removable without losing required behavior, especially duplicate state or existing mechanisms not reused. Ignore unrelated cleanup.",
	},
] as const satisfies readonly AuditReviewer[];
