---
name: excalidraw-live
description: Create good-looking Excalidraw diagrams on a shared live canvas from a high-level semantic spec. Use for flowcharts, architecture/system diagrams, state machines, and any node-and-edge diagram; also renders mermaid (sequence, class, ER, gantt). You describe nodes/edges/kinds — the server does layout and styling. Diagrams appear live in the human's Excalidraw canvas.
compatibility: Requires the Excalidraw Live server at EXCALIDRAW_LIVE_URL (defaults to the tailnet deployment) and its canvas tab open in a browser. Node 18+.
---

# Excalidraw Live

You and the human share one live canvas. You **describe** a diagram (nodes/edges/kinds); the server
**lays it out (elkjs) and styles it (house theme)** and renders into the human's open canvas. Don't
write coordinates or colors on a fresh draw — that's the server's job (and what stops hand-authored
Excalidraw from looking ugly).

Use the `ex` CLI (resolve `scripts/ex` relative to this file) — it talks to the server; never curl
the API.

```sh
ex url              # canvas URL — the human must have it open
ex state            # open doc, entities (+x,y,w,h), human's selection, scene bounds, vocab
ex ls               # list diagrams
ex draw <name>      # compile a spec (JSON on stdin) → renders, saves a PNG
ex patch <name>     # apply delta ops (JSON on stdin) in place
ex mermaid <name>   # render mermaid text (stdin) → PNG
ex export <name>    # high-res PNG of the CURRENT canvas [--scale 1-4=2] [--ids a,b | --selection]
ex show <name>      # re-save the last render PNG (stale after hand-edits)
ex spec <name>      # print the derived spec JSON
ex capture --url U  # screenshot a URL [--full | --selector CSS | --clip x,y,w,h] [--to <name>]
ex import <name> --url U    # crawl a page into EDITABLE boxes+text
ex rm <name>        # delete (open another doc first)
```

