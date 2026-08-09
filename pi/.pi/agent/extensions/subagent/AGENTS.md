# Project Contract

## Objective

Run one child-agent trajectory with explicit capabilities, observable cost, and an authoritative text
result.

## Requirements

- R1: Every child receives only the tools declared by its agent definition.
- R2: Every initial run starts with fresh, independent conversation state.
- R3: A role may resume only when its definition declares `continuable: true`, using the exact
  extension-owned persisted runtime session from the prior invocation.
- R4: Every role returns ordinary Markdown or text through the same normalized result path without
  runner-imposed size limits.
- R5: Pi and native Claude invoke configured roles through name-independent runtime paths.

## Invariants

- I1: Child agents cannot delegate recursively.
- I2: Native runtime differences do not change the normalized parent result.
- I3: Runner behavior depends on declared capabilities and invocation state, never configured agent
  names.
- I4: Reloading a role without its continuation capability prevents further resumption.
- I5: The runner does not truncate or reject child protocol, diagnostics, reports, or step history
  based on extension-defined size or count limits.

## Constraints

- C1: Keep the runner process-based and use the existing Pi and native Claude CLIs.
- C2: Preserve explicit tool fences and skill control for both runtimes.
- C3: Presentation-only previews may be shortened; child protocol, diagnostics, reports, and step
  history remain untruncated.
- C4: Preserve rich progress, usage accounting, and cancellation.

## Assumptions

- A1: Pi child sessions can be assigned and resumed by extension-owned session IDs.
- A2: Native Claude print-mode sessions can be assigned and resumed by extension-owned session IDs.

## Non-Goals

- N1: No unbounded child-of-child fan-out.
- N2: No workflow planner, chain executor, or global run registry.
- N3: No role-specific output protocol or runner policy.
