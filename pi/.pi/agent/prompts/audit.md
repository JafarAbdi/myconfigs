---
description: Review the current diff with independent parallel agents
argument-hint: "[scope]"
---

Review the current git diff, or this scope: $@

Get the context/style file list:

```bash
PI_OFFLINE=1 pi --mode json --no-session -p "/context-files" \
  | jq -r 'select(.type=="message_end" and .message.customType=="context-files") | .message.content'
```

In one parallel subagent call, launch with `context: "fresh"`:

- `context-style-reviewer`: conventions only; pass the scope and context/style file list.
- `correctness-reviewer`: adversarial correctness, test integrity, and behavioral equivalence; pass the scope and requirement file paths when available.

The agents must not receive each other's output or current conversation. Review only; do not edit files.

Overall `PASS` requires both verdicts to be `PASS`. Invalid or missing verdicts fail closed. Report each verdict and evidence-backed findings with file:line and the smallest safe fix. Do not apply fixes.
