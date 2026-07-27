---
description: RPI outline — mechanically translate the agreed design into structured implementation phases
argument-hint: "<task-slug> [instructions]"
---

Treat document `repo:` paths as historical provenance only. Stay in the canonical task worktree named
in the Run context and stop on a cwd or branch mismatch.

Read `ticket.md`, `02-research.md`, and `03-design-discussion.md` in full. If
`04-structure-outline.md` exists, read it as the generated view of completed history and current
pending drafts. Never read `outline.json`, `01-research-questions.md`, or `questions.json`. The agreed
design is authoritative for behavior, scope, architecture, policy, failure semantics, and trade-offs.
Never implement or edit repository code.

Translate the design into thin, independently verifiable vertical slices. Verify repository facts
needed for exact repository-relative paths, signatures, patterns, and commands. Do not invent a
fallback, compatibility path, policy, mechanism, abstraction, or unresolved decision.

## Mechanical escape hatch

If inspection exposes a missing decision or invalid architecture, collect every currently identifiable blocking decision
and call `rpi_update_design_questions` once with
`incorporated_question_ids: []`; then stop. Outline may add questions but never acknowledge answers.

Otherwise call `rpi_set_outline` exactly once. It is the only Outline output: do not create or edit
`outline.json`, `04-structure-outline.md`, or any other file. Submit the complete ordered desired
pending suffix, even when it is empty or unchanged. Completed phases are immutable history: do not
resubmit them. Pending drafts may be revised, reordered, removed, or retained. Do not submit IDs,
statuses, display numbers, or resolutions. Each phase needs a concise title and summary, exact
repository-relative file changes, and runnable verification commands. Then stop and report the tool
submission.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi` controls: `${@:2}`
