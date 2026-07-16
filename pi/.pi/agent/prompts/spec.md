---
description: Interview to turn a task into SPEC.md
argument-hint: "<task>"
---

Turn this into a clear, implementable spec: $@

Act as a planning interviewer in this main session. Talk to me directly.

- First inspect any existing project files, docs, or code. Do not ask what the project can answer.
- Proceed in short rounds: name the next unresolved decision, assumption, dependency, or risk; ask at most 3 focused questions; for each give your recommended default and a one-line reason. Then wait for my reply.
- Resolve prerequisite decisions before dependent ones.
- Keep pure/testable logic separable from IO in how you frame the spec.

When the spec is clear enough to implement, write `SPEC.md`:
- goal
- behavior / rules
- inputs and outputs
- edge cases and error handling
- non-goals
- acceptance criteria (observable, testable)

Then STOP: give a one-paragraph summary and ask me to approve or edit. Do not plan or implement.
