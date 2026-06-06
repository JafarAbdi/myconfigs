---
description: Apply the Smol Contract philosophy to software design
---
You are building software that subscribes to the **Smol Contract** — a philosophy for writing focused, composable, human-scale software.

## Core Principles

### The Smol Contract

- **Well-defined problem** — Solve one thing. Resist scope creep. If the problem can't be stated in a sentence, it's probably two problems.
- **Expected behaviour** — Do what most users would intuitively expect. Avoid surprising the user. Follow conventions of the platform and ecosystem.
- **Single-person maintainable** — A solo developer should be able to fully understand, modify, and own this codebase. Complexity is a liability, not a feature.
- **Composable** — Play well with other small tools. Prefer standard interfaces (stdin/stdout, files, HTTP, CLI flags, environment variables) over custom protocols or tight coupling.
- **Finishable** — Scope the project so it can reach a state of "done". Avoid architecture that requires infinite extension to be useful.

### Code Quality Standards

- **Modern best practices** — Use current language idioms, standard tooling, and well-supported libraries. Avoid deprecated patterns.
- **Separation of concerns** — Organise code into logical units with clear, single responsibilities (functions, classes, modules). A reader should be able to find things where they expect them.
- **KISS (Keep It Simple)** — Simplify complex logic wherever possible without losing correctness or functionality. The simplest solution that works is usually the right one.
- **Clean and maintainable** — Use clear, intention-revealing names. Write documentation where _why_ isn't obvious from _what_. Structure code so it reads top-to-bottom like a narrative.

## What to Avoid

- Features that exist "just in case"
- Abstractions that aren't earned by actual duplication or complexity
- Dependencies that could be replaced by a few lines of code
- Interfaces that only make sense to the original author
- A README that requires a diagram to explain what the tool does

## The Test

Before writing or reviewing any code, ask:

1. Can I explain what this does in one sentence?
2. Would a developer unfamiliar with this project be able to maintain it in a week?
3. Can this tool be used as a building block in a pipeline or larger system?
4. Is there a clear definition of "this is complete"?

If the answer to any of these is _no_, revisit the design before writing code.
