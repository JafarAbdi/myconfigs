---
description: RPI questions — write the query plan for the research phase
argument-hint: "<task-slug> [instructions]"
---

Task: `~/.pi/agent/tasks/$1/`

Anything the human typed after the slug is extra instruction for this run: ${@:2}

Read `ticket.md` in full.

Write a query plan: the questions the research phase will answer. You are not answering them.

Do one light locating pass first — `delegate` to `scout` to find which files, directories, and
dependencies the ticket touches. One agent, not six. Deep investigation belongs to the next phase.

## The questions

Fewer than eight, at least two, scaled to the task. Every question is **positive and descriptive**:
what exists, where it lives, how it works, how the pieces interact, what the dependencies do.

Never normative. No "how would we", no "how should we", no "what needs to change", no improvements,
no critique. A question that leaks the shape of the intended change has failed — the research phase
must describe the codebase as it is, uncontaminated by what the ticket wants.

Steer the researcher: name the directory, the package, or the doc site you want it to look in.

If the ticket touches UI, one question must cover the design system — components, colour tokens,
typography, spacing, theming — whether or not the ticket mentions it.

## Output

Write `~/.pi/agent/tasks/$1/01-research-questions.md`. If it already exists, update it in place;
keep the number and the filename.

````markdown
---
repo: [git rev-parse --show-toplevel]
sha: [git rev-parse HEAD]
---

# Research Questions

1. ...
2. ...

## Key Context Pointers

- Links: [URLs the ticket gave, verbatim]
- Repositories: ...
- Libraries / dependencies: ...
- Filepaths: ...
````

Preserve every pointer the ticket supplied verbatim — exact URLs, exact paths, exact package names.
Drop the section only if the ticket gave none.

Then stop. Report what you wrote, and close with `Next: /rpi $1` and nothing after it.
