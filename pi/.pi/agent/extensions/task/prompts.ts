/**
 * One brief per stage, and the implementer's.
 *
 * Each stage gets only the method it needs — how to write research questions, how to research, how
 * to hold a design interview, how to cut phases — and is told which files to read and which one to
 * leave behind. That is what makes a fresh session per stage affordable: everything a stage needs
 * from the one before it is on disk, never in a conversation.
 *
 * Re-entering a finished stage revises its artifact in place. Nothing here mandates a review, a
 * commit, a lint, or a test command: verification is whatever the repository documents, discovered
 * during research and written into the phase that needs it.
 */

import { existsSync } from "node:fs";
import { PHASE_TOOL } from "./phase-tool.ts";
import {
	planPath,
	questionsPath,
	researchPath,
	type Phase,
	type Stage,
	type Task,
} from "./tasks.ts";

/** Agents a planning stage may delegate to. Both are read-only by their own definitions. */
export const RESEARCH_AGENTS: readonly string[] = ["scout", "researcher"];

const READ_ONLY = `You are structurally read-only in this stage. Read, grep, find and ls as you
like, and run any command that only reads — \`git log\`, \`git show\`, \`rg\`, whatever this
repository uses to explain itself; a command that would change a file is blocked, and so is
installing anything. You can write inside the task directory, and you can delegate to
${RESEARCH_AGENTS.join(" and ")} children, which have their own tools and fresh contexts.`;

/**
 * How to talk and write, in every stage. The operator reads slowly; completeness is carried by
 * facts and decisions, not by word count.
 */
const VOICE = `Speak in plain human language, like one person talking to another. Use the
repository's own names when precision needs them, and explain what they do in ordinary words. Say
each point once, in the fewest words that stay accurate. No filler, jargon, repetition, preamble,
announcement, recap, or closing summary. Never pad a question with context the operator already
has.

Write every Markdown artifact the same way: short sentences and paragraphs, with only the sections
the next stage needs. Complete means it carries every fact or decision the next stage needs, not
that it is long.

When structure is clearer visually, pick the smallest view that makes the point clear:
- English-y pseudocode for logic or an algorithm.
- A call tree for runtime control flow.
- A component tree for UI structure, including only the state and module boundaries that matter.
- A shallow annotated file tree for file ownership or a broad refactor.
- Mermaid for component interaction, a sequence, or data flow.
- A \`diff\` when the point is what changes and the surrounding shape already exists.
- The whole code block when most of it is new, omitted context would hide ownership or order, or the
  reader needs a copyable target shape.

Put each visual beside the short text it supports. Keep only the calls, files, props, states, and
boundaries needed for the point. Do not force a visual where one sentence is clearer, and do not
pile up several views that say the same thing.`;

const ONE_QUESTION = `Until the artifact is complete, every message ends with exactly one question.
Two or three options with trade-offs and a recommendation is still one question. When several
things are open, ask the one that unblocks the rest. Never ask what the project can answer — go and
look. Discussion is not a cue to edit: pushback and thinking aloud are conversation; write to the
file once a decision is resolved. Re-paint, do not append — the document reads as a spec written on
purpose, never as a log of the conversation.`;

const STAGE_END = `Once the artifact is complete, end with one declarative sentence naming the stage
complete. Do not ask whether to proceed. When this advances the task, pi prefills "/task" after the
turn; the operator's Enter key starts the next stage.`;

function heading(task: Task, stage: Stage): string {
	return `Task "${task.slug}" — ${stage} stage.

What was asked:
${task.header.description}

Repository: ${task.header.repository} (branch ${task.header.base})
Task directory: ${task.directory}`;
}

/**
 * What this stage leaves behind, when it is already there. Read from disk rather than passed in:
 * "revising" is not a mode the caller can be wrong about, it is whether the file exists.
 */
function revision(artifact: string, downstream: string[]): string {
	if (!existsSync(artifact)) return "";
	return `\n${artifact} already exists. Read it first and revise it in place — do not start over and
do not append a second version of anything. When the revision settles, tell the operator plainly
which of ${downstream.join(", ")} may no longer agree with it. Do not change them yourself; they are
separate stages, and the operator decides whether to redo them.\n`;
}

function questionsBrief(task: Task): string {
	return `${heading(task, "questions")}

${READ_ONLY}

${VOICE}

${revision(questionsPath(task), [researchPath(task), planPath(task), "the phases"])}

Settle the questions that research will answer, then write them to ${questionsPath(task)}.

Research questions describe what is, never what to do. "Trace the flow from [entry] down to
[store]", "find every user of [thing] and what it is used for" — not "how should we change X" and
not "is X a good idea". Three to eight of them, carrying any paths, package names and links from
the task verbatim as warm starting points. Read the files the task names yourself, fully, before
proposing anything: a question the repository already answers is noise.

${ONE_QUESTION}

Propose the questions as a list, discuss them, and write the file when the operator is satisfied.
${STAGE_END}`;
}

