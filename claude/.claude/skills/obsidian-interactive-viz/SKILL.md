---
name: obsidian-interactive-viz
description: Write the JavaScript that goes inside ```interactive code blocks in Obsidian notes. The `interactive` block is a custom Obsidian plugin fence that executes JS at render time with JSXGraph and Three.js preloaded, plus a small helper API. Use when the user asks to add an interactive viz to an Obsidian note, write an `interactive` block, visualize a concept (math, signal processing, embeddings, physics) inside Obsidian, or port an HTML visualization into an `interactive` block.
---

# `interactive` Obsidian code blocks

The `interactive` fence type runs arbitrary JavaScript at render time inside an Obsidian note. It's a custom plugin fence — not built into Obsidian. The runtime preloads **JSXGraph** (2D plots, sliders, geometric constructions) and **Three.js r147 + OrbitControls** (3D WebGL) and shims MathJax so LaTeX works inside JSXGraph labels.

This skill covers the code that goes **inside** the fence. It does not cover installing or modifying the plugin itself — assume it's already installed.

## Shape of a block

```markdown
\`\`\`interactive
// arbitrary JS, runs inside an async IIFE (top-level await works)
const board = initBoard(container.createEl("div"));
board.create("functiongraph", [x => Math.sin(x)],
  { strokeColor: "#3b82f6", strokeWidth: 2 });
\`\`\`
```

## Injected parameters (available in every block)

| Name | Type | Purpose |
|------|------|---------|
| `container` | `HTMLDivElement` | Empty div to render into. Already inserted in the note. |
| `ctx` | `MarkdownPostProcessorContext` | Obsidian context — has `sourcePath` etc. |
| `initBoard(target, opts?)` | function | Theme-aware JSXGraph board factory. Defaults `100% × 400px`, themes axes from the active theme, adds `ResizeObserver` for re-fit on pane resize. |
| `theme()` | function | Returns `{normal, muted, faint, accent}` colors pulled from Obsidian's active CSS variables. |
| `latex(src, display?)` | function | Renders a LaTeX string via Obsidian's MathJax. Returns an `HTMLElement` that typesets in place (can be appended synchronously). `display=true` for block math. |
| `JXG` | global | JSXGraph library (≥1.12.2). |
| `THREE` | global | Three.js r147 with `THREE.OrbitControls` attached. |

### `initBoard` options

Forwards anything to `JXG.JSXGraph.initBoard` plus:

| Option | Default | Notes |
|--------|---------|-------|
| `height` | `"400px"` | CSS height applied to target if empty. |
| `width` | `"100%"` | CSS width applied to target if empty. |
| `axes` | `true` | `false` for none; object to tweak label/tick attrs (e.g., `{ label: { fontSize: 14 } }`). |
| `boundingbox` | `[-5, 5, 5, -5]` | JXG convention: `[xmin, ymax, xmax, ymin]`. |

Raw `JXG.JSXGraph.initBoard` is available if you need full control.

## Required conventions

### 1. JSXGraph text uses LaTeX without `$…$` delimiters

`useMathJax` is on globally for JSXGraph text elements. So:

```js
board.create("slider", [[x1,y1],[x2,y2],[min,val,max]], {
  name: "\\mu_p",        // renders as μ_p (italic μ, real subscript)
  snapWidth: 0.01, precision: 2,
});
```

Use `"\\mu"`, `"\\sigma^2"`, `"\\mathcal{N}"`, `"\\mathrm{dim}"`. Plain strings still work; use LaTeX whenever the label is mathematical.

**LaTeX belongs inside the board.** Do **not** pass LaTeX strings to DOM elements you create yourself — plain `textContent` / `innerHTML` doesn't go through MathJax, so `"\\mu"` renders as the literal five characters `\`, `m`, `u`, `:`, space. Two ways to fix:

