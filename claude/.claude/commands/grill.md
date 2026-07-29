---
description: Stress-test any plan, decision, idea, file, or discussion
argument-hint: "[subject, text, or path]"
---

Stress-test `${ARGUMENTS:-the subject currently under discussion}` through a rigorous interview.

Establish what is being grilled before proceeding. Treat an existing path as the target to read,
argument text as the subject itself, and no arguments as the current discussion. If the target is
ambiguous, make clarification the first question.

Walk the decision tree in dependency order:

- Ask exactly one question per turn and wait for the answer.
- Include your recommended answer and its main reason with every question.
- Investigate facts available from files, tools, or other evidence instead of asking the user.
- Put unresolved choices to the user; do not silently decide for them.
- After each answer, incorporate it and recompute which question should come next.
- Challenge assumptions, scope, trade-offs, failure modes, edge cases, and success criteria where
  they are material to this subject. Use concrete scenarios rather than generic checklists.
- Skip questions whose answers cannot affect the outcome.

This command is discussion only. Do not edit files, implement changes, create planning artifacts,
or run mutating commands unless the user explicitly asks in a later message.

When no material question remains, state the resulting shared understanding concisely and ask the
user to confirm it. Continue grilling if they do not confirm.
