---
description: Review branch changes, refactoring plans, or specification changes
argument-hint: "[changes|plan <plan-file>|spec <spec-file>]"
---
Review $ARGUMENTS.

Determine the review mode before starting:

- `changes` or no arguments: review the current branch compared to main.
- `plan <plan-file>`: review the plan file against the actual codebase.
- `spec <spec-file>`: review changes to the specification file compared to main.

If the mode or required file is ambiguous, ask for clarification before reviewing.

For every mode:

1. Read the relevant sources before judging.
2. Cross-reference the review target against the actual codebase and branch diff.
3. Grill me with tough questions about edge cases, failure modes, design decisions, hidden assumptions, and trade-offs.
4. Point out anything that feels hacky, hand-wavy, underspecified, incomplete, inconsistent, or like a quick fix rather than a proper solution.
5. Prove the review with concrete scenarios grounded in real code paths, behavioral diffs, or explicit specification examples.
6. Stop after the review and questions unless I explicitly ask you to continue.

Do not make a PR, start implementation, or rewrite the target until we have gone through this process and the result is something we are both confident in.

## Mode: changes

Review the changes in my current branch compared to main.

First, grill me on these changes. Ask tough questions about edge cases, potential bugs, design decisions, failure modes, and code smells. Identify areas that seem like quick fixes rather than proper solutions.

Then, prove what changed by diffing behavior between main and this feature branch. Show concrete examples of changed behavior, not just code differences.

Once you have thoroughly analyzed everything and I have answered your questions, if the current implementation is mediocre or hacky, scrap it and implement the most elegant solution knowing everything you now know about the codebase and requirements.

## Mode: plan

Review the plan file and cross-reference it against the actual codebase.

First, grill me on this plan. Ask tough questions about edge cases, potential failure modes, design decisions, hidden assumptions, and places where the plan glosses over complexity.

Critically, check the code for things the plan misses:

- callers that would break
- related modules that need changes
- existing patterns the plan ignores or contradicts
- tests that would need updating
- dependencies the plan does not account for
- edge cases visible in the code but absent from the plan

Then, prove whether the plan is sound by walking through concrete scenarios. Show how specific cases would play out under the proposed approach, including awkward cases such as migration paths, backward compatibility, error states, and performance under load when relevant. Ground these scenarios in real code paths, not hypotheticals.

Once you have thoroughly analyzed everything and I have answered your questions, if the plan is mediocre, hacky, or incomplete, scrap it and propose the most elegant approach knowing everything you now know about the codebase and requirements.

## Mode: spec

Review the changes to the specification file in my current branch compared to main.

First, grill me on these specification changes. Ask tough questions about:

- Ambiguities: where the spec is unclear or open to interpretation.
- Edge cases: what scenarios are not covered and what happens at the boundaries.
- Inconsistencies: whether parts contradict each other or existing behavior.
- Completeness: what is missing and which assumptions are implicit but undocumented.
- Design decisions: why this approach over alternatives and which trade-offs we are accepting.

Point out areas that feel hand-wavy, underspecified, or like we are deferring hard decisions rather than making them.

Then, prove whether the spec is solid by:

- diffing the behavioral expectations between main and this branch
- walking through concrete examples of how the system should behave under the new spec
- identifying breaking changes or migration concerns

Once you have thoroughly analyzed everything and I have answered your questions, if the current specification is incomplete, inconsistent, or poorly structured, propose a rewrite that captures everything we have discussed: the clearest, most complete version of this spec knowing everything you now know about the requirements and edge cases.
