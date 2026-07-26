---
description: RPI outline — check the design against the real code, then phase the work
argument-hint: "<task-slug> [instructions]"
---

Treat a decision in the final Run context as settled, but check any claim about the code before
acting on it — `delegate` to `scout`. A wrong fact accepted here becomes the plan and then the code.

If a document names a `repo:`, compare repository identity rather than top-level paths: linked
worktrees have different roots. Treat it as this repository only when that checkout's and this
checkout's `git rev-parse --path-format=absolute --git-common-dir` resolve to the same path;
otherwise stop and say the task belongs to a different repository.

Read `ticket.md`, `02-research.md`, and `03-design-discussion.md` in full. Do not read
`01-research-questions.md`.

Where they disagree the later document wins — design discussion over research over ticket — and
the code you check below wins over all three.

Feedback is an instruction to change this document, never to start implementing — even "just do
it". Implementation is the next phase, in a session of its own.

If `03-design-discussion.md` still has a `####` heading that does not start with `[x]`, that
question is open: stop and say which. Do not answer them and do not write an outline around them.

## This phase is adversarial, not clerical

The design was written from research, and research goes stale and gets things wrong. Before you
phase anything, take each decision in the design and check it against the code that exists right
now — `delegate` to `scout` in one message for the ones worth checking in parallel.

When a decision does not survive contact with the code, change the plan and say plainly in the
outline what you changed and why. When something is genuinely undecidable from the code, add it to
`03-design-discussion.md` as a new `####` heading, unmarked, and stop — an outline may not carry
an unsettled question into the build.

## Phases

Thin vertical slices. Each one cuts through as many layers as the change has and is verifiable on
its own, by commands in this repo, without the next phase existing. Not `add the types` → `add the
API` → `add the UI` → `add tests`; that hands you four piles of unfinished work.

Say what changes in which file and why. Show signatures, not bodies — this document is the header
file, the implementer writes the definitions. Name the test files and the pattern to follow, taken
from what the research found, and prefer an automated check every time one is possible.

## The one marker

`- [ ]` in the Implementation Overview is the **only** checkbox in this document, and the only
record anywhere of what is finished. There is no second checklist under a phase, headings carry no
status glyph, and nothing else in the chain tracks progress. Checked means *settled* — including a
phase that closed without code — so there is never a third state. `### Verification` below is a
plain list, not a checklist, for the same reason.

Write the overview lines exactly as `- [ ] Phase N: title`. `/rpi` reads that shape to decide
whether implementation is finished.

## Every path is relative to the repository root

`src/main.rs`, never `/home/you/project/src/main.rs`. Implementation runs in a worktree that does
not exist yet, so an absolute path here sends the work back to this checkout. Verification commands
too: no `--manifest-path` at this directory, no absolute paths into `target/`.

## Re-running this after work has started

A checked `- [x]` phase is history, not a draft. When the document already exists:

- Never uncheck, renumber, reword, or delete a phase that is `- [x]`. The build phase trusts those
  boxes and will redo whatever you re-open.
- New work is **appended** as new phases with the next free numbers, whether it is a feature, a
  fix, or a correction.
- If a finished phase turns out to be wrong, leave it checked and add a new phase that repairs it,
  naming what it supersedes.
- Unchecked phases are still drafts — reorder, rewrite, or drop those freely.

## Output

Write `<task-directory>/04-structure-outline.md`. If it already exists, update it in place; keep
the number and the filename.

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

- **`path/to/file.ts`**: [what changes] — signature only, where a signature helps

### Verification

- [runnable command]
- [runnable command]
- Manual: [only if a human genuinely has to look at something]

````

Then stop. Report what you wrote.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through the `/rpi` controls: `${@:2}`
Use the Task directory above wherever this prompt says `<task-directory>`.
