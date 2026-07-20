---
name: ascii-diagrams
description: ALWAYS use when the user asks to create, draw, or revise an ASCII or Unicode text diagram. Generate Mermaid source, render it with mermaid-ascii, and return the rendered terminal diagram.
---

# ASCII diagrams

Use `mermaid-ascii` as the renderer for text diagrams.

1. Express the requested diagram as the smallest supported Mermaid diagram: flowchart, sequence, state, class, or entity-relationship.
2. Render through stdin:

   ```sh
   mermaid-ascii --width 80 <<'EOF'
   flowchart LR
     A[Input] --> B[Output]
   EOF
   ```

3. Return the exact rendered Unicode output in a fenced `text` block.
4. Keep the Mermaid source available when the user asks to edit, reproduce, or inspect the diagram.
5. If output falls back to framed source, simplify unsupported Mermaid syntax and render again. Never hand-edit rendered box-drawing output.
6. Use `--width` to fit the user's target. Default to 80 columns when no width is given.

If `mermaid-ascii` is unavailable, say so rather than claiming generated output came from it.
