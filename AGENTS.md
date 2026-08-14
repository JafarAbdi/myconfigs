# Code style

**Follow every rule below automatically on each code change, without being asked. These are hard rules, not suggestions.**

Before finishing an edit:
1. Re-check each file you touched against the sections below.
2. Never break a rule silently — if one genuinely can't apply, state which and why.
3. End the reply with one line: `Style: clean` or `Style: deviated — <rule>: <reason>`.

## Fail loud, never degrade silently
- Propagate errors or exit — no fallbacks, no silent degradation.
- Validate preconditions before side effects: fail before you create, write, or publish, not after.
- Never persist a silently-wrong value — surface a visible warning instead.

## Never infer structure from text
- Detect a missing resource by its typed absence, not by matching error-message text.
- Accept structured input only through a validated schema, never by parsing prose.
- Deserialize persisted state once, then validate fields and name exactly what is wrong.
- Consume another tool's human-facing output verbatim; never parse it for control flow.
- Never parse or classify command strings to decide what they do.

## Make invalid states unrepresentable
- Model data so bad states can't be built — a closed set of variant shapes beats one wide record whose fields are only valid in certain combinations.
- Handle every case explicitly; avoid catch-all defaults, so a new variant breaks the build or a test instead of slipping through.
- Make the risky path the one you have to name: the safe/total operation is the default, the fallible or throwing variant is explicitly named.
- Enforce boundaries with visibility and types, not convention — route access through one entry point and make bypassing it fail to compile, don't just discourage it.

## Subprocess discipline
- Pass command arguments as a list and input over stdin, never as an assembled shell string.
- Never sleep, busy-wait, or poll to synchronize — in code or in tests. Block on the right synchronization primitive (or restructure) so it fires when the work is actually done.

## Simplicity
- Simplest implementation that meets today's requirements — no speculative abstraction, config, or indirection.
- Grow in working layers; never trade a working product for unfinished complexity.
- Fix problems at the source — change the earliest stage that can address the root cause, not downstream symptoms; the more central the code, the more scrutiny a change needs.
- No backward-compat layers, fallbacks, or migrations — this project has no released API, so delete obsolete paths.
- Reuse existing dependencies and platform APIs before adding or reimplementing — check their docs first.
- Brevity, and one way of doing things — prefer a single implementation file; refactor rather than accumulate.
- Keep edits local — a change should stay near the code it affects, not fan out across the tree; keep definitions discoverable by name.
- Keep components modular, with concerns separated.
- Decide for the long term — no stopgaps meant to be replaced.