- For short math labels on DOM controls (slider rows, stat readouts, HTML captions), use **Unicode** directly: `μ`, `σ`, `π`, `P₂`, `Q₁`, `·`, `±`, `∑`, subscripts `₀₁₂₃₄₅₆₇₈₉`, superscripts `⁰¹²³⁴⁵⁶⁷⁸⁹`. No MathJax cost, works in both themes.
- For anything more structured (fractions, integrals, matrices), use the `latex(src, display?)` helper and append the returned element.

Mixing: board text → LaTeX; DOM text → Unicode (or `latex()`). Never LaTeX in `textContent`.

### 2. Colors in `latex()` readouts — CSS spans, NOT `\color{#hex}`

Obsidian's MathJax does **not** ship the `color` TeX package. `\color{#3b82f6}{…}` silently breaks the formula — everything after the broken macro is dropped. Use per-segment colored spans:

```js
const piece = (tex, color) => {
  const span = document.createElement("span");
  if (color) span.style.color = color;
  span.appendChild(latex(tex, false));
  return span;
};
const sep = () => {
  const s = document.createElement("span");
  s.textContent = "  ·  ";
  s.style.color = theme().muted;
  return s;
};

label.empty();
label.appendChild(piece(`D_{KL}(p \\,\\|\\, q) = ${kl.toFixed(4)}`));
label.appendChild(sep());
label.appendChild(piece(`p = \\mathcal{N}(${mp}, ${sp}^2)`, "#3b82f6"));
label.appendChild(sep());
label.appendChild(piece(`q = \\mathcal{N}(${mq}, ${sq}^2)`, "#f97316"));
```

MathJax CHTML inherits `color` from the parent span. This is the cleanest way to get per-segment colored formulas in a live readout.

### 3. Theme-aware colors, not hardcoded grays

```js
const t = theme();          // t.normal, t.muted, t.faint, t.accent
// Use t.muted for axis strokes, t.faint for grid, t.normal for labels.
```

`initBoard` already themes the axes it creates. Only read `theme()` for slider baselines, extra curves, annotations.

For data curves, a consistent palette works well across light/dark themes:
- Blue `#3b82f6` — primary data
- Orange `#f97316` — secondary data
- Green `#10b981` — derived / meta
- Red `#ef4444` — errors/alerts

### 4. Guard against `board.on("update")` recursion

`board.update()` re-fires the `update` event. Use a flag:

```js
let updating = false;
board.on("update", () => {
  if (updating) return;
  updating = true;
  // ... do work, possibly call board.setBoundingBox / board.update() ...
  updating = false;
});
```

### 5. Don't recreate board objects per slider tick

Slider `input` events fire continuously during drag. If the handler calls `board.removeObject(...)` + `board.create(...)` for hundreds of points, the viz locks up — deleting SVG nodes, allocating new ones, and re-laying out is expensive. For any viz with more than ~30 data elements that depend on slider state:

1. **Create once.** Pre-create every point / segment / label outside the handler.
2. **Parameterize coords via functions.** Pass function coords referencing a shared `state` object: `board.create("point", [() => state.values[i], jitter[i]], {...})`. Then `board.update()` re-evaluates them.
3. **Mutate attributes in place.** Color/visibility changes per element: `pt.setAttribute({ strokeColor: c, fillColor: c })`, wrapped in `board.suspendUpdate()` / `board.unsuspendUpdate()` to batch the redraw.
4. **Keep random samples fixed.** If a viz shows a sample from a distribution, don't re-draw the samples on every slider tick — precompute z-scores/jitter once, rescale with `mean + std * z` in the handler.

Only the genuine "new data" action (a Regenerate button) should actually resample or recreate.

### 5. Error handling: you don't need any

The plugin wraps each block in an async IIFE and catches both sync construction errors and async rejections, rendering them as a `<pre class="interactive-error">` inside the block. Let errors throw naturally.

## Common patterns

### Function graph driven by sliders

