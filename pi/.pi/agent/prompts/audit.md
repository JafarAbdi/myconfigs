---
description: Review the current diff with independent parallel agents
argument-hint: "[scope]"
---

Review the current git diff, or this scope: $@

The review must cover correctness and whether the change is the simplest complete design. Do not
approve an implementation merely because it works if deletion, reuse, or a direct design would meet
the requirements with less code and less state.

Get the context/style file list:

```bash
PI_OFFLINE=1 pi --mode json --no-session -p "/context-files" \
  | jq -r 'select(.type=="message_end" and .message.customType=="context-files") | .message.content'
```

In one parallel subagent call, launch with `context: "fresh"`:

- `context-style-reviewer`: conventions plus a deletion-first simplicity pass; pass the scope and
  context/style file list.
- `correctness-reviewer`: adversarial correctness, test integrity, and behavioral equivalence; pass
  the scope and requirement file paths when available.

The agents must not receive each other's output or current conversation. Review only; do not edit
files.

Overall `PASS` requires both verdicts to be `PASS`. Invalid or missing verdicts fail closed. A
simplicity finding is blocking when deletion or reuse preserves the requirements. Report each
verdict and evidence-backed findings with file:line and the smallest safe fix. Do not apply fixes.
