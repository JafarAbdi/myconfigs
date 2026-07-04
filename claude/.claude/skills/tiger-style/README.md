# Deviations from upstream TigerStyle

`SKILL.md` is [TigerBeetle's TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md),
which is Zig-specific, adapted for use across any language. Two changes from upstream; the rest is verbatim.

- **Language-agnostic note** (top of file): read Zig syntax/tooling rules as "apply your language's
  equivalent"; the manual-memory rules apply only to systems languages.
- **SI units** (Naming): omit the suffix for SI base units (meters, seconds, kilograms, radians)
  when the codebase assumes SI; suffix only non-SI units (`latency_ms`, `angle_deg`). See
  `robotics-conventions` §3.
