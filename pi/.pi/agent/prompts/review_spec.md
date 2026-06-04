---
description: Review changes to a specification file in current branch compared to main
argument-hint: "<spec-file>"
---
**Review the changes to $1 in my current branch compared to main.**

First, grill me on these specification changes - ask tough questions about:

- **Ambiguities**: Where is the spec unclear or open to interpretation?
- **Edge cases**: What scenarios aren't covered? What happens at the boundaries?
- **Inconsistencies**: Do any parts contradict each other or existing behavior?
- **Completeness**: What's missing? What assumptions are implicit but not documented?
- **Design decisions**: Why this approach over alternatives? What trade-offs are we accepting?

Point out any areas that feel hand-wavy, underspecified, or like we're deferring hard decisions rather than making them.

Then, prove to me this spec is solid by:

- Diffing the behavioral expectations between main and this branch
- Walking through concrete examples of how the system should behave under the new spec
- Identifying any breaking changes or migration concerns

Once you've thoroughly analyzed everything and I've answered your questions, if you find the current specification is incomplete, inconsistent, or poorly structured, propose a rewrite that captures everything we've discussed - the clearest, most complete version of this spec knowing everything you now know about the requirements and edge cases.

Don't consider this spec ready for implementation until we've gone through this process and the specification is something we're both confident fully describes the intended behavior.
