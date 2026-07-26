---
description: RPI build — implement the next unchecked phase of the outline
argument-hint: "<task-slug> [instructions]"
---

Treat a decision in the final Run context as settled, but check any claim about the code before
acting on it — `delegate` to `scout`. A wrong fact accepted here becomes the plan and then the code.

If a document names a `repo:`, compare repository identity rather than top-level paths: linked
worktrees have different roots. Treat it as this repository only when that checkout's and this
checkout's `git rev-parse --path-format=absolute --git-common-dir` resolve to the same path;
otherwise stop and say the task belongs to a different repository.

Read `04-structure-outline.md` in full.

Implement the authoritative unchecked phase line in the final Run context. Confirm it is the first
unchecked `- [ ]` in the Implementation Overview; if it is not, stop with the mismatch. That line
is the whole run. Do not look for other markers. One phase per run.

**The repository is the current working directory.** Resolve every file path relative to it and
ignore absolute repository paths in the documents, verification commands included — those point at
the checkout the outline was planned in. An absolute path outside the cwd is a defect in the
outline: say so rather than following it, and pass this rule to the implementer.

## Implement it

`delegate` to `implementer`. Give it the phase number and the **paths** to the outline, the design
discussion, and the research — never their contents. It has a read tool.

Tell it: the outline is intent and signatures, it writes the implementation; outline wins over
design discussion wins over research wins over ticket; this phase only; stop after the phase's
Verification commands pass; do not touch the outline document.

Then run that phase's Verification commands yourself. The implementer's report is a claim, not
evidence.

If the implementer reports that the outline does not match the code, stop and put the mismatch in
front of the human. Do not improvise around it.

## Review and fix

`delegate` to `correctness-reviewer` with the paths this phase changed and the outline as the
requirement file. It has no `bash`, so name the files — it cannot work out a diff itself.

Fix the blocking findings: `delegate` to `implementer` with the finding text, re-run the phase's
Verification commands, then review again. Stop when the reviewer returns nothing blocking, or when
a round changes no files. Never fix non-blocking findings; report them.

If the implementer escalates instead of fixing, the rule above applies: stop and ask the human.

## Report and stop

Report normally: what changed, the exact verification commands and results, the reviewer's findings
and fixes, anything left, and any manual check. Name the repository-relative paths changed by this
phase, including tests and deletions. If Git shows unrelated pre-existing changes, stop and put them
before the human instead of including them.

If the phase is impossible or unnecessary, explain why it can close with no code.

Do not stage or commit anything. Do not edit any outline checkbox or add a `Resolution:` paragraph.
Do not start another phase or claim the task transitioned. The extension presents the report and
repository state to the human, who reviews with `git diff` and decides what happens next.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through the `/rpi` controls: `${@:2}`
Authoritative unchecked phase line: `{{RPI_PHASE_LINE}}`
Use the Task directory above for all task-document paths.
