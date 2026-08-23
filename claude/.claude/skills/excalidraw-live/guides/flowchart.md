# Guide: flowchart / process flow

A sequence of steps with branches. Use `ex draw` with a `spec`.

- `direction`: `"down"` for a decision-heavy flow that grows tall; `"right"` for a short
  linear pipeline.
- Start with a `start` node and end with `success`/`error` terminals so entry/exit read at
  a glance.
- Every branch is a `decision` node whose label is a **yes/no question** ("Valid token?"). Label its
  outgoing edges `yes`/`no`. Use `style:"dashed"` on the failure/negative branch.
- Steps are `process` (default). A step that talks to storage is `store`; an outside
  system is `external`.
- Keep labels ≤ 3 words. One idea per node. Use a native `group` for a named subprocess;
  use a `frame` only for a real outer boundary.

Pattern:
```json
{ "schemaVersion":2,"type":"flow","direction":"down",
  "nodes":[
    {"id":"start","label":"Begin","kind":"start"},
    {"id":"check","label":"Input valid?","kind":"decision"},
    {"id":"work","label":"Process","kind":"process"},
    {"id":"ok","label":"Done","kind":"success"},
    {"id":"bad","label":"Reject","kind":"error"}],
  "edges":[
    {"id":"start-check","from":"start","to":"check"},
    {"id":"check-work","from":"check","to":"work","label":"yes"},
    {"id":"check-bad","from":"check","to":"bad","label":"no","style":"dashed"},
    {"id":"work-ok","from":"work","to":"ok"}]}
```
Iterate with `ex patch` (add-node / add-edge) rather than resending. Always Read the PNG and check
no labels collide.
