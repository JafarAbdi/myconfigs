---
description: RPI pr — verify the branch and write its PR description
argument-hint: "<task-slug> [instructions]"
---

Stop as well on a missing named base ref or a dirty worktree.

Treat a decision in the final Run context as settled, but check any claim about the code before
acting on it — `delegate` to `scout`. A wrong fact accepted here dismisses a real finding.

Read `ticket.md` and the generated `04-structure-outline.md` projection in full; read
`03-design-discussion.md` and `02-research.md` if the diff raises something they would answer.
Never edit Outline artifacts or treat Markdown as writable progress state; repairs route through
Design and a fresh Outline submission.

Run every phase's `### Verification` commands, not just the last phase's. Stop on a failure.

Read the whole branch diff using the transient merge-base and current HEAD range in the final Run
context. Do not infer `main` or a default branch. Read files the diff references but does not show.

**Never push, never create or edit a PR.** No `git push`, no `gh pr create`, no `gh pr edit`. If
there are uncommitted changes, say so and stop; do not commit them.

## Audit the branch

Follow the audit instructions in the final Run context over the whole branch diff.

On a blocking finding, report it in one clear line and stop. The human can use `/rpi <task-slug>`
to continue the audit, add a repair phase, or revisit the design. Do not fix the code here, and do
not write the description around a finding the human has not settled.

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

Then stop. Report the path, and the exact commands the human can run if they want the PR:

```text
git push -u origin <task-slug>
gh pr create --body-file <task-directory>/pr-description.md
```

Then stop.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through the `/rpi` controls: `${@:2}`
Named base branch: `{{RPI_BASE_BRANCH}}`
Transient merge-base with the named base branch: `{{RPI_BASE_SHA}}`
Transient current HEAD: `{{RPI_PR_HEAD}}`
Audit the transient range: `git diff {{RPI_BASE_SHA}}..{{RPI_PR_HEAD}}`
Substitute the Task slug and Task directory above for `<task-slug>` and `<task-directory>`.
Audit instructions:
{{RPI_AUDIT}}