## Loop
1. New doc: write a spec, `ex draw <new-name>` once (existing names are rejected — protects the human's layout).
2. **Read the printed PNG** — that's how you see your work.
3. All later changes via `ex patch`.

Before an unfamiliar diagram kind, read a playbook: `ex guide` lists them, `ex guide <name>` prints
one (`flowchart`, `architecture`, `sequence-and-more`) — the kinds/layout to use + a worked example.

## Spec (`ex draw`, JSON on stdin)
```json
{
  "schemaVersion": 2,
  "type": "flow",
  "direction": "right",
  "nodes": [
    { "id": "user", "label": "User", "kind": "actor" },
    { "id": "api",  "label": "API Server", "kind": "service" },
    { "id": "ok",   "label": "Valid token?", "kind": "decision" },
    { "id": "db",   "label": "Sessions", "kind": "store" },
    { "id": "deny", "label": "401 Unauthorized", "kind": "error" }
  ],
  "groups": [ { "id": "auth", "label": "Authentication", "nodes": ["api", "ok", "deny"] } ],
  "frames": [ { "id": "backend", "label": "Backend", "members": ["auth", "db"] } ],
  "edges": [
    { "id": "login", "from": "user", "to": "backend", "label": "login" },
    { "id": "valid", "from": "ok", "to": "db", "label": "yes" },
    { "id": "invalid", "from": "ok", "to": "deny", "label": "no", "style": "dashed" }
  ]
}
```
- `schemaVersion`: `2` (required). `direction`: `"right"` (default) or `"down"`.
- `nodes[].id`: stable — keep unchanged across patches. `kind`: shape+color (below), omit → `process`.
- `groups`: native Excalidraw groups (labeled background + members); a node is in ≤1 group.
- `frames`: single-level boundaries; `members` = whole group IDs or ungrouped node IDs. Never list one
  node of a group (use the group ID), never nest frames.
- `edges[].id`: required, stable. `from`/`to`: any node/group/frame ID (a cross-frame edge uses the
  frame ID on that side). `style`: `dashed | dotted | thick`.

Nested structure = a native `group` per subsystem + one outer `frame` listing those groups. Never
nest frames or split a group across a frame.

## kinds (mix them — don't make it one flat color)
| kind | shape | use for |
|------|-------|---------|
| `actor` | box (blue) | a person/client initiating something |
| `service` | box (purple) | an app/service/component doing work |
| `process` | box (indigo) | a generic step (default) |
| `store` | box (teal) | a database/cache/queue/file — holds data |
| `decision` | diamond (yellow) | a branch; label it `Question?` |
| `external` | box (orange) | a third-party/outside thing |
| `start`/`end` | pill (green/purple) | flow entry/exit |
| `input`/`output` | pill (green) | data in/out |
| `success` | box (green) | positive terminal state |
| `error` | box (red) | failure/rejection state |
| `note` | box (gray) | an aside/annotation |

Keep labels short. A decision asks a yes/no question with labeled `yes`/`no` edges.

## ex state
Open `doc`; every node/group/frame with `x,y,width,height`; `selection` (`nodes`/`groups`/`frames`
— use for "this"/"the selected one"); scene `bounds` (occupied rectangle → where free space is);
`vocab`.
```json
{ "doc":"loginflow", "canvasConnected":true,
  "selection":{"nodes":["ok"],"groups":["auth"],"frames":[],"all":["ok","auth"]},
  "nodes":[{"id":"ok","label":"Valid token?","kind":"decision","x":320,"y":80,"width":160,"height":60}, ...],
  "bounds":{"minX":0,"minY":0,"maxX":700,"maxY":400},
  "vocab":{"kinds":["actor","service",...],"edgeStyles":["dashed","dotted","thick"]} }
```

## ex patch (delta ops on stdin)
The spec is derived from the live scene, ops are applied, and the change renders **in place** — only
what you name changes; no relayout, no regeneration. `ex patch` echoes `placed: <id> @ (x,y) w×h` so
you needn't re-read state.

Structural ops: `add-node`, `update-node`, `remove-node`, `add-edge`, `remove-edge`, and
`add/update/remove-group`, `add/update/remove-frame`. Removing an entity also drops its dangling
edges + emptied containers. `set-direction` is rejected (would relayout).

Placement is yours, not the app's:
- **Relative (preferred)** — no math, no pre-read: `{"op":"add-node","node":{...},"place":{"rightOf":"api","gap":80}}`.
  Relations `rightOf | leftOf | above | below` (an id) or `rightOfAll:true`; `gap` default 40.
- **Move:** `{"op":"move-node","id":"cache","place":{"below":"db"}}` — label follows, container
  re-wraps, arrows re-route; nothing else moves.
- **Absolute (escape hatch):** `"x":900,"y":120`. Omit both `place` and `x,y` on add-node → auto to the right.

```sh
echo '[
  {"op":"add-node","node":{"id":"cache","label":"Redis","kind":"store"},"place":{"rightOf":"api"}},
  {"op":"add-edge","edge":{"id":"api-cache","from":"api","to":"cache","style":"dashed"}},
  {"op":"update-node","id":"ok","kind":"error","label":"Denied"}
]' | ex patch loginflow
```

## Seeing the canvas
- **Your own diagram → `ex export <name>`**: high-res PNG of the current canvas, framed, `--scale 1-4`
  (default 2). Crop with `--ids a,b` (a group id pulls in its cluster) to zoom into a dense diagram,
  or `--selection` for what the human selected. `ex show` = last render (faster, stale after hand-edits).
- **External page → `ex capture --url U`**: `--full`, `--selector CSS`, `--clip x,y,w,h`, `--to <name>`.
  (Don't `ex capture` your own canvas — it's a raw viewport shot with app chrome.)
- **`ex import <name> --url U`**: crawl a page into *editable* boxes+text (vs capture's flat picture).

## Mermaid (secondary)
For sequence/class/ER/state/gantt: write mermaid, `ex mermaid <name>`. Prefer `ex draw` for
flow/architecture (house palette by `kind` + layout control).

## Notes
- **Scene = single source of truth.** No stored spec — it's derived from the live canvas every time,
  so `ex state` always matches what's drawn. The human's edits (including deleting boxes/arrows) always
  save and **stick**; a hand-deleted box won't return on patch — recover it from the doc's history
  directory, not by re-drawing.
- Exactly one canvas tab open for agent ops (zero/multiple are rejected). Diagrams persist as
  `.excalidraw` files in the vault.