```js
const board = initBoard(container.createEl("div"), {
  boundingbox: [-5, 5, 5, -5],
  height: "400px",
});

const a = board.create("slider", [[-4.5, 4], [-1, 4], [0, 1, 3]], {
  name: "a", snapWidth: 0.01,
});

board.create("functiongraph", [x => a.Value() * Math.sin(x)], {
  strokeColor: "#3b82f6", strokeWidth: 2.5,
});
```

Sliders re-fire `board.on("update")` on drag — any `functiongraph` that reads `a.Value()` inside its function body will re-evaluate automatically.

### Live LaTeX readout

```js
const label = container.createDiv({ cls: "interactive-label" });

const render = () => {
  label.empty();
  label.appendChild(latex(`f(x) = ${a.Value().toFixed(2)} \\sin(x)`, true));
};
render();
board.on("update", render);
```

For colored segments, use the `piece` / `sep` pattern from convention #2.

### Choosing a rendering backend

**JSXGraph is the default for anything with axes-and-data structure** — function plots, scatter plots, box plots, vector diagrams, sliders-and-curves. It's SVG-rendered (crisp at any zoom), `initBoard` auto-themes from Obsidian's active theme, and gliders / draggable points come free. Reach for raw canvas only when the grid is dense (>144 cells) or pixel-perfect raster output is actually required. Three.js is for 3D.

Don't pick canvas for "consistency" across a multi-viz note — match the backend to each viz, even if that mixes them within one note.

### Small polygon grid (heatmap-style)

Up to ~144 cells is comfortable with JSXGraph polygons. Beyond that, switch to a raw `<canvas>`.

```js
const GRID = 12;
const board = initBoard(container.createEl("div"), {
  boundingbox: [-1, GRID + 1, GRID + 1, -1],
  height: "420px",
  axes: false,
  keepAspectRatio: true,
});

const cells = [];
for (let yi = 0; yi < GRID; yi++) {
  for (let xi = 0; xi < GRID; xi++) {
    cells.push(board.create("polygon",
      [[xi, GRID - 1 - yi], [xi + 1, GRID - 1 - yi],
       [xi + 1, GRID - yi], [xi, GRID - yi]],
      {
        fillColor: "#ffffff", fillOpacity: 1,
        borders: { strokeColor: theme().faint, strokeWidth: 0.5 },
        vertices: { visible: false },
        hasInnerPoints: false, fixed: true,
      }
    ));
  }
}

// In update(), for each cell: cell.setAttribute({ fillColor: valueToRGB(value) });
```

### Raw canvas heatmap (large grid, fast redraw)

For grids beyond ~144 cells or pixel-perfect rendering. Style DOM controls with Obsidian CSS variables so they adapt to themes:

```js
const canvas = container.createEl("canvas");
canvas.width = 400; canvas.height = 400;
const c = canvas.getContext("2d");

const sel = container.createEl("select");
sel.style.cssText =
  "padding:3px 8px;border-radius:4px;" +
  "border:1px solid var(--background-modifier-border);" +
  "background:var(--background-primary);color:var(--text-normal);";
for (const [v, label] of [["a","Mode A"], ["b","Mode B"]]) {
  sel.createEl("option", { value: v, text: label });
}

function draw() {
  // fillRect loop using sel.value
}
sel.addEventListener("change", draw);
draw();
```

### 3D surface (Three.js)

Use for anything where color-as-value-mapping or real shading matters. JSXGraph's `view3d` exists but surfaces render flat-colored.

Canonical setup — per-vertex color, Phong lighting, orbit, damping, resize, animation loop:

```js
const canvasWrap = container.createDiv();
canvasWrap.style.height = "500px";
canvasWrap.style.background = "#1a1a2e";  // dark bg looks good in both themes
canvasWrap.style.borderRadius = "6px";
canvasWrap.style.overflow = "hidden";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
canvasWrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
camera.position.set(20, 15, 20);

const orbit = new THREE.OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.05;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(10, 20, 10);
scene.add(dir);

// Build geometry: positions + per-vertex colors, indexed triangles, Phong material
// with vertexColors:true. See "value-to-color" below for the color map.

function resize() {
  const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
new ResizeObserver(resize).observe(canvasWrap);
resize();

(function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
})();
```

