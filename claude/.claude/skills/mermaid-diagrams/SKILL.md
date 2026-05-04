---
name: mermaid-diagrams
description: >
  Convert descriptions of systems, workflows, sequences, or relationships into ASCII
  diagrams using Mermaid syntax rendered via mermaid-ascii. Use when users ask to "draw",
  "diagram", "visualize", "sketch", or "chart" something as ASCII art using Mermaid notation,
  or when they mention mermaid diagrams, sequence diagrams, or flowcharts in a terminal context.
---

# Mermaid ASCII Diagrams

Render ASCII diagrams from Mermaid syntax using `mermaid-ascii`.

## Quick Start

```bash
echo 'graph LR
A --> B --> C' | mermaid-ascii
```

## Workflow

1. Translate the user's request into valid Mermaid syntax.
2. Write the mermaid code to a temporary file or pipe it to `mermaid-ascii`.
3. Show the ASCII output to the user. If the layout looks off, adjust the Mermaid source and re-render.

### Running the Tool

```bash
# Pipe mermaid code directly:
echo 'graph LR
A --> B --> C' | mermaid-ascii

# Or use a file:
mermaid-ascii -f diagram.mermaid

# With options:
echo 'graph LR
A --> B' | mermaid-ascii -x 8 -p 2
```

## Supported Diagram Types

### Graph / Flowchart

```mermaid
graph LR
A --> B & C
B --> C & D
D --> C
```

Directions: `LR` (left-to-right), `TD` (top-down).

#### Labeled edges

```mermaid
graph LR
A -->|label| B
B --> C
```

#### Multiple arrows on one line

```mermaid
graph LR
A --> B --> C
```

#### `A & B` syntax

```mermaid
graph LR
A --> B & C
```

#### Colored output with `classDef`

```mermaid
graph LR
classDef highlight color:#ff0000
A:::highlight --> B
```

### Sequence Diagrams

```mermaid
sequenceDiagram
Alice->>Bob: Hello Bob!
Bob-->>Alice: Hi Alice!
```

- Solid arrows: `->>`
- Dotted arrows: `-->>`
- Self-messages: `A->>A: Think`
- Participant declarations: `participant A as Alice`

## CLI Options

| Flag | Description | Default |
|---|---|---|
| `-f, --file` | Mermaid file to parse | stdin |
| `-x, --paddingX` | Horizontal space between nodes | 5 |
| `-y, --paddingY` | Vertical space between nodes | 5 |
| `-p, --borderPadding` | Padding between text and border | 1 |
| `--ascii` | Use only ASCII characters (no Unicode box-drawing) | false |
| `-c, --coords` | Show grid coordinates | false |
| `-v, --verbose` | Verbose output | false |

## Layout Tips

- Use `graph LR` for wide horizontal diagrams, `graph TD` for vertical ones.
- Keep node names short — long labels can distort alignment.
- Use `-x` to increase horizontal spacing if nodes overlap.
- Use `-p` to increase box padding for readability.
- For plain ASCII (no Unicode), add `--ascii`.
- Prefer simple graphs. Very complex graphs (>15 nodes) may produce cluttered output.

## Limitations

- No `subgraph` support yet.
- Only rectangle shapes.
- No diagonal arrows.
- Sequence diagrams don't support activation boxes, notes, or loop/alt/opt blocks.
