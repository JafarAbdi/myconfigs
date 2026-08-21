---
name: lovely-mermaid
description: Render Mermaid as ASCII-style Unicode terminal diagrams. Use for text diagrams, architecture diagrams, flowcharts, and state, class, ER, sequence, pie, mindmap, timeline, or gitGraph diagrams in plain-text output.
disable-model-invocation: true
compatibility: Requires Deno. The first render requires network access to cache lovely-mermaid.
---

# Lovely Mermaid

Turn a diagram request into Mermaid source and render it with `lovely-mermaid`.
The renderer's output is the artifact.

## Rules

- Use only `graph`/`flowchart`, `stateDiagram`, `classDiagram`, `erDiagram`,
  `sequenceDiagram`, `pie`, `mindmap`, `timeline`, or `gitGraph`. Offer a flowchart or
  sequence diagram for unsupported kinds.
- Write the smallest source that preserves the requested entities and relationships.
- Use short, plain-text labels. Feel free to use supported structure: subgraphs, node
  shapes, edge labels, sequence activations, and CJK text all render correctly.
- Avoid directives, HTML, and click actions. Class/style definitions parse but do not
  show in plain output, so skip them unless the source is also read as Mermaid.
- Render after each source change. Verify the output; never draw or patch it by hand.
- Keep diagrams within the user's width limit, or 100 columns by default. Prefer `TD` for
  narrow layouts and `LR` for short linear flows.
- Treat warnings as advisory, but inspect them for missing or misread content.
- Return stdout unchanged in a fenced `text` block. Include Mermaid source only when asked.

## Render

Resolve `scripts/render.ts` relative to this file. In the personal install:

```sh
~/.claude/skills/lovely-mermaid/scripts/render.ts diagram.mmd
~/.claude/skills/lovely-mermaid/scripts/render.ts < diagram.mmd
```

The script accepts a file or stdin. It writes the diagram to stdout and its width and
warnings to stderr. If the result is unclear or too wide, change the Mermaid source and
render again.
