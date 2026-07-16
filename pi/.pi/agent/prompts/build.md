---
description: Conductor — spec → plan → implement, gated
argument-hint: "<goal>"
---

Build this in the current main session: $@

Run three gated phases. **STOP for my approval between each — end your turn at the gate and wait for my reply. Never run past a gate.** The gate is just you ending your turn and me typing back; input is the normal chat.

**Resume:** if `SPEC.md` exists and I've approved it, skip to Plan. If `PLAN.md` exists and is approved, skip to Implement. Check before starting.

1. **SPEC** — read and follow `~/.pi/agent/prompts/spec.md`. Write `SPEC.md`, then STOP and ask approval.
2. **PLAN** — read and follow `~/.pi/agent/prompts/plan.md`. Write `PLAN.md`, then STOP and ask approval.
3. **IMPLEMENT** — read and follow `~/.pi/agent/prompts/implement.md`. Run implement → `/review` → fix → tick until `PLAN.md` is done, then report.

Modes:
- `/build quick <goal>` — skip the SPEC interview (derive a short spec yourself, note assumptions), thin implement (one `/review` pass, no loop). For small self-contained work.
- `/build auto <goal>` — self-approve the gates and run unattended. Only for throwaway work; you lose the spec/plan review.
