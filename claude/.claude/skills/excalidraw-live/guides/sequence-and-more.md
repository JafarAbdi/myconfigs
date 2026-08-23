# Guide: sequence / class / ER / state / gantt — use mermaid

The `spec` covers node-and-edge diagrams (flow, architecture). For diagram *kinds* with
other grammar — **sequence, class, ER, state, gantt, journey** — write mermaid and use
`ex mermaid <name>`.
It's laid out by mermaid and lightly restyled to match the house look.

Sequence (interactions over time):
```
sequenceDiagram
  participant U as User
  participant A as API
  participant D as DB
  U->>A: POST /login
  A->>D: check credentials
  D-->>A: ok
  A-->>U: token (200)
```

State machine (prefer the spec for a small graph with the house palette; use mermaid for
many states):
```
stateDiagram-v2
  [*] --> Idle
  Idle --> Loading: fetch
  Loading --> Ready: ok
  Loading --> Error: fail
  Error --> Idle: retry
```

Rules of thumb:
- Sequence / gantt / journey / class / ER → mermaid (their layout is the point).
- Flowchart / architecture / small state machine → `ex draw` spec (house palette by `kind`,
  native groups inside single-level frames, and `ex patch` for edits).
- After `ex mermaid`, Read the PNG and check labels aren't truncated.
