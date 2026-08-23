# Guide: system / architecture diagram

Boxes for components, arrows for data/requests, frames for layers. Use `ex draw` with a `spec`.

- `direction`: `"right"` (request flows left→right) is the default; `"down"` for a tall stack.
- Pick `kind` by role so the diagram is legibly multi-color:
  - `actor` — a client/user/caller (browser, mobile app, CLI).
  - `service` — an app/server/component doing work.
  - `store` — database, cache, queue, bucket (anything holding data).
  - `external` — a third-party/outside system (Stripe, an upstream API).
  - `decision` — a router/gateway that branches.
- Use `groups` for inner subsystems that should move as native Excalidraw groups. The compiler
  supplies each group's labeled background; put a component in at most one group.
- Use `frames` for outer layers or boundaries. A frame's `members` may contain complete group IDs
  and ungrouped node IDs. Keep frames single-level; never nest frames or include only part of a
  group.
- Edge endpoints can be node, group, or frame IDs. Use frame endpoints for relationships
  crossing frame boundaries. Within one frame, target groups for subsystem interactions and
  nodes for detail.
- Label edges with the interaction ("query", "publish", "webhook") and use
  `style:"dashed"` for async.

Pattern:
```json
{ "schemaVersion":2,"type":"flow","direction":"right",
  "nodes":[
    {"id":"web","label":"Web App","kind":"actor"},
    {"id":"api","label":"API","kind":"service"},
    {"id":"worker","label":"Worker","kind":"service"},
    {"id":"db","label":"Postgres","kind":"store"},
    {"id":"q","label":"Queue","kind":"store"},
    {"id":"pay","label":"Stripe","kind":"external"}],
  "groups":[
    {"id":"services","label":"Services","nodes":["api","worker"]},
    {"id":"data","label":"Data","nodes":["db","q"]}],
  "frames":[
    {"id":"backend","label":"Backend","members":["services","data"]}],
  "edges":[
    {"id":"web-backend","from":"web","to":"backend","label":"HTTPS"},
    {"id":"api-db","from":"api","to":"db","label":"query"},
    {"id":"api-q","from":"api","to":"q","label":"enqueue","style":"dashed"},
    {"id":"q-worker","from":"q","to":"worker","label":"consume","style":"dashed"},
    {"id":"backend-pay","from":"backend","to":"pay","label":"charge"}]}
```
Building something real? `ex capture --url http://localhost:PORT` to see it, or
`ex import` to trace its layout.
