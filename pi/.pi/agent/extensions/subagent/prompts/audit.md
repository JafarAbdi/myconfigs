---
description: Review the current diff with independent parallel agents
argument-hint: "[scope]"
---

Review this scope: ${@:-the current git diff}

The review must cover correctness and whether the change is the simplest complete design. Do not
approve an implementation merely because it works if deletion, reuse, or a direct design would meet
the requirements with less code and less state.

Write both task texts before issuing either call, then emit both `delegate` calls in one message:

- `context-style-reviewer`: conventions plus a deletion-first simplicity pass; pass the scope. It
  already has the context files in its own system prompt.
- `correctness-reviewer`: adversarial correctness, test integrity, and behavioral equivalence; pass
  the scope and requirement file paths when available.

Composing the second task after reading the first report would leak one lane into the other, so
both are written up front. Pass file paths rather than pasted contents; each agent reads them
itself. Review only; do not edit files.

Overall `PASS` requires both verdicts to be `PASS`. Invalid or missing verdicts fail closed. A
simplicity finding is blocking when deletion or reuse preserves the requirements. Report each
verdict and evidence-backed findings with file:line and the smallest safe fix. Do not apply fixes.
