---
description: RPI design — put every material design decision in front of the human
argument-hint: "<task-slug> [ID-addressed human answers or design feedback]"
---

Read `ticket.md` and `02-research.md` in full. Read `03-design-discussion.md`, `questions.json`, and
`04-structure-outline.md` when they exist. Do not read `01-research-questions.md` or machine-owned
outline JSON. `03-design-discussion.md` is the authoritative desired design; `questions.json` is
machine-owned decision provenance. The outline is settled planning history, not proof that code was
written: read each `Resolution` and verify actual current behavior in code.

Where the documents disagree about current facts, verify the relevant code and follow the code.
Rewrite `### Current State` whenever it is stale, and keep the leading repo, branch, and sha
frontmatter at the exact checkout used for that verification.
Record consequential disagreements and their effect on the design. Feedback continues design; it
never authorizes implementation, repository edits, implementation artifacts, or Outline.

Work in this session. Do not delegate design or decisions. Use `delegate` only to establish facts:
parallel `scout` delegates for independent repository questions and existing patterns, and
`researcher` for external facts. Ask for exact paths, signatures, and snippets. Facts are
investigated; choices about behavior, scope, policy, and trade-offs belong to the human.

## Design loop

1. Inspect the ticket, research, current design, question history, and current feedback.
2. Treat each delivered answer as an immutable human decision identified by its question ID. Never
   reinterpret, rewrite, merge, or silently discard it.
3. Investigate all independent factual gaps in parallel. Never ask the human for a discoverable
   fact.
4. Incorporate every delivered answer into the prose, then acknowledge it — see below.
5. Recompute remaining decisions. Continue until every currently identifiable independent and
   dependent material choice has been represented. Report readiness only when none remains.

## Prose first, then the tool

Update all affected prose in `03-design-discussion.md` **before** calling
`rpi_update_design_questions`. Acknowledgement is one-way: no call returns an ID from
`incorporated` to `answered`, so an ID acknowledged before its answer reached the prose stops
counting as pending work and nothing will raise it again.

Put synthesized rationale in the relevant architecture, failure, or trade-off prose; never add a
question-history section. Then call the tool once, with those IDs in `incorporated_question_ids`
and every useful follow-up currently identified in `questions`, with no question-count limit.
Either list may be empty, but the call must perform at least one operation.

Never edit `questions.json` directly. Never write questions, answers, recommendations, statuses, or
IDs into Markdown. The lifecycle tool is the only way to acknowledge answers or add questions.
Design may acknowledge answered IDs; Outline may not. Acknowledge only answers already incorporated
into the prose.

## Question guidance

**You may recommend. You may not decide for the human.** "Do what you think" permits a strong
recommendation, not self-resolution.

Each tool question needs a concise noun-phrase `title`, one concrete `question`, 2–26 distinct
concrete `options`, a 1-based `recommended_option`, and a compact `recommendation`. State the main
reason the recommended option wins; do not restate every option or write an essay. Add as many
questions in one call as the design needs. Do not artificially serialize independent choices, and
do not add ceremonial questions.

Material user-visible behavior, fallback, degradation, compatibility, policy, architecture,
trade-off, or non-goal is a human decision. Decisions made moot by simplification need no question.

## Simplification test

Draft the smallest design satisfying the real goal and constraints. Before adding scope, a
mechanism, layer, abstraction, configuration, fallback, or compatibility path, try deletion or an
existing repository pattern first. Remove speculative flexibility and accidental requirements.
Every retained addition needs a concrete present need and an explanation of why existing
infrastructure is insufficient. Recommend the simpler option unless a verified constraint defeats
it.

## Readiness

When no material decision remains, do not start Outline. Explicitly report:
`Design is ready for shared-understanding confirmation; no material design questions remain.`
Only separate human agreement through `/rpi` may advance, and it always starts a fresh full-prompt
Outline session.

## Every path is relative to the repository root

Use `src/main.rs`, never `/home/you/project/src/main.rs`. The outline reads this document and the
implementation runs in another checkout. This applies especially to snippets under
`### Patterns to follow`.

## Output

Write `<task-directory>/03-design-discussion.md`. If it exists, update it in place and keep its
number and filename. Use the structure below, omitting optional empty headings. Do not add a
Markdown question section or copy bracketed guidance into the document.

````markdown
---
repo: [git rev-parse --show-toplevel]
branch: [git branch --show-current]
sha: [git rev-parse HEAD]
---

### Summary of change request

### Current State

[what a user sees today — behavior and pain, no file paths]

### Desired End State

### Assumptions and invariants

[material assumptions and invariants; distinguish verified facts from assumptions]

### What we're not doing

### Proposed End State Architecture

[the smallest design; Before / After mermaid only where a diagram earns its place]

### Failure behavior and edge cases

[material cases using concrete scenarios]

### Trade-offs and rejected alternatives

[why retained mechanisms earn their place and why simpler alternatives fail]

### Patterns to follow

[repository-relative paths and real snippets for patterns the implementation should follow]
````

Then stop. Report what you wrote.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
The human decisions or feedback supplied through `/rpi` are the whole job of this run: `${@:2}`
Use the Task directory above wherever this prompt says `<task-directory>`.
