---
description: RPI pr — verify the branch and write its PR description
argument-hint: "<task-slug> [instructions]"
---

Task: `~/.pi/agent/tasks/$1/`

Anything the human typed after the slug is extra instruction for this run: ${@:2}

Treat a decision in it as settled, but check any claim about the code before acting on it —
`delegate` to `scout`. A wrong fact accepted here dismisses a real finding.

If a document you read names a `repo:` that is not this repository, stop and say so — the task
belongs to a different checkout.

Read `ticket.md` and `04-structure-outline.md` in full; read `03-design-discussion.md` and
`02-research.md` if the diff raises something they would answer.

Run every phase's `### Verification` commands, not just the last phase's. Stop on a failure.

Read the whole branch diff against its base — `git diff main...HEAD`, or the repo's default branch
if it is not `main` — and read files the diff references but does not show.

**Never push, never create or edit a PR.** No `git push`, no `gh pr create`, no `gh pr edit`. If
there are uncommitted changes, say so and stop; do not commit them.

## Audit the branch

Read `~/.pi/agent/extensions/subagent/prompts/audit.md` and follow it over the whole branch diff.
It is a slash command, so its first line carries an unexpanded `${@:-…}` placeholder — the scope is
the branch diff, not whatever that line appears to say.

On a blocking finding, report it and stop — but say how to act on it, quoting both commands:

```text
/rpi $1@outline append a repair phase: <the finding, in one line>
/rpi $1@pr <why the finding is wrong or not worth fixing>
```

The first appends an unchecked phase, which sends `/rpi` back to build. The second overrides you.
Do not fix the code here, and do not write the description around a finding you have not settled.

## Describe it

Write `~/.pi/agent/tasks/$1/pr-description.md`:

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
git push -u origin $1
gh pr create --body-file ~/.pi/agent/tasks/$1/pr-description.md
```

Close with `Next: /rpi $1` and nothing after it.
