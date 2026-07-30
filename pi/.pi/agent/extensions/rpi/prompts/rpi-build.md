---
description: RPI build — implement one structured pending phase
argument-hint: "<task-slug> [instructions]"
---

Read `04-structure-outline.md` in full as generated context. Implement only the authoritative
structured phase in the final Run context. Its ID and exact fields define this run; never infer work
or progress from Markdown checkboxes, parse `outline.json`, or edit either Outline artifact.

Resolve every file path relative to the repository root. Use `implementer` when useful, giving it
the current request, structured phase, and relevant generated Outline, Design, and Research paths.
It runs focused checks; the phase agent owns readiness and chooses its own implementation tactics.
The phase wins over Design, Research, and ticket. Route an out-of-scope request to repair when settled
Design already requires it, or Design when it changes a material decision; do not implement it here.

Before claiming the phase complete or ready for approval, follow this readiness procedure.

If the phase changed no repository files, run every verification command in the structured phase,
explain why no code was needed, and stop for the existing **Close with no code** path. Do not invent
work for an audit.

If the phase changed repository files:

1. Run every verification command in the structured phase.
2. Delegate one fresh `audit` agent. Give it a complete but minimal task containing:
   - the exact structured phase below;
   - the complete current worktree scope, including untracked files;
   - the verification commands and their results;
   - paths to whichever ticket, Outline, Design, or Research documents are authoritative for a
     question raised by the change; do not present superseded documents as requirements.
3. Require `PASS` before reporting readiness, unless the human explicitly dismisses every remaining
   false finding while the repository is unchanged.

Do not paste whole task documents or the parent conversation into the audit task. The auditor reads
large authoritative context from the named files.

A failed delegate, missing verdict, or incomplete report cannot establish readiness. Stop and report
it; do not automatically restart the whole audit.

On `FAIL`, consider every reported blocker. A local repair is one whose smallest safe implementation
is determined by the approved phase without choosing new behavior or expanding its design. If any
genuine blocker fails that test and needs Design, stop before applying further audit repairs and
report the unresolved decision. Otherwise resolve the local blockers using whichever tactics are
appropriate. After an attempted repair, inspect the worktree and decide whether another safe tactic
can make progress or whether to stop. Every repository change invalidates the prior review: rerun
phase verification and a fresh audit before reporting readiness.

The audit reports blockers only. Do not add optional polishing or maintain a reviewer ledger,
prior-report protocol, focused-delta protocol, or fixed review-round count. The model decides whether
further work is productive within the scope and safety rules above.

Report changes, exact checks and results, audit findings and resolutions, remaining issues, and
manual checks. If Git shows unrelated pre-existing changes, stop and report them. If the phase is
impossible or unnecessary, explain why it can close with no code.

Do not stage, commit, edit Outline artifacts, start another phase, or claim a transition. The
extension owns progress and completion.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi`: `${@:2}`
Authoritative structured pending phase:
{{RPI_STRUCTURED_PHASE}}