Blue/white/red value mapping (`v ∈ [-1, 1]`):

```js
function valueColor(v) {
  const c = new THREE.Color();
  if (v >= 0) c.setRGB(1 - v, 1 - v, 1);
  else        c.setRGB(1, 1 + v, 1 + v);
  return c;
}
```

Build the surface as `BufferGeometry` with `Float32BufferAttribute("position", ...)` and `Float32BufferAttribute("color", ...)`, indexed triangles, and `MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 30 })`.

## Layout: viz notes + transclusion (default)

**Every `interactive` block goes in its own dedicated viz note, transcluded into the main note with `![[...]]`.** Do not inline `interactive` fences in the main note.

Why: in Live Preview, Obsidian's CodeMirror-based editor has two failure modes for fenced code blocks:
1. **Cursor auto-expand** — when the caret enters the block's lines, the rendered widget is swapped for source. Unavoidable from a plugin.
2. **Long-block non-rendering** — blocks past a few hundred lines (easy to hit with Three.js) stay as source even when the cursor is elsewhere, until the user forces a re-render.

Transcluded content renders via the reading-view pipeline, which hits neither issue. Transclusion makes the viz reliably live in Live Preview without the user toggling to Reading view.

### The pattern

Main note (`Foo.md`):

```markdown
Short intro. Prose with inline $x$ and display math:
$$y = f(x)$$

![[Foo 1D Viz]]

More prose for the next section.

![[Foo 2D Viz]]
```

Viz note (`Foo 1D Viz.md`) — just the fence, nothing else:

````markdown
```interactive
// ... self-contained viz code ...
```
````

Naming convention: `<Main Note Name> <qualifier> Viz.md` (e.g. `Positional Embedding 1D Viz.md`, `Gradient Descent Step Viz.md`). The qualifier is optional for single-viz notes.

### Rules

- One `interactive` block per viz note. Blocks don't share scope, and one-block-per-file keeps transclusion boundaries clean.
- The viz note contains **only** the fenced block — no heading, no prose. Headings and context live in the main note.
- The main note holds all prose, formulas, section structure, and the `![[...]]` links.
- Source mode remains the place to edit the JS (open the viz note directly).

## Obsidian view-mode reality (context, not an instruction)

- **Reading view** (`Ctrl+E`) — always renders the block.
- **Live Preview** — renders transcluded blocks reliably. Inline blocks have the two failure modes above.
- **Source mode** — raw markdown, no rendering. Use to edit the JS.

## Porting an HTML visualization

1. Identify independent viz sections → one dedicated viz note per `interactive` block (see the transclusion layout above).
2. Prose / formula boxes / legends → Markdown in the **main** note, with `$…$` or `$$…$$`.
3. Custom HTML controls → JSXGraph sliders for numeric params; native DOM (`<select>`, buttons) for categorical choices or when driving a `<canvas>`. Style DOM controls with Obsidian CSS vars.
4. Hardcoded `#333` axis colors → `theme().muted` (or let `initBoard` handle it).
5. Three.js sections → port mostly verbatim; adjust canvas sizing to use `container` + `ResizeObserver`.
6. Drop: page `<body>` chrome, external `<script src>` for JSXGraph/MathJax/Three.js (preloaded), per-page CSS.
7. Preserve: formula derivations and prose that belongs to the surrounding explanation. Don't add pedagogical bullets or usage hints the user didn't ask for.

If the original uses an unbundled library (D3, Plotly, etc.), port to JSXGraph if feasible or ask before introducing a new dependency.

## Verifying a block

1. Quick syntax check (catches typos):
   ```bash
   node -e "new Function(/* the block's JS */)"
   ```
2. Open the note in Obsidian → Reading view → confirm it renders.
3. Any block error surfaces as a `<pre class="interactive-error">` inside the block with a stack trace. Also check DevTools console (`Ctrl+Shift+I`).
