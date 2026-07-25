---
description: RPI build — implement the next unchecked phase of the outline
argument-hint: "<task-slug> [instructions]"
---

Task: `~/.pi/agent/tasks/$1/`

Anything the human typed after the slug is extra instruction for this run: ${@:2}

Treat a decision in it as settled, but check any claim about the code before acting on it —
`delegate` to `scout`. A wrong fact accepted here becomes the plan and then the code.

If a document you read names a `repo:` that is not this repository, stop and say so — the task
belongs to a different checkout.

Read `04-structure-outline.md` in full.

Take the **first unchecked** `- [ ]` in the Implementation Overview. That box is the whole resume
mechanism: it is the only record of what is done, so trust it, and do not go looking for other
markers. One phase per run.

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

Tell the human what changed, what you ran, what the reviewer found, what you fixed for it, and what
you left, plus any manual check the phase listed. Then stop and wait. Do not start the next phase,
and do not commit before they confirm.

Once they confirm:

1. Change that phase's `- [ ]` to `- [x]` in the Implementation Overview. Change nothing else in the
   document — not the heading, not any other line. Never invent another marker.
2. Stage the files this phase changed, by name — never `git add -A` or `git add .`. Then read
   `~/.claude/commands/gh/commit-message.md` and follow it; it commits the staged set and nothing
   else.

If a phase turns out to be impossible or unnecessary, check it anyway and add a `Resolution:`
paragraph under that phase saying why it closed with no code. `- [x]` means *settled*, not *code
was written*; never invent a third state.

Then stop. Report what you wrote, and close with `Next: /rpi $1` and nothing after it.
