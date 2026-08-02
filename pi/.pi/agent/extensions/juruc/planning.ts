import { readFileSync } from "node:fs";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type {
	CandidatePhase,
	PlanCandidate,
	PlanEnvelope,
	PlanDecision,
	PlanRisk,
	WorktreeSnapshot,
} from "./plan.ts";

export const PLANNING_INSTRUCTION = `Plan under the canonical /grill prompt using the working directory and context paths in JURUC planning context.

Read task research.md first as non-authoritative evidence; plan.json remains authoritative. Do not invent missing facts.

Classify confirmed material as task-specific or durable project context. Before /grill's single final confirmation, show each durable change's exact target path and exact entries under Objective, Requirements, Invariants, Constraints, Assumptions, and Non-Goals, or state "Durable project context: None." Use the narrowest governing existing file; reserve Git-root AGENTS.md for project-wide rules. New AGENTS.md files use JURUC's # Project Contract format; preserve an existing context file's format.

Before the single final confirmation, present decisions with rationale and alternatives, assumptions, accepted risks with consequence and mitigation, deferred non-goals, and every blocker with its disposition (resolved, assumed, accepted as risk, deferred, or blocking). Keep blockers out of the persisted plan; an unresolved blocker means /grill must not call juruc_set_plan. Represent every confirmed context edit in the earliest affected phase's exact success criteria, or a minimal context-only phase. Only after human confirmation, call juruc_set_plan with the complete ordered future plan. Phases must be minimal, incrementally complete, independently verifiable after their predecessors, include relevant tests, and not depend on later phases for validity.`;

export const RESEARCH_INSTRUCTION = `Research proceeds from orientation to independent evidence to factual synthesis.

1. Give the subject to one fresh scout for lightweight repository orientation and proportional current-state questions.
2. Group questions by factual ownership. In one batch, give mutually blind evidence scouts—and researchers only for external current facts—neutral factual briefs containing only their questions and useful source, configuration, test, or library pointers. Hide the desired outcome and all request-bearing tickets, designs, and planning artifacts.
3. Give one fresh synthesizer only the questions and independent reports. Require concise facts with concrete code references, verified external sources where used, contradictions, and visible unresolved gaps; no recommendations or plan.

Do not supply evidence inline or invent missing evidence.`;

export function planningContextMetadata(
	options: Pick<BuildSystemPromptOptions, "cwd" | "contextFiles">,
): string {
	const paths = options.contextFiles?.map(({ path }) => path) ?? [];
	return [
		"JURUC planning context supplied by Pi:",
		`Working directory: ${options.cwd}`,
		paths.length
			? `Applicable context files (contents already loaded by Pi):\n${paths.map((path) => `- ${path}`).join("\n")}`
			: "Applicable context files: None. Pi discovered no AGENTS.md or CLAUDE.md files.",
		"These are the only applicable context-file paths.",
	].join("\n");
}

export function researchKickoff(subject: string): string {
	return subject;
}

interface PhaseInputContent {
	title: string;
	objective: string;
	successCriteria: string[];
	hints?: string[];
}

export interface SetPlanInput {
	objective: string;
	desiredEndState: string;
	constraints: string[];
	assumptions: string[];
	nonGoals: string[];
	decisions: PlanDecision[];
	risks: PlanRisk[];
	successCriteria: string[];
	futurePhases: PhaseInputContent[];
}

const text = { type: "string", minLength: 1 } as const;
const textList = { type: "array", items: text } as const;

export const SET_PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"objective",
		"desiredEndState",
		"constraints",
		"assumptions",
		"nonGoals",
		"decisions",
		"risks",
		"successCriteria",
		"futurePhases",
	],
	properties: {
		objective: text,
		desiredEndState: text,
		constraints: textList,
		assumptions: textList,
		nonGoals: textList,
		decisions: {
			type: "array",
			items: { type: "object", additionalProperties: false, required: ["decision", "rationale", "alternatives"], properties: { decision: text, rationale: text, alternatives: textList } },
		},
		risks: {
			type: "array",
			items: { type: "object", additionalProperties: false, required: ["risk", "consequence", "mitigation"], properties: { risk: text, consequence: text, mitigation: text } },
		},
		successCriteria: { ...textList, minItems: 1 },
		futurePhases: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["title", "objective", "successCriteria"],
				properties: {
					title: text,
					objective: text,
					successCriteria: { ...textList, minItems: 1 },
					hints: textList,
				},
			},
		},
	},
} as const;

