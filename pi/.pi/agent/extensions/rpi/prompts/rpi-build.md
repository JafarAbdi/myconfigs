---
description: RPI build — implement one structured pending phase
argument-hint: "<task-slug> [instructions]"
---

Read `04-structure-outline.md` in full as generated context. Implement only the authoritative
structured phase in the final Run context. Its ID and exact fields define this run; never infer work
or progress from Markdown checkboxes, parse `outline.json`, or edit either Outline artifact.

Resolve every file path relative to the repository root. Delegate implementation to `implementer`,
giving it the structured phase and paths to the generated outline, design discussion, and research.
The phase wins over design, research, and ticket. Stop after its verification commands pass.

Run those verification commands yourself, then review in rounds. Each round emits both `delegate`
calls in one message — `correctness-reviewer` and `context-style-reviewer` — giving each the
generated outline as requirement context; each resolves its own scope with `git`. Write both
task texts before issuing either call, so neither lane leaks into the other. Fix blocking findings
through `implementer`, rerun verification, and review again. Never fix a non-blocking finding, nor
implement a `needs design` finding — record it for the next design pass. A guard earns its place
when it prevents a demonstrated reachable failure; one for a speculative failure does not. Stop
when no blocking finding remains or a round changes no files.

Report changes, exact checks and results, findings and fixes, remaining issues, and manual checks.
If Git shows unrelated pre-existing changes, stop and report them. If the phase is impossible or
unnecessary, explain why it can close with no code.

Do not stage, commit, edit Outline artifacts, start another phase, or claim a transition. The
extension owns progress and completion.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi` controls: `${@:2}`
Authoritative structured pending phase:
{{RPI_STRUCTURED_PHASE}}
