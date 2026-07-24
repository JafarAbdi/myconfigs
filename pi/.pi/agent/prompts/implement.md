---
description: Implement a task, then audit and fix until clean
argument-hint: "[task or file paths]"
---

Implement: $@

If invocation text is empty, read `PLAN.md` and `SPEC.md`. If neither exists, stop. Otherwise treat
that text and named files as the requirements. Do not edit requirement files.

1. Establish the plan. If `PLAN.md` exists, it is the plan. Otherwise launch one fresh-context
   `planner` with the full requirements; it returns file-level steps, tests to pass, assumptions,
   and open questions. If it raises a blocking open question, ask the user before writing.
2. Launch one fresh-context `implementer` with the requirements and the plan. It is the sole writer.
   Require its pre-edit deletion test and post-edit deletion pass. Wait for it to finish and verify
   its tests.
3. Follow `~/.pi/agent/prompts/audit.md`. Run its independent review lanes in parallel with fresh
   context.
4. Finish only when both review lanes pass, including the simplicity pass.
5. Otherwise accept only concrete blocking findings worth fixing now. Launch one fresh-context
   `implementer` to apply those fixes, then audit again.

Stop after three audit rounds. Invalid or missing verdicts are failures. Ask the user about product,
scope, or architecture decisions; do not guess. Do not loop for optional polish. Do not stage or
commit.

Report files changed, checks run, audit verdicts, fixes applied, and deferred findings.
