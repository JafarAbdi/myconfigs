---
description: RPI outline — mechanically translate the agreed design into implementation phases
argument-hint: "<task-slug> [instructions]"
---

Treat any document `repo:` path as historical provenance only. The canonical task worktree named
in the Run context is the repository for this phase; do not leave it.

Read `ticket.md`, `02-research.md`, and `03-design-discussion.md` in full. Do not read
`01-research-questions.md`. Read design decisions from `03-design-discussion.md`, never from
question Markdown or `questions.json`; the extension returns to Design before Outline whenever a
question is open or awaiting incorporation.

The agreed design is authoritative for behavior, scope, architecture, policy, failure semantics,
and trade-offs. Feedback changes the outline only. Never implement, edit repository code, or begin
Build.

## Mechanical translation only

Translate the agreed design into thin, independently verifiable implementation slices. Do not
choose behavior or architecture, expand scope, or invent a fallback, compatibility path, policy,
mechanism, or abstraction. Do not conceal an unresolved choice in implementation prose.

Before slicing, verify only repository facts needed for exact paths, signatures, patterns, and
commands. Send independent checks to parallel `scout` delegates in one message. Code wins over the
documents as current fact, but not as permission to change the agreed design. Harmless factual
corrections may update paths or signatures only when behavior, architecture, scope, policy,
trade-offs, and failure semantics remain unchanged.

## Mechanical escape hatch

If inspection exposes a missing decision or invalidates the agreed architecture, do not repair,
reinterpret, or outline around the gap. Collect every currently identifiable blocking decision,
then call `rpi_update_design_questions` once with:

- `incorporated_question_ids: []` — Outline never acknowledges answers;
- `questions` containing all blockers, with no question-count limit.

Each blocker needs a concise noun-phrase title, concrete question, 2–26 distinct concrete options,
a 1-based recommended option, and a compact rationale stating the main reason it wins. Never edit
`questions.json`, never add question Markdown, and never continue writing the outline after the
tool call. `/rpi` returns the task to Design for prose incorporation and renewed explicit
agreement; RPI then starts a fresh full-prompt Outline session.

## Phases

Use thin vertical slices. Each cuts through as many layers as needed and is independently verifiable
by commands in this repository. Do not produce horizontal piles such as types, then API, then UI,
then tests.

Say what changes in which file and why. Show signatures, not bodies. Name test files and established
patterns found in research, and prefer an automated check whenever possible.

## The one marker

`- [ ]` in the Implementation Overview is the only checkbox in this document and the only progress
record. There is no phase-local checklist; headings have no status glyph; Verification is a plain
list. Checked means settled, including a phase closed without code.

Write overview lines exactly as `- [ ] Phase N: title`. `/rpi` reads that shape to determine whether
implementation is finished.

## Every path is relative to the repository root

Use `src/main.rs`, never an absolute path. Implementation runs in another worktree. Verification
commands must also avoid absolute paths and checkout-specific flags.

## Re-running after work has started

A checked `- [x]` phase is history. Never uncheck, renumber, reword, or delete it. Append repairs or
new work as phases with the next free numbers and name what a repair supersedes. Unchecked phases
remain drafts and may be reordered, rewritten, or removed.

## Output

Write `<task-directory>/04-structure-outline.md`. If it exists, update it in place and keep its
number and filename.

````markdown
---
repo: [git rev-parse --show-toplevel]
branch: [git branch --show-current]
sha: [git rev-parse HEAD]
---

# [Title]

[two or three sentences]

## Desired End State

## Implementation Overview

- [ ] Phase 1: [title]
- [ ] Phase 2: [title]

---

## Phase 1: [title]

[what this phase delivers]

### File Changes

- **`path/to/file.ts`**: [what changes] — signature only, where useful

### Verification

- [runnable command]
- [runnable command]
- Manual: [only when a human genuinely must inspect something]
````

Then stop. Report what you wrote.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi` controls: `${@:2}`
Use the Task directory above wherever this prompt says `<task-directory>`.
