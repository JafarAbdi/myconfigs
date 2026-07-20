---
description: Implement a task, then audit and fix until clean
argument-hint: "[task or file paths]"
---

Implement: $@

If invocation text is empty, read `PLAN.md` and `SPEC.md`. If neither exists, stop. Otherwise treat the text and any named files as the requirements. Do not edit requirement files.

1. Launch one fresh-context `worker` with the full requirements and acceptance checks. It is the sole writer. Wait for it to finish and verify its tests.
2. Follow `~/.pi/agent/prompts/audit.md`. Run its independent review lanes in parallel with fresh context.
3. Finish only when both review lanes pass.
4. Otherwise accept only concrete blocking findings worth fixing now. Launch one fresh-context `worker` to apply those fixes, then audit again.

Stop after three audit rounds. Invalid or missing verdicts are failures. Ask the user about product, scope, or architecture decisions; do not guess. Do not loop for optional polish. Do not stage or commit.

Report files changed, checks run, audit verdicts, fixes applied, and deferred findings.
