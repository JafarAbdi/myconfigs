# Project Contract

## Objective

Run one bounded child-agent trajectory with explicit capabilities, observable cost, and a small authoritative result.

## Requirements

- R1: Every child receives only the tools declared by its agent definition.
- R2: Initial review contexts are fresh and independent.
- R3: Implementation repairs may continue the exact persisted implementation session.
- R4: Audit runs finish with one schema-validated JSON result rather than authoritative prose.
- R5: Before any audit child starts, the extension supplies the deduplicated Pi-discovered context governing each staged changed-file directory.

## Invariants

- I1: Child agents cannot delegate recursively.
- I2: Native runtime differences do not change the normalized parent result.
- I3: Audit findings cite a named phase criterion or governing project-contract item.
- I4: Audit sessions are never continued to validate their own findings.

## Constraints

- C1: Keep the runner process-based and dependency-free beyond Pi's existing runtime.
- C2: Do not rediscover broad project context when the task supplies exact authority and evidence.
- C3: Bound reports placed in the parent context while retaining detailed tool metadata for display.
- C4: Discover audit context through Pi's exported `loadProjectContextFiles()` API, never a nested Pi process or model-guessed path.

## Assumptions

- A1: Pi child sessions can be assigned and resumed by extension-owned session IDs.

## Non-Goals

- N1: No unbounded child-of-child fan-out.
- N2: No workflow planner, chain executor, or global run registry.
- N3: No full-system review hidden inside the change-audit role.
