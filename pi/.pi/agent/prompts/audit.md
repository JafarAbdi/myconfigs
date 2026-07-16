---
description: Review the current diff — conventions + adversarial correctness
argument-hint: "[scope]"
---

Run the `context-style-reviewer` agent on the current git diff (or the scope I name here: $@). Fresh context, review-only — do not edit any project/source file.

Get the context/style file list and pass it in:

```bash
PI_OFFLINE=1 pi --mode json --no-session -p "/context-files" \
  | jq -r 'select(.type=="message_end" and .message.customType=="context-files") | .message.content'
```

The agent runs two passes over the diff — Pass 1 your conventions (CLAUDE.md, `/context-files`, style), Pass 2 adversarial correctness (incl test-integrity and behavioral-equivalence) — and returns Style / Correctness / Overall verdicts.

Model — pick from `jq -r '.enabledModels[]?' ~/.pi/agent/settings.json`: code review → `openrouter/moonshotai/kimi-k2.7-code`; hard correctness → `openrouter/deepseek/deepseek-v4-pro`. If unsure, omit to inherit.

Report the verdicts and findings (file:line, evidence, smallest fix). Do not apply fixes.
