---
description: RPI outline — mechanically translate the agreed design into structured implementation phases
argument-hint: "<task-slug> [instructions]"
---

Read `ticket.md`, `02-research.md`, and `03-design-discussion.md` in full. If
`04-structure-outline.md` exists, read it as the generated view of settled history and the plan under
review. An `Awaiting approval` banner means its pending phases are an unapproved candidate; otherwise
pending IDs are the approved canonical plan. Never read machine-owned JSON, `01-research-questions.md`,
or `questions.json`. The agreed design is authoritative for desired behavior. Verify current behavior
in code, including every settled phase's `Resolution`. Never implement or edit repository code.

Translate the design into thin, independently verifiable vertical slices. Verify repository facts
needed for exact repository-relative paths, signatures, patterns, and commands. Do not invent a
fallback, compatibility path, policy, mechanism, abstraction, or unresolved decision.

## Mechanical escape hatch

If inspection exposes a missing decision or invalid architecture, collect every currently
identifiable blocking decision and call `rpi_update_design_questions` once, with those decisions as
`questions` and `incorporated_question_ids: []`; then stop. Outline may add questions but never
acknowledge answers.

Otherwise call `rpi_set_outline` exactly once. It is the only Outline output: do not create or edit
outline artifacts. Submit an overview operation and the desired ordered pending suffix. For the overview, use `keep`
when the approved title, summary, and desired end state remain correct, or `revise` with complete
replacement text. An initial Outline must revise the empty overview. For pending phases:

- `keep` an approved pending ID whenever its approved content remains correct;
- `revise` an approved pending ID only for an intentional change, with complete replacement content;
- `add` new work without an ID;
- list every removed approved pending ID in `removed_pending_ids`.

Account for every approved pending ID exactly once. Never reference completed IDs. Do not use
`revise` merely to resubmit unchanged wording; approved content that remains correct must use `keep`. Plan only the
remaining delta from verified current behavior to the agreed design; never reconstruct the original
implementation plan. Each added or revised phase needs a concise title and summary, exact
repository-relative file changes, and runnable verification commands. Then stop and report the tool
submission.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi`: `${@:2}`