export function candidateFromInput(
	input: SetPlanInput,
	envelope: PlanEnvelope,
	worktreeSnapshot: WorktreeSnapshot,
	activeWorkDisposition: "carry" | "discard" | null,
): PlanCandidate {
	if (input.futurePhases.length === 0)
		throw new Error("a plan candidate requires at least one future phase");
	const pending = envelope.approved?.future ?? [];
	const matched = new Set<string>();
	const future: CandidatePhase[] = input.futurePhases.map((phase) => {
		const content = {
			title: phase.title,
			objective: phase.objective,
			successCriteria: [...phase.successCriteria],
			hints: [...(phase.hints ?? [])],
		};
		const retained = pending.find(
			(stored) =>
				!matched.has(stored.id) &&
				stored.title === content.title &&
				stored.objective === content.objective &&
				stored.successCriteria.length === content.successCriteria.length &&
				stored.successCriteria.every(
					(criterion, index) => criterion === content.successCriteria[index],
				) &&
				stored.hints.length === content.hints.length &&
				stored.hints.every((hint, index) => hint === content.hints[index]),
		);
		if (retained) matched.add(retained.id);
		return {
			...(retained ? { id: retained.id } : {}),
			...content,
			amendments: retained ? [...retained.amendments] : [],
		};
	});

	const dirty = worktreeSnapshot.paths.length > 0;
	if (dirty && activeWorkDisposition === null)
		throw new Error("dirty work requires activeWorkDisposition carry or discard");
	if (!dirty && activeWorkDisposition !== null)
		throw new Error("clean work requires null activeWorkDisposition");
	return {
		expectedRevision: envelope.revision,
		objective: input.objective,
		desiredEndState: input.desiredEndState,
		constraints: [...input.constraints],
		assumptions: [...input.assumptions],
		nonGoals: [...input.nonGoals],
		decisions: input.decisions.map(({ decision, rationale, alternatives }) => ({ decision, rationale, alternatives: [...alternatives] })),
		risks: input.risks.map(({ risk, consequence, mitigation }) => ({ risk, consequence, mitigation })),
		successCriteria: [...input.successCriteria],
		future,
		worktreeSnapshot: {
			head: worktreeSnapshot.head,
			paths: [...worktreeSnapshot.paths],
			tree: worktreeSnapshot.tree,
		},
		activeWorkDisposition,
	};
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (const character of argsString) {
		if (quote) {
			if (character === quote) quote = null;
			else current += character;
		} else if (character === "'" || character === '"') quote = character;
		else if (/\s/u.test(character)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else current += character;
	}
	if (current) args.push(current);
	return args;
}

export function expandPromptArguments(content: string, argsString: string): string {
	const args = parseCommandArgs(argsString);
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS"
						? allArgs
						: args[Number(defaultTarget) - 1];
				return value || defaultValue;
			}
			if (sliceStart) {
				const start = Math.max(0, Number(sliceStart) - 1);
				return args
					.slice(start, sliceLength ? start + Number(sliceLength) : undefined)
					.join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number(simple) - 1] ?? "";
		},
	);
}

function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---")) return normalized;
	const end = normalized.indexOf("\n---", 3);
	return end < 0 ? normalized : normalized.slice(end + 4).trim();
}

interface PromptCommand {
	name: string;
	source: string;
	sourceInfo: { path: string };
}

export function canonicalPrompt(
	commands: readonly PromptCommand[],
	name: string,
	argsString: string,
): string {
	const matches = commands.filter(
		(command) => command.name === name && command.source === "prompt",
	);
	if (matches.length !== 1)
		throw new Error(`the canonical /${name} prompt is unavailable or ambiguous`);
	const body = stripFrontmatter(
		readFileSync(matches[0].sourceInfo.path, "utf8"),
	);
	const expanded = expandPromptArguments(body, argsString);
	if (!expanded.trim()) throw new Error(`the canonical /${name} prompt is empty`);
	return expanded;
}
