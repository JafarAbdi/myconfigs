---
description: Turn SPEC.md into PLAN.md with TODO checkboxes
---

Read `SPEC.md` (if missing, tell me and stop). Scout the codebase for integration points only if it's an existing project.

Write `PLAN.md` as an ordered list of TODO checkboxes. Each TODO carries:
- files/areas to touch
- context needed to do it
- acceptance = which tests or observable behaviors prove it done

Format:

```markdown
- [ ] **T1: <title>** — files: `a.ts` · ctx: <what to know> · done when: `<tests/behavior>`
```

Order so tests can drive each TODO, and so pure/testable logic lands before IO. Keep it to real steps — no filler.

Then STOP: ask me to approve or edit. Do not implement.
