---
description: Implement PLAN.md — worker, /audit, fix, tick
---

Read `PLAN.md` and `SPEC.md`. Implement the open TODOs. You own orchestration — fan out freely on read-only work, keep the write path single-writer.

For each TODO (or a small batch):

1. **Implement** — one async `worker` implements the TODO and writes/updates tests derived from `SPEC.md`, runs them, pastes actual output. Single writer. Optional freeze so it can't weaken tests: `touch .pi-protect-tests` before, `rm -f .pi-protect-tests` after.
2. **Review** — run the flow in `~/.pi/agent/prompts/audit.md` on the resulting diff (it handles adversarial + context-style + test-integrity + model routing).
3. **Fix** — synthesize the blocking findings; one async fix `worker` applies only those.
4. **Tick** — you (conductor) tick the `PLAN.md` box `[x]` only when that TODO's tests are green AND `/audit` came back clean (`context-style-reviewer` Overall `PASS`). The implementer never ticks its own box.

Loop until `PLAN.md` is clean or 3 rounds. Do not finish until the tests actually run green and `context-style-reviewer` Overall is `PASS` (or every blocking finding is fixed).

Speed: async subagents + `wait()`; strong model for the implementer (`openai-codex/gpt-5.5`), cheap models + `thinking: low` for review lanes; 1 review round by default, another only if a fix pass materially changed the diff.

Report: TODOs done, files changed, test commands + results, `/audit` verdicts, models per lane, deferred items.
