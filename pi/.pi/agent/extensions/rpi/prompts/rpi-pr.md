---
description: RPI pr — verify the branch and write its PR description
argument-hint: "<task-slug> [instructions]"
---

Stop on a missing named base ref or a dirty worktree.

Treat a decision in the final Run context as settled, but check any claim about the code before
acting on it — `delegate` to `scout`. A wrong fact accepted here dismisses a real finding.

Read `ticket.md` and the generated `04-structure-outline.md` projection in full; read
`03-design-discussion.md` and `02-research.md` if the branch raises something they would answer.
Never edit Outline artifacts or treat Markdown as writable progress state; repairs route through
Design and a fresh Outline submission.

Before writing or updating `pr-description.md`, resolve the actual current HEAD with
`git rev-parse HEAD`; never infer reuse from the phase-entry HEAD in the final Run context. Run every
phase's `### Verification` commands against that resolved HEAD. Stop on a failure.

Read the whole branch diff using the transient merge-base in the final Run context and the resolved
current HEAD. Do not infer `main` or a default branch. Read files the diff references but does not
show. An explicitly named empty range is still a valid branch-review scope.

Delegate one fresh `audit` agent for each branch-review attempt. Give it a complete but minimal task
containing:

- the exact merge-base-to-HEAD range;
- the verification commands and their results;
- paths to `ticket.md` and `04-structure-outline.md`, plus Design or Research only when relevant.

Do not paste whole task documents or the parent conversation. The auditor reads authoritative
context from the named files. A failed delegate, missing verdict, or incomplete report cannot
establish readiness; stop and report it rather than automatically restarting the whole audit.

Require `PASS` before writing the description, unless the human explicitly dismisses every remaining
false finding while HEAD is unchanged. On a genuine blocker, report the audit findings and stop. The
human can use `/rpi <task-slug>` to replan pending work, add a repair phase, or revisit Design. Do not
fix code here or write the description around an unresolved finding.

The verification and audit remain valid only while HEAD is unchanged. If HEAD changes, rerun the
complete sweep and a fresh audit.

**Never push, never create or edit a PR.** No `git push`, no `gh pr create`, no `gh pr edit`. If
there are uncommitted changes, say so and stop; do not commit them.

## Describe it

Write `<task-directory>/pr-description.md`:

````markdown
# [title]

[two or three sentences: what this does and why, for someone who has not read the ticket]

## Changes

- `path/to/file.ts` — [what changed and why]

## Verification

[the commands that were run and what they proved]

## Deviations from the outline

[where the implementation departed from `04-structure-outline.md`, and why. "None" if none —
but check phase by phase before writing that, including any phase closed by a `Resolution:`
paragraph.]
````

No HTML walkthrough, no generated artifact. A reviewer reads the diff; this description tells them
what to look for.

Report the path, and the exact commands the human can run if they want the PR:

```text
git push -u origin <task-slug>
gh pr create --body-file <task-directory>/pr-description.md
```

Then stop.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi`: `${@:2}`
Named base branch: `{{RPI_BASE_BRANCH}}`
Transient merge-base with the named base branch: `{{RPI_BASE_SHA}}`
Transient current HEAD at phase entry: `{{RPI_PR_HEAD}}`
Initial transient range: `git diff {{RPI_BASE_SHA}}..{{RPI_PR_HEAD}}`
Substitute the Task slug and Task directory above for `<task-slug>` and `<task-directory>`.
