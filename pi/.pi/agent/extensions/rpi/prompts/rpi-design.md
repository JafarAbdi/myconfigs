---
description: RPI design — put the design decisions in front of the human, unresolved
argument-hint: "<task-slug> [answers to open questions]"
---

If a document names a `repo:`, compare repository identity rather than top-level paths: linked
worktrees have different roots. Treat it as this repository only when that checkout's and this
checkout's `git rev-parse --path-format=absolute --git-common-dir` resolve to the same path;
otherwise stop and say the task belongs to a different repository.

Read `ticket.md` and `02-research.md` in full. Do not read `01-research-questions.md`.

Where they disagree, `02-research.md` wins: the ticket says what someone wants, the research says
what is there. Say in the design where you went with the code over the ticket, and why.

Feedback is an instruction to change this document, never to start implementing — even "just do
it". Implementation is its own phase, in a session of its own.

Treat the human's decisions as settled, but check any claim they make about the code before building
on it — `delegate` to `scout`. A wrong fact accepted here becomes the outline and then the code.

Work in this session. Do not `delegate` the design itself: children run with no session and no UI,
so they cannot ask you anything and you cannot ask the human through them.

Two things are worth a `scout` — a specific fact the research left thin, and the patterns below.
The research phase never saw the ticket, so it could not know which existing code this change
should look like; you do. Send scouts for the two or three places the codebase already does what
you are about to do, and ask each for the real snippet, not a description of it.

## The rule this phase exists for

**You may recommend. You may not resolve.**

A question is a `####` heading, and it is open until that heading starts with `[x]`. `/rpi` counts
the unmarked ones to decide whether the outline can start, so a heading you forget to mark stays
open — the direction that stalls and asks rather than the one that proceeds without you.

Because the count is document-wide, `####` belongs to questions alone. Use `-` or bold for
sub-points anywhere else in this document.

Every design question is written open, with options and your recommendation. None of them is
resolved in the first pass — not when the answer looks obvious, not when the research all but
settles it, not when the human says "do what you think". That is permission to recommend
forcefully, not permission to close the question. Closing it yourself deletes the only gate in the
chain where the human's judgement is what is being asked for.

Every material user-visible fallback, degradation, or non-goal must be an unresolved design
question with concrete options. Do not bury one as settled prose in error handling, compatibility,
or `### What we're not doing`.

When the human answers — this prompt run again with their feedback, or any clear indication of a
decision, they do not have to say "resolve" — mark that heading `#### [x] ` and write the decision,
the rationale, and the options discarded with why underneath it. The question stays where it is,
so its options stay next to the decision that rejected them. Questions they did not answer keep
their bare heading.

## Every path is relative to the repository root

`src/main.rs`, never `/home/you/project/src/main.rs`. The outline reads this document and the
implementation runs in a checkout that is not this one, so an absolute path here follows them
there. Applies to the snippets under `### Patterns to follow` above all — those are the paths the
outline copies forward.

## Output

Write `<task-directory>/03-design-discussion.md`. If it already exists, update it in place; keep
the number and the filename.

````markdown
---
repo: [git rev-parse --show-toplevel]
branch: [git branch --show-current]
sha: [git rev-parse HEAD]
---

### Summary of change request

### Current State

[what a user sees and experiences today — behaviour and pain, no file paths]

### Desired End State

### What we're not doing

### Proposed End State Architecture

Before / After, as mermaid where a diagram earns its place, plus a concise description.

### Design Questions

#### Question title, open

[the question]

- Option A: ... [snippet, diagram, or pseudocode if it clarifies]
- Option B: ...

Recommendation: Option A — [why, grounded in the research]

#### [x] Question title, once the human has decided

[the question, unchanged]

- Option A: ...
- Option B: ...

Decision: [what they chose]
Rationale: [why, and why each discarded option was discarded]

### Patterns to follow

[patterns the research found in this codebase that the implementation should follow — each with
its file path and a real snippet, not a paraphrase]
````

Then stop. Report what you wrote.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
The human's decision supplied through the `/rpi` controls is the whole job of this run: `${@:2}`
Use the Task directory above wherever this prompt says `<task-directory>`.
