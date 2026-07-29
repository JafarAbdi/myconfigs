---
description: RPI build — implement one structured pending phase
argument-hint: "<task-slug> [instructions]"
---

Read `04-structure-outline.md` in full as generated context. Implement only the authoritative
structured phase in the final Run context. Its ID and exact fields define this run; never infer work
or progress from Markdown checkboxes, parse `outline.json`, or edit either Outline artifact.

Resolve every file path relative to the repository root. Use `implementer` when useful, giving it
the current request, structured phase, and relevant generated Outline, Design, and Research paths.
It runs focused checks; the phase agent owns readiness. The phase wins over Design, Research, and
ticket. Route an out-of-scope request to repair when settled Design already requires it, or Design
when it changes a material decision; do not implement it here.

Before reporting an initial implementation successful, or later claiming the phase complete or ready
for approval, establish a readiness gate for the exact current repository changes:

1. Run every verification command in the structured phase.
2. Write both review tasks before dispatch, then emit both `delegate` calls in one message so the
   reviewers remain mutually blind:
   - `context-style-reviewer` gets the changed scope and no task-level requirement context;
   - `correctness-reviewer` gets the structured phase and generated Outline as requirements, reading
     Design or Research only if the diff raises a question they answer.
3. Require both verdicts to be `PASS`. Report any non-blocking findings.

A passed gate remains valid only while the reviewed repository changes are exactly unchanged. Any
later repository change invalidates it. Before restoring readiness, rerun phase verification and
both reviewers. Otherwise use focused checks and optional review proportional to the current request,
and explicitly report that the phase is not ready for approval.

Fix blocking findings directly or through `implementer`; never implement a `needs design` finding.
You may fix a small, clearly in-scope non-blocking finding when worthwhile. Stop optional polishing
when another full gate costs more than the expected benefit, and report what remains. A guard
earns its place when it prevents a demonstrated reachable failure; one for a speculative failure
does not. Stop when no blocking finding remains, or when no allowed local change can resolve a
remaining one.

Report changes, exact checks and results, findings and fixes, remaining issues, and manual checks.
If Git shows unrelated pre-existing changes, stop and report them. If the phase is impossible or
unnecessary, explain why it can close with no code.

Do not stage, commit, edit Outline artifacts, start another phase, or claim a transition. The
extension owns progress and completion.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi`: `${@:2}`
Authoritative structured pending phase:
{{RPI_STRUCTURED_PHASE}}
