---
name: mermaid-flow
description: Create and edit Mermaid flowchart diagrams in the human's live Mermaid Flow editor. Use for flowcharts, architecture/system diagrams, and any node-and-edge diagram the human keeps as a .mmd file. The diagram IS plain mermaid text — you read it whole and change it with targeted text edits; changes appear live in the human's browser and render anywhere mermaid does.
compatibility: Requires a Mermaid Flow server at MERMAID_FLOW_URL (default https://server.tail79ed4.ts.net:9447). Node 18+.
---

# Mermaid Flow

Diagrams are plain `.mmd` files the human edits visually in a live canvas. You
edit the same text through the `mmd` CLI (resolve `scripts/mmd` relative to
this file). Five verbs — there is nothing else:

```sh
mmd docs         # list documents
mmd new <doc>    # create one
mmd text [doc]   # print the whole .mmd — filter locally (grep/sed/nl)
mmd edit [doc]   # JSON on stdin: [{"oldText":"…","newText":"…"}, …]
mmd shot [doc]   # PNG of the live canvas → prints a path — Read it
```

`edit` works like your Edit tool: each `oldText` must match the current text
**exactly once** (else it's rejected with the match count — add context);
edits must not overlap; all-or-nothing. The result must parse as a flowchart
or **nothing changes**. Every accepted edit is one undo step for the human.
Don't edit the files on disk directly — `mmd edit` is serialized against the
human's live drags; a raw file write can race one.

## Loop
1. `mmd text <doc>` — read it.
2. `mmd edit <doc>` — targeted changes.
3. `mmd shot <doc>` and **Read the PNG** — that is how you see your work.

## The file format
Everything is standard mermaid flowchart syntax:

```
flowchart TD
  api["API Server"] -->|login| db(Sessions)
  ok{Valid?} -.->|no| err[401]
  subgraph backend[Backend]
    direction LR
    api
    db
  end
  contract --> backend
  style api fill:#ede9fe,stroke:#7c3aed,color:#111827
%% pos api=294,120 db=294,224 err=470,224 ok=120,224
%% edge api->db 380,170
```

- **Nodes**: `id[Label]` rect · `id(Label)` round · `id([Label])` stadium ·
  `id{Label}` diamond (decisions — `Question?` with `yes`/`no` edge labels) ·
  `id((Label))` circle. Ids `[A-Za-z0-9_-]+`; quote labels with special chars
  (`id["a | b"]`); `<br/>` = line break.
- **Edges**: `-->` arrow · `---` line · `-.->` dotted · `==>` thick ·
  `<-->` both heads; label via `-->|text|`. Endpoints may be **group ids**
  (`contract --> backend`).
- **Groups**: `subgraph id[Title] … end`; nest by nesting the blocks. A bare
  `id` line inside a subgraph captures an existing node into it. Optional
  `direction LR|TB` per group.
- **Colors**: `style <id> fill:#…,stroke:#…,color:#111827` (works on nodes AND
  group ids). House palette (fill/stroke): blue `#dbeafe/#2563eb` actors ·
  purple `#ede9fe/#7c3aed` services · teal `#ccfbf1/#0f766e` stores · green
  `#dcfce7/#16a34a` success · orange `#ffedd5/#ea580c` external · red
  `#fee2e2/#dc2626` errors · grey `#f3f4f6/#6b7280` notes. Mix them.

## Layout: the `%% pos` / `%% edge` comment lines
Mermaid ignores `%%` comments, so files render anywhere; the canvas uses them
for manual layout. **These are the human's hand-placed positions — edit them
only for elements you add or are asked to move.**

- `%% pos id=x,y id=x,y …` — one line, tokens **sorted alphabetically**;
  `x,y` = the node's **centre** in pixels (y grows down). Groups have no
  token (their boxes derive from members). **When you add a node, add its
  token too**, placed near its neighbours (typical node ≈ 150×44; leave
  ~60px gaps). A node without a token gets grid-placed, which looks bad.
- `%% edge from->to x1,y1;x2,y2` — manual bend points for one arrow, in
  order. Straight arrows need no line. `from->to#2` = the second duplicate
  arrow between the same pair (in file order).
- A brand-new document with **no** `%% pos` line at all gets one automatic
  dagre layout on first load — so for a whole generated diagram, write just
  the mermaid body and let the server place everything.

## Rules
- **The human's layout is sacred**: never rewrite `%% pos` tokens or `%% edge`
  bends you didn't add, never reorder or reformat lines you aren't changing.
  Keep edits minimal and targeted, exactly like editing code.
- A rejected edit changed nothing — read the error, fix, retry once; if it
  still fails, show the human the error instead of trying variations.
- The human sees your edits live and can Ctrl+Z any of them; their drags land
  in the same per-document history.
- If the server is unreachable, say so — do not fall back to editing files.
