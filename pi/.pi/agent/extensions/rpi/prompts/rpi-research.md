---
description: RPI research — answer the query plan and write the codebase explainer
argument-hint: "<task-slug> [instructions]"
---

Read `01-research-questions.md` in full.

**Do not read `ticket.md`.** Not now, not later in this session, not "just for context". The
research document has to describe the codebase as it is; knowing what someone wants to build there
bends every sentence. The question list already carries everything you are allowed to want.

Your only job is to document what exists. No recommendations, no root-cause analysis, no critique,
no refactoring ideas, no future enhancements. If you notice a problem, you write down how the code
behaves and stop there.

## Investigate

Group the questions by area of the codebase, then `delegate` to `scout` — two to six agents, all in
one message so they run concurrently and blind to each other. Not one agent per question. Give each
one an area and the questions that fall in it; `scout` knows how to search.

For anything about an external library or SDK, `delegate` to `researcher` in the same message.

Wait for all of them, then synthesize. If the synthesis leaves a question genuinely unanswered, one
more round of targeted agents, then stop and record what remains open.

## Output

Write `<task-directory>/02-research.md`. If it already exists, update the affected sections in
place rather than appending; keep the number and the filename.

Open it with frontmatter recording where and when it was written:

```text
---
repo: [git rev-parse --show-toplevel]
sha: [git rev-parse HEAD]
---
```

Write it as a technical explainer someone chose to write — a story about how the system works —
not a list of answers and not a file index. A reader who has never seen the codebase should follow
it end to end.

- **Every header states its takeaway.** `### Sessions persist to Postgres before the daemon acks`
  — not `### Session storage`, and never the research question restated.
- Concept first, location second: say what something does, then cite where it lives, inline and
  parenthetically (`src/app.ts:57-80`, ranges rather than one line at a time).
- Reach for whatever shows the shape fastest — tables, mermaid, call-stack trees, file trees, type
  signatures, pseudocode — and put each one beside the prose it illustrates, never in a pile at the
  end. Depth is not traded away for readability; do both.
- Under each area, say how that code is tested today: files, level, fixtures, mocks. "There are no
  tests" is a finding, so write it.
- End with a Code References section comprehensive enough to navigate the whole area, grouped, and
  honest about whether each group is exhaustive.
- Then Open Questions: things you could not trace. Investigative only — "how does X reach Y", never
  "should Z be refactored". "None" if none.

Then stop. Report what you wrote.

## Run context

Task slug: `$1`
Task directory: `~/.pi/agent/tasks/$1/`
Additional instruction supplied through `/rpi`: `${@:2}`
Use the Task directory above wherever this prompt says `<task-directory>`.
