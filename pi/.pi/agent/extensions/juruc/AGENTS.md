# Project Contract

## Objective

Provide a deterministic planning-to-commit workflow whose mechanical state, Git evidence, sessions, recovery, and commits are extension-owned.

## Requirements

- R1: `/juruc` is the single task-picker front door; every managed session shows one read-only lifecycle line derived from authoritative task state.
- R2: Completed phase history is immutable; future work is one ordered replaceable queue.
- R3: Active amendments persist before acting and resume the exact existing implementation session.
- R4: Every phase completion requires the latest fresh schema-validated audit of the exact staged Git candidate; the final phase's same audit also judges the integrated proposed tree against the overall criteria.
- R5: JURUC commits the exact audited Git tree and verifies its parent and resulting cleanliness.
- R6: During `/grill`, the planner classifies confirmed material as task-specific or durable project context. Before the single final confirmation, it shows the exact target path and durable entries under Objective, Requirements, Invariants, Constraints, Assumptions, and Non-Goals—or states that there are none. Confirmed context entries are implemented only through exact success criteria in the normal audited phase candidate; planning remains read-only.
- R7: Raw research remains in a fresh first-level coordinator; successful synthesizer output is persisted verbatim as opaque text without model retransmission or content conventions.
- R8: Closed discriminated states and their transition constructors make invalid internal workflow combinations unrepresentable; validation is reserved for persisted JSON, Pi/tool results, filesystem observations, and Git evidence at their boundaries.
- R9: JURUC tools are active only in the exact current session and workflow state that owns them; ordinary, historical, detached, and completed sessions never expose JURUC tools to the model.
- R10: Session replacement persists destination intent first; the fresh runtime owns destination tools and canonical prompt resolution, while the disposed runtime transfers only an exact one-use authorization through `ReplacedSessionContext`.
- R11: `juruc_set_plan` and `juruc_block_phase` are authorized only as sole tool calls. Tree navigation is cancelled only while the exact session owns live JURUC authority or settlement exclusion.

## Invariants

- I1: Models provide semantic content but never allocate workflow identity or advance state through prose.
- I2: Planning sessions are read-only; implementation sessions cannot commit directly.
- I3: Audit authority belongs only to the latest exact task, phase, session, plan revision, and Git candidate tree; a newer exact audit supersedes an older one without serializing independent audits.
- I4: JURUC runtime state remains isolated from RPI.
- I5: Persist intent before session switching or any destructive action.
- I6: A research coordinator may make the first-level delegate calls required by research; delegated agents cannot further delegate, and the coordinator cannot inspect or modify the repository itself.
- I7: Every durable fact has one owner; UI, actions, handoffs, and recovery are derived instead of persisted as duplicate flags or counters.
- I8: Tool capability is derived from the current task-state/session pair, never from registration defaults or historical session membership.

## Constraints

- C1: Use canonical `/grill` and `/commit-message` prompts unchanged and resolve them from the fresh runtime's `pi.getCommands()`.
- C2: Use Git object and index semantics; do not hash filesystem trees or implement custom manifests.
- C3: Await Pi lifecycle handlers directly; do not use detached timers or microtasks for recovery.
- C4: Convert JURUC data explicitly; do not add runtime compatibility layers.
- C5: JURUC-owned authority errors identify the attempted action, active state, and allowed recovery; ordinary Pi and delegate errors pass through unchanged.
- C6: A new `AGENTS.md` uses the `# Project Contract` section format in this file; updates to an existing context file preserve its established format.

## Assumptions

- A1: Each task runs in a named managed Git worktree whose index JURUC owns.
- A2: Reference repositories are cloned outside managed worktrees.

## Non-Goals

- N1: No PR stage, deployment stage, or per-phase human approval.
- N2: No model-managed dependency graph or file allowlist.
