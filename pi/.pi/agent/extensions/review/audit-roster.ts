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
		lens: "Find changed behavior that contradicts an explicit requirement or repository rule and is not ordinary correctness. Do not invent intent or enforce unstated mechanisms.",
	},
	{
		name: "correctness",
		category: "correctness",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		effort: undefined,
		lens: "Find production-breaking behavior caused by the patch under a valid input, call path, or state transition. Security auditing is out of scope unless explicitly requested.",
	},
	{
		name: "tests",
		category: "test-integrity",
		model: "claude-sonnet-5",
		thinking: undefined,
		effort: "high",
		lens: "Find tests changed to hide, delete, skip, weaken, or misrepresent behavior. Report missing coverage only for a concrete defect demonstrated from the patch. Never run tests.",
	},
	{
		name: "simplicity",
		category: "simplicity",
		model: "claude-sonnet-5",
		thinking: undefined,
		effort: "high",
		lens: "Find complexity introduced by the patch that existing code or a smaller design removes without losing required behavior. Ignore future-proofing and unrelated cleanup.",
	},
] as const satisfies readonly AuditReviewer[];
