---
name: suckless
description: Apply the suckless philosophy — simplicity, clarity, frugality — when designing, writing, reviewing, or refactoring software in any language. Use when the goal is minimal, bloat-free tools where removed code is progress.
---

# Suckless

Language-agnostic distillation of the suckless philosophy and the essays it cites.
Inline `[tags]` reference the sources listed at the end.

Use this skill when the aim is small, sharp, maintainable software for advanced users —
where complexity is the enemy and the best change is often a deletion.

## Philosophy

- **Simplicity, clarity, frugality.** These are the goals, in that order. Elegant simple
  design is harder than letting features accumulate ad hoc — do the harder thing.
  [philosophy]
- **Removed lines are progress.** More code is not more skill. "The more code lines you
  have removed, the more progress you have made." Measure work by what you took out.
  [philosophy]
- **Complexity is the root cause.** Bloat drives inconsistency, wasted resources, poor
  performance, and vulnerabilities. Resist it at the source, not with more patches.
  [philosophy]
- **Minimalism finishes.** Staying minimal and clear keeps goals realistic and lets a
  project actually reach completion. [philosophy]
- **Build for experienced users.** Target advanced users ignored by mainstream software.
  Do not add layers to guard against every conceivable misuse. [philosophy]
- **Unix philosophy.** Do one thing well; compose through ordinary interfaces — files,
  stdin/stdout, pipes, flags. [philosophy]
- **Minimal viable program.** A program should be so minimal that removing any part makes
  it useless. Reuse existing infrastructure instead of duplicating it (get timestamps from
  version control; don't build a date feature). Aim for behaviour stable enough to work
  the same in 100 years. [Armstrong]
- **Right-size the tool to the problem.** Do not reach for heavy infrastructure when simple
  composable tools and streaming already solve it. Know your actual bottleneck and weigh
  total cost before adopting a platform. [Drake]
- **Explicit over implicit.** Keep control flow and error paths visible in the code rather
  than hidden behind language machinery. [Sústrik]
- **Fail gracefully.** Handle errors rather than aborting; stay loosely coupled with few
  dependencies; follow established standards; stay portable; don't force heavy dependencies
  on users. [sucks]

## How To Apply

Before writing, state the one thing the tool does. If it does more than one, split or cut.

Prefer deletion and directness:

- Cut features added "just in case" or for hypothetical users. [philosophy, Armstrong]
- Reject abstractions with no current duplication or complexity to justify them.
  [philosophy]
- Reject dependencies that replace only a few clear lines of code, and prefer ones that are
  small, portable, and don't force themselves on users. [sucks]
- Prefer config in source (compile-time) over runtime config machinery when it removes more
  complexity than it adds. [philosophy]
- Reuse existing infrastructure instead of reimplementing it. [Armstrong]
- Keep the public/exported surface small; make internals private by default.
- Avoid cyclic dependencies between modules.
- Use the smallest, most standard subset of the language; avoid clever features and
  extensions. [Sústrik]
- Keep scope tight — short functions, variables declared close to use.
- Comment only the surprising; let straightforward code speak for itself.
- When code has grown tangled, a clean rewrite beats another patch. [philosophy]

When reviewing, count what could be removed before suggesting anything to add. Every added
line must earn its place against the cost of maintaining it. [philosophy]

## Test

Before writing or shipping, answer:

1. Would removing any part make this useless? If not, cut the removable part. [Armstrong]
2. Can I state what this does in one sentence, for one job? [philosophy]
3. Did I remove more than I added, or justify every line I added? [philosophy]
4. Is the tool sized to the actual problem, not a hypothetical one? [Drake]
5. Would an experienced user find this obvious without a manual? [philosophy]
6. Any feature, abstraction, or dependency here only added "in case"? [philosophy]

If (1)–(5) are no or (6) is yes, cut before you commit.

## Sources

- `[philosophy]` — https://suckless.org/philosophy/
- `[sucks]` — https://suckless.org/sucks/
- `[Armstrong]` — "Minimal Viable Program", Joe Armstrong — https://joearms.github.io/published/2014-06-25-minimal-viable-program.html
- `[Drake]` — "Command-line tools can be 235x faster than your Hadoop cluster", Adam Drake — https://adamdrake.com/command-line-tools-can-be-235x-faster-than-your-hadoop-cluster.html
- `[Sústrik]` — "Why should I have written ZeroMQ in C, not C++", Martin Sústrik — http://250bpm.com/blog:4
