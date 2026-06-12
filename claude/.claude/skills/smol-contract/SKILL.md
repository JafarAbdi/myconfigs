---
name: smol-contract
description: Apply the Smol Contract philosophy when scoping, designing, reviewing, or simplifying software. Use for focused, composable, single-person-maintainable, finishable tools and systems.
---

# Smol Contract

Based on https://bower.sh/smol-contract.

Use this skill when designing, implementing, reviewing, or simplifying software that should stay
focused, composable, and human-scale.

## Contract

Software that follows the Smol Contract is:

- **Well-defined**: solves one problem that can be stated in one sentence.
- **Expected**: behaves the way users familiar with the platform or ecosystem would expect.
- **Single-person maintainable**: can be understood, modified, and owned by one developer.
- **Composable**: works with other tools through ordinary interfaces such as files, stdin/stdout,
  HTTP, CLI flags, and environment variables.
- **Finishable**: has a clear state where the work is complete.

## How To Apply

Before implementation, state the one-sentence problem and the completion condition. If either is
unclear, ask for clarification or narrow the scope.

Prefer the smallest design that satisfies the contract:

- Use conventional interfaces before custom protocols.
- Use direct code before speculative abstractions.
- Use standard tooling and current idioms for the language or ecosystem.
- Add dependencies only when they remove more complexity than they introduce.
- Organize code around clear responsibilities that a new maintainer can find quickly.

When reviewing or refactoring, push back on:

- Features added just in case.
- Abstractions without current duplication or complexity to justify them.
- Dependencies that replace only a few clear lines of code.
- Interfaces that require project-specific lore to understand.
- Documentation that needs a diagram before the basic purpose is clear.

## Test

Before writing or reviewing code, answer:

1. Can I explain what this does in one sentence?
2. Could a developer unfamiliar with this project maintain it within a week?
3. Can this be used as a building block in a pipeline or larger system?
4. Is there a clear definition of complete?

If any answer is no, revisit the design before writing code.