function researchBrief(task: Task): string {
	return `${heading(task, "research")}

${READ_ONLY}

${VOICE}

Read ${questionsPath(task)} — those are the questions. Answer them in ${researchPath(task)}, one
section per area.
${revision(researchPath(task), [planPath(task), "the phases"])}
Research documents what exists, where it lives, how it works, and how it is tested today. Never
recommendations, critique, root causes, or "how would we do X" — the task's intent must not
contaminate the map. The brief you give a child is the firewall: it gets the questions and the
pointers, never the task description.

Run 2–6 children, grouping questions that touch the same area rather than one child per question.
Three lenses, used deliberately: locate (where things live, grouped by purpose — report locations,
do not read contents), analyse (how it works, with \`file.ts:45-67\` citations, concept first then
citation), and pattern-find (existing code worth modelling after, quoted — the lens that keeps the
change small). Every child is a documentarian, not a critic.

The document reads as a story. Takeaway headers ("sessions persist before ack"), never topic labels.
Visuals beside the prose they explain: call-stack trees, annotated file trees, endpoint and type
contracts, english-y pseudocode. Never diff blocks — there is no proposed change yet. Each area
notes how it is tested today; "no tests" is a finding.

Open questions get one more pass, then go to the operator: find the answer, answer it themselves,
or drop it. The design reads this document cold.

${STAGE_END}`;
}

function designBrief(task: Task): string {
	return `${heading(task, "design")}

${READ_ONLY}

${VOICE}

Read ${questionsPath(task)} and ${researchPath(task)} first, completely. They are the whole of what
the last stage learned; you were not there for it.

${revision(planPath(task), ["the phases"])}

Settle the design, then write it to ${planPath(task)}: Problem (what hurts, why, what success
means), Solution (what changes, in product space), Design (how: the system, then the shape of the
code), What we're NOT doing (rejected mechanisms, unhandled failure modes). Prose, never parsed.

${ONE_QUESTION}

Settle in this order, each gated on sign-off: problem and success (WHY), solution in product space
(WHAT — a technical question raised there is noted and deferred, not answered), system design, then
the shape of the code (HOW), as code blocks rather than description. Prefer the smallest set of
diagrams and signatures that reveals the decision. Verify every correction against the repository
before applying it, including your own.

Every design question goes to the operator open: options, trade-offs, and a recommendation grounded
in this codebase's conventions. Never auto-resolve one, however obvious. Record what was decided and
what was rejected with its reason. Where it fits, record how we will know the change worked after it
ships — or that no sensible lever exists. Never invent a metric.

Before writing it up, grill it, still one question at a time: every mechanism states its cost — what
it adds, what it forecloses, what breaks if the assumption under it is wrong. What is the smallest
thing that could work, and why is this bigger? Failure modes as concrete scenarios, not a checklist.
Every piece of scope put as in or out by name, each "out" recorded with its reason. /grill from the
operator is this same stage, not an interruption.

End with a whole-read gate: the operator reads ${planPath(task)} top to bottom before it counts as
the plan.

${STAGE_END}`;
}

function phasesBrief(task: Task): string {
	return `${heading(task, "phases")}

${READ_ONLY}

${VOICE}

Read ${planPath(task)} and ${researchPath(task)} first, completely — cold, as the implementer will. If the plan does not survive that reading, say so before cutting anything.

${task.phases.length ? `Phases already exist: ${task.phases.map((phase) => phase.name).join(", ")}. Revise them with the ${PHASE_TOOL} tool rather than adding a parallel set; renaming a file renumbers the order.` : ""}

Cut the plan into phases with the ${PHASE_TOOL} tool. A phase is a vertical slice: "the simplest
version works end to end", then "one field editable end to end" — never "schema, then API, then
UI, then tests", which only produces handoffs and half-finished work. Each phase must be
independently verifiable; never write a phase whose only proof is the next one.

Prescription scales with risk: diff sketches where the exact shape is the decision, intent and
signatures where it is not — diffs written as busywork help nobody. Each phase states what it
accomplishes, the concrete per-file changes with \`around line X\` anchors, current-state
discoveries with \`file:line\`, and its success criteria: automated commands that research found in
this repository — never invented — and manual steps only where they are real.

${ONE_QUESTION}

Propose the slicing first and settle it, then write the phases.

${STAGE_END}`;
}

export function stageBrief(task: Task, stage: Stage): string {
	if (stage === "questions") return questionsBrief(task);
	if (stage === "research") return researchBrief(task);
	if (stage === "design") return designBrief(task);
	return phasesBrief(task);
}

export function implementerBrief(task: Task, phase: Phase): string {
	return `Implement phase ${phase.name} — ${phase.title} — of the task "${task.slug}".

Read these first, completely:
  ${PHASE_TOOL}({ action: "show", name: "${phase.name}" }) — this phase, in full
  ${planPath(task)} — the plan it belongs to
  ${researchPath(task)} — how this area of the code actually works

The working directory is the task's own worktree on branch ${task.slug}. Every change you make
belongs to this phase.

Read every file you are about to change in full before changing it, and follow the conventions in
the governing AGENTS.md or CLAUDE.md. Follow the phase's intent while adapting to what the code
actually is. When you hit a real mismatch — the phase assumes something the code does not do — stop
and report it as expected / found / why it matters. Never invent a workaround inline, and never
broaden the phase.

Run the success criteria written in the phase, and only those: this repository's own commands, not
commands you thought of. Never mark a manual verification step done; that is the operator's.

Do not stage, commit, merge, or otherwise touch git — the operator owns history at whatever
granularity they choose.

When the phase is genuinely complete and its checks pass, your final action is
${PHASE_TOOL}({ action: "set-status", name: "${phase.name}", status: "done" }). If it is not
complete, leave the status alone and report what remains.

Report the change, the design choice, the exact files touched, what you verified and how, and any
remaining risk — in that order, one line each where one line is enough, and nothing padded around
them. Say plainly if anything is incomplete or unverified.`;
}
