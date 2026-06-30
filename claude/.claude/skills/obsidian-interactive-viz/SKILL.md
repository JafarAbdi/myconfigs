---
name: obsidian-interactive-viz
description: Write interactive WebGL/canvas visualizations for Jupyter notebooks (.ipynb) opened inside Obsidian by the jupyter-uv plugin. A diagram is a small ES module that imports a shared three.js and is rendered with the `lab.viz` helper as a srcdoc iframe. Use when adding or porting an interactive viz into a notebook, writing notebook-local `notebooks/<notebook-name>/<diagram-name>.js` modules, or calling `lab.viz.show` / `lab.viz.scene`.
---

# Interactive viz in Jupyter notebooks (`lab.viz`)

`.ipynb` notebooks are opened inside Obsidian by the **jupyter-uv** plugin, which renders them in an Electron `<webview>` running JupyterLab. A visualization is a small **ES module** that imports a shared three.js and is hosted by the **`lab.viz`** helper (in the `~/lab` package). The viz runs as static HTML output, so it persists across restarts with no kernel.

Assume the plugin, the `~/lab` package, and the vault's `widgets/lib/` are installed.

## File locations: do not guess

`lab.viz.scene()` loads modules through Jupyter's `/files/...` route. That route serves the
**Obsidian vault**, not the `~/lab` Python package checkout.

| Browser path | Filesystem path |
|---|---|
| `/files/...` | `/home/juruc/Nextcloud/Notes/...` |
| `/files/notebooks/foo/bar.js` | `/home/juruc/Nextcloud/Notes/notebooks/foo/bar.js` |
| `/files/widgets/lib/three.module.js` | `/home/juruc/Nextcloud/Notes/widgets/lib/three.module.js` |

Write notebook-specific diagram modules next to their notebook, inside a folder named after the
notebook stem:

```text
/home/juruc/Nextcloud/Notes/notebooks/<notebook-name>.ipynb
/home/juruc/Nextcloud/Notes/notebooks/<notebook-name>/<diagram-name>.js
```

Call them with the matching vault-relative path:

```python
from lab import viz

viz.scene("notebooks/<notebook-name>/<diagram-name>.js")
```

Do **not** write diagram modules to `~/lab/widgets/` or `/home/juruc/lab/widgets/`. Those are
package/development locations and are not served by `/files/...`. Use `widgets/lib/` only for shared
vendored libraries such as three.js.

## Required agent workflow

When adding a viz to a notebook:

1. Locate the target `.ipynb`. If the user did not give one, ask; do not invent a path.
2. Confirm the notebook is under `/home/juruc/Nextcloud/Notes/`. If not, ask where the vault copy is.
3. Derive the module directory from the notebook stem:
   - notebook: `/home/juruc/Nextcloud/Notes/notebooks/foo.ipynb`
   - module dir: `/home/juruc/Nextcloud/Notes/notebooks/foo/`
4. Write diagram modules into that module dir, e.g. `diagram.js` or `phase_space.js`.
5. In the notebook, call `viz.scene()` with the vault-relative path, with no `/files/` prefix:
   `viz.scene("notebooks/foo/diagram.js")`.
6. Verify the filesystem path and notebook path match before claiming the diagram works.
7. Run the ESM syntax check from the verifying section.

## Webview rendering constraints (learned the hard way — obey these)

The viz runs in the webview, an isolated browsing context. What renders is narrow:

| Mechanism | Works? | Notes |
|---|---|---|
| `<iframe srcdoc="…">` | ✅ | The host. `lab.viz` uses it. |
| `<iframe src="data:text/html;…">` | ❌ blank | Never use a `data:` URI src. |
| `import` from a CDN (esm.sh, unpkg) | ❌ fails silently → blank | The webview blocks cross-origin module fetches. |
| `import` from same-origin `/files/…` | ✅ | How shared libs load (Jupyter serves the vault at `/files/`). |
| anywidget / ipywidgets | ⚠️ | Kernel-backed → "model not found" after restart. `saveState` does **not** capture the state. Avoid for persistent viz. |

So: **srcdoc host + same-origin imports of locally-vendored ESM**. No CDNs, no `data:`, no widgets.

## Quick start

```python
from lab import viz

viz.scene("notebooks/foo/diagram.js")     # a three.js diagram module (preferred)
viz.show_file("notebooks/foo/page.html")  # a self-contained HTML file
viz.show("<svg>…</svg>", height="50vh")   # an HTML/JS string
```

Run the cell once and **save** the notebook; the srcdoc output is then static and reopens without a kernel (see Persistence).

## Authoring a new diagram

A diagram is `notebooks/<notebook-name>/<diagram-name>.js` — an ES module that imports the shared three and exports `render(el)`:

```js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function render({ el, props }) {
  // `el` is a full-height flex column; `props` carries optional JSON data from Python.
  const pane = el.appendChild(document.createElement("div"));
  pane.style.cssText = "flex:1;min-height:0;position:relative;";

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  pane.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f1a);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(20, 15, 35);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));

  // … build geometry into `scene` …

  new ResizeObserver(() => {
    const w = pane.clientWidth, h = pane.clientHeight;
    if (w && h) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); }
  }).observe(pane);

  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();
}
```

Then in `notebooks/<notebook-name>.ipynb`: `viz.scene("notebooks/<notebook-name>/<diagram-name>.js")`. `scene` also accepts `export default { render }`.

