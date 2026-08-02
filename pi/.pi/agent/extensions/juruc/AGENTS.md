# Project Contract

## Objective

Provide one small workflow from an isolated Git workspace through separate research and planning to phased, declared verification and extension-owned commits.

## Requirements

- R1: `/juruc` is the task-picker and task-creation front door; managed sessions show one concise lifecycle line.
- R2: Task creation may initialize Git with confirmation, then creates a dedicated task branch and managed worktree from committed `HEAD`.
- R3: Research uses its typed delegate-only session run; successful final synthesis is persisted verbatim in `research.md` before a separate typed plan session run begins.
- R4: Planning is read-only, uses canonical `/grill`, preserves completed phases, and may replace only remaining phases through `juruc_set_plan`; every phase declares a nonempty ordered list of exact runnable verification commands.
- R5: Each phase uses one implementation session run scoped by its positive phase ordinal; it is resumed after blocking or failed verification, while the next phase starts a fresh run.
- R6: `juruc_finish_phase` accepts structured evidence for every declared command, rejects nonzero or inexact evidence before staging, refuses an unchanged candidate, then stages with `git add -A`, creates the local checkpoint commit, records the evidence and commit, and advances automatically. There is no independent per-phase audit.
- R7: `juruc_block_phase` persists the reason without discarding dirty work and permits resume, planning, or renewed research.
- R8: Persist task identity, lifecycle, one append-only typed session-run list, plan, completed phases, remaining phases, block reason, resolutions, ordered verification evidence, and commits once in `task.json`.

## Invariants

- I1: Models provide research, plans, implementation, structured verification evidence, resolutions, and commit-message text; the extension owns workflow identity, transitions, staging, and commits.
- I2: Every session path is absolute and globally unique within the task; discovery kinds are singletons, and implementation, reviewer, and correction runs have unique positive scopes. Planning cannot edit the worktree and implementation cannot commit.
- I3: Session runs and completed phase records are append-only. Replanning replaces only remaining work.
- I4: Completed-phase evidence must match the authoritative phase's declared command count, order, and exact text, and every exit code must be zero.
- I5: Persisted JSON and external Pi, filesystem, and Git results are validated at their boundaries.
- I6: JURUC runtime state remains isolated from RPI.

## Constraints

- C1: Keep the lifecycle to `research`, `planning`, `building`, `blocked`, and `done`.
- C2: Keep only three model workflow tools: `juruc_set_plan`, `juruc_finish_phase`, and `juruc_block_phase`.
- C3: Use canonical `/grill` unchanged and resolve it through Pi's command registry.
- C4: Use ordinary Git commands and object IDs; do not implement custom tree manifests, commit-chain forensics, acceptance receipts, or transaction recovery.
- C5: Save `task.json` and `research.md` through atomic file replacement.
- C6: Convert persisted data explicitly; do not add compatibility paths for old task formats.

## Assumptions

- A1: One experienced operator owns a managed task and does not mutate its task files or worktree while a JURUC operation runs.
- A2: Sessions and persisted files provide continuity, not an adversarial authorization boundary.
- A3: Unexpected interference or a crash inside a Git write may stop and require manual repair; crash-perfect recovery is unnecessary.
- A4: Reference repositories are cloned outside managed task worktrees.

## Non-Goals

- N1: No PR, deployment, per-phase human approval, dependency graph, or file allowlist stage.
- N2: No background deletion or repair of unexpected operator changes. In the task picker, the operator may press `Ctrl+D` and confirm removal of that task's metadata and managed worktree; its branch and commits remain.
- N3: No settlement leases, canonical-turn authorization, exact-session forensics, candidate promotion, acceptance transaction, or terminal Git proof.
- N4: No role-specific model or thinking-effort profiles.
