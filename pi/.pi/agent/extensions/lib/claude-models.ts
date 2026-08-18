/**
 * Canonical claude model list — the single source both the claude-provider (which layers on
 * contextWindow/maxTokens for pi's model catalog) and the subagent's `selectRuntime` (which builds
 * a name Set to route native-claude delegations) build from. Adding or removing a model here keeps
 * both in sync; a model in one but not the other would silently misroute.
 *
 * contextWindow/maxTokens are from the model catalog and drive pi's context indicator + compaction.
 */
export interface ClaudeModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
}

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
	{ id: "claude-opus-5", name: "Claude Opus 5 (CLI)", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-fable-5", name: "Claude Fable 5 (CLI)", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8 (CLI)", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7 (CLI)", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (CLI)", contextWindow: 1_000_000, maxTokens: 64_000 },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6 (CLI)", contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5 (CLI)", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (CLI)", contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (CLI)", contextWindow: 200_000, maxTokens: 64_000 },
];

/** Exact model ids, for the subagent's runtime-selection Set. */
export const CLAUDE_MODEL_IDS: readonly string[] = CLAUDE_MODELS.map((model) => model.id);