## Python example: visualize data

Pass JSON-serializable data from Python via `props` (convert numpy with `.tolist()`); the diagram reads `props` in `render({ el, props })`.

```python
import numpy as np
from lab import viz

points = np.random.randn(800, 3)
viz.scene("notebooks/points_demo/points.js", props={"points": points.tolist()})
```

```js
// notebooks/points_demo/points.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function render({ el, props }) {
  const pane = el.appendChild(document.createElement("div"));
  pane.style.cssText = "flex:1;min-height:0;position:relative;";
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  pane.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
  camera.position.set(4, 3, 6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(props.points.flat()), 3));
  scene.add(new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.06, color: 0x22c55e })));

  new ResizeObserver(() => {
    const w = pane.clientWidth, h = pane.clientHeight;
    if (w && h) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); }
  }).observe(pane);
  (function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
}
```

- **3D** → three.js as above. **2D** → plain `<canvas>` (2D context) inside `render(el)`; or use Plotly from Python for quick exploratory plots. (Other ESM libs can be vendored into `widgets/lib/` and added to the import-map the same way as three.)
- Blue/white/red value map (`v ∈ [-1, 1]`): `v >= 0 ? new THREE.Color(1-v*.75, 1-v*.75, 1) : new THREE.Color(1, 1+v*.75, 1+v*.75)`.
- Build UI with plain DOM (`document.createElement`). Use concrete colors (no Obsidian CSS vars — the webview document doesn't have them).
- Keep complete examples notebook-local, e.g. `notebooks/pe2d/pe2d.js` for `notebooks/pe2d.ipynb`.

## `lab.viz` API

| Function | Use |
|---|---|
| `scene(module, *, props=None, height="90vh", width="100%", import_map=IMPORT_MAP)` | Host a viz ES module with the shared import-map; preferred for three.js diagrams. `props` (JSON) is passed to `render({el, props})`. `module` is a vault-relative path served at `/files/`, e.g. `notebooks/foo/diagram.js` maps to `/home/juruc/Nextcloud/Notes/notebooks/foo/diagram.js`. |
| `show(html, *, height="90vh", width="100%")` | Wrap a full HTML document string in a srcdoc iframe. |
| `show_file(path, *, height, width)` | `show` the contents of a file. |

All return an `IPython.display.HTML` (the cell's last expression displays it).

## Shared libraries

Shared libraries are the exception to notebook-local placement. They are served from the vault at `/files/widgets/lib/`, loaded once, and cached across all diagrams:

```
widgets/lib/three.module.js              # three.js r160 (ESM)
widgets/lib/addons/controls/OrbitControls.js
```

`scene()` injects this import-map so modules use bare specifiers:

```json
{ "three": "/files/widgets/lib/three.module.js", "three/addons/": "/files/widgets/lib/addons/" }
```

Vendor ESM builds locally (npm `three/build/three.module.js`); do **not** depend on another plugin's global/UMD `THREE`.

## Persistence & trust

The viz is a static srcdoc output, not a live widget. To make it reopen without re-running:

1. **Trust** the notebook so the webview renders its HTML output: `jupyter trust "Note.ipynb"` (or run a cell — fresh output is trusted in-session). Untrusted notebooks have HTML output sanitized → blank.
2. **Save with output present** — run the cell, then save; or pre-execute headless and trust:
   ```bash
   jupyter nbconvert --to notebook --execute --inplace "Note.ipynb"
   jupyter trust "Note.ipynb"
   ```

`scene()` loads from `/files`, so the Jupyter server must be running on open (it auto-starts). For a fully offline note, use `show_file` with a self-contained HTML (three inlined) instead.

## Layout (fullscreen, no inner scrollbar)

The host page is a full-height flex column with `overflow:hidden`; the iframe defaults to `height:90vh`. In `render(el)`, give the WebGL pane `flex:1;min-height:0` so it fills the space and the `ResizeObserver` keeps the canvas matched — never a fixed pixel height that overflows.

## Anti-patterns

- ❌ `import` from a CDN — blocked in the webview. Vendor into `widgets/lib/`.
- ❌ `<iframe src="data:…">` — renders blank. Use `srcdoc` (i.e. `lab.viz`).
- ❌ anywidget/ipywidgets for a diagram you want to persist — dies on restart; `saveState` doesn't capture it.
- ❌ Reusing another plugin's global `THREE` — global, version-coupled, breaks if that plugin changes.
- ❌ Writing diagram modules to `~/lab/widgets/` or `/home/juruc/lab/widgets/` — `/files/...` cannot serve them.

## Verifying a diagram

1. Confirm the file exists in the vault, e.g. `/home/juruc/Nextcloud/Notes/notebooks/foo/diagram.js`.
2. Confirm the notebook calls the matching vault-relative path: `viz.scene("notebooks/foo/diagram.js")`.
3. Syntax (ESM-aware): `node --input-type=module --check < /home/juruc/Nextcloud/Notes/notebooks/foo/diagram.js`.
4. `viz.scene(...)` / `viz.show(...)` output HTML contains `srcdoc=` (not `src="data:`).
5. Open the notebook in Obsidian → the viz renders on open (no kernel). If blank: check the webview console (`Ctrl+Shift+I`) and confirm the notebook is trusted.
