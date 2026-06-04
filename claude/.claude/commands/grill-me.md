---
description: Grill the user relentlessly on a target (branch / PR / diff / plan doc) — tough questions, behavior proof, rewrite if hacky.
argument-hint: "[target: empty=current branch vs main | PR# | git-range | path/to/PLAN.md | path/to/file]"
---

Interview the user relentlessly until shared understanding is reached. Walk the decision tree, resolving dependencies one-by-one. Ask **one question at a time**, each with your recommended answer. If a question can be answered by exploring the codebase, explore instead of asking.

## Resolve the target

`$ARGUMENTS` selects what to grill. Detect type:

| Input | Target | How to load |
|---|---|---|
| empty | current branch vs `main` | `git diff main...HEAD`, `git log main..HEAD` |
| `123` or `#123` or PR URL | GitHub PR | `gh pr view <n>`, `gh pr diff <n>` |
| `abc..def` / `abc...def` / single SHA | git range/commit | `git diff <range>`, `git log <range>` |
| path ending `.md` / `.txt` (e.g. `PLAN.md`, `RFC.md`) | plan/design doc | `Read` the file |
| any other existing path | file or dir | `Read` the file, or list+read the dir |
| arbitrary text | freeform plan | Treat `$ARGUMENTS` itself as the plan to grill |

If ambiguous, ask the user once which interpretation, then proceed.

## Process

1. **Load the target.** Form a mental model of *what* it proposes/changes and *why* before asking anything.

2. **Grill.** Tough questions, one at a time, recommended answer included:
   - Edge cases not covered
   - Potential bugs, races, off-by-ones
   - Design decisions (why this shape, why now, what alternatives died)
   - Code smells, quick-fix patches vs. root-cause fixes, shallow modules, leaky abstractions
   - For plan docs: unstated assumptions, missing failure modes, scope creep, success criteria
   - Tests (if code): verify behavior or implementation? Survive refactor?

3. **Prove it.** For code targets, diff *behavior* — run affected paths before/after, show outputs. For plan targets, walk a concrete worked example end-to-end. "Looks right" is not proof.

4. **Rewrite if mediocre.** If the work is hacky or shallow given everything learned, scrap and propose the elegant version. Consider `improve-codebase-architecture` and `tdd` skills.

5. **No PR / no commit-to-plan until done.** Do not open a PR, merge, or freeze the plan until grilling is complete and both sides are confident.
