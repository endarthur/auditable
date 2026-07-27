# gcu-condenser

**Block models, drillholes and big point clouds — in a Jupyter notebook.**

```python
import numpy as np, gcu.condenser as cd

cd.blocks(df, x="XC", y="YC", z="ZC", value="FE")        # on its own
w = cd.view(                                              # …or stacked, co-registered
    cd.blocks(df, value="FE", name="model", threshold=[28, 99]),
    cd.drillholes(collar, survey, assay, value="AU"),
    cd.points(tx, ty, tz, name="topo", sectioned=False),
    section={"axis": "y", "position": 8200500, "thickness": 40},
)
w
```

The renderer is [`@gcu/condenser`](../) — the same streaming engine behind
[micro](https://gentropic.org/micro). Columns go in; the widget quantizes them,
Morton-orders them, and draws a shuffled prefix that refines progressively, so a
few million elements come up in a fraction of a second and sharpen from there.
No decimation pass, no mesh conversion, no kernel round trip while you navigate.

Start with **[`example.ipynb`](example.ipynb)** — a runnable tour, no data files needed.

## Why this and not pyvista / k3d

pyvista is excellent and this does not replace it. The honest comparison, from
a bench of the shapes a resource geologist actually has (128×128×80 lattice;
build time and the bytes that must reach the browser):

| | condenser | pyvista |
|---|---|---|
| **full** regular lattice, 1.3M cells | 56 ms · 40 MiB | **1 ms · 41 MiB** (`ImageData`) |
| **sparse** model (a deposit, 150k of those cells) | **7 ms · 4.6 MiB** | 74 ms · 17.7 MiB |
| **sub-blocked**, 90k blocks, 2 sizes | **47 ms · 2.8 MiB** | 73 ms · 30.2 MiB (glyph) |
| point cloud, 5M | 187 ms · 162 MiB | 134 ms · 153 MiB |

Read that honestly:

- **For a full regular lattice, pyvista wins outright.** `ImageData` is
  *implicit* — VTK materialises no geometry at all. If your model is a complete
  box and you are happy in a VTK pipeline, use pyvista.
- **A real model is not a box.** The moment you keep only the cells that exist,
  `threshold` materialises explicit hexahedra — 547k points for 150k cells —
  and it is 10× slower to build and ~4× more to ship.
- **Sub-blocked models cannot be `ImageData` at all**, so the only route is
  glyphing cubes: 540k cells and 720k points for 90k blocks, ~11× the bytes.
  That is the case that scales worst, and it is common.
- **Point clouds are a wash** on construction. Nothing to claim here.

The advantage that does *not* show in that table is **rendering**, which is what
the engine is actually for: one instanced quad per block with a ray-traced
impostor rather than 12 triangles, and progressive prefix-LOD as the default
path — so a model paints early and sharpens, instead of stalling until it can
draw everything. VTK renders all-or-nothing. Measuring that fairly needs a GPU
on both sides, so it is stated here as a design difference, not a benchmark.

Plus the posture the same audience tends to care about: **no network, no WASM,
no runtime downloads**; the ES module is bundled into the wheel.

Short version: general meshes, volumes, streamlines, a full VTK pipeline, or a
complete regular lattice → pyvista. A sparse or sub-blocked mine-scale model
with its drillholes, that you want to click on → this.

## Requirements

**Python 3.10+**, and two dependencies: **anywidget** and **numpy**. That is the
whole list — no VTK, no WASM, no CDN.

| | | |
|---|---|---|
| Python | `>=3.10` | verified on 3.10 · 3.11 · 3.12 · 3.13 |
| `anywidget` | `>=0.9` | developed against 0.11 |
| `numpy` | `>=1.21` | verified on 1.21 · 1.23 · 1.26 · 2.x |

3.10 is a *support* decision rather than a syntax one — the code runs fine on
3.9, but on 3.9 pip resolves anywidget back to 0.9.x, a different frontend
generation whose JS contract isn't tested here. One anywidget to support beats
two supported blind. (3.9 is also EOL as of October 2025.)

Both numpy majors work: `np.unique(..., axis=0, return_inverse=True)` — used by
the sub-blocking path — changed its result shape across the 2.0 boundary, and
that path is covered on each side.

`pandas` is *not* required: every constructor takes plain arrays, and a "table"
is anything indexable by column name (a DataFrame, a polars frame, or a dict of
arrays). It's a `[dev]` extra only because the example notebook uses it.

## Install

Not on PyPI yet. From the repo, with [uv](https://docs.astral.sh/uv/):

```bash
uv venv ext/condenser/anywidget/.venv
uv pip install --python ext/condenser/anywidget/.venv -e "ext/condenser/anywidget[dev]"
```

`[dev]` adds jupyterlab + pandas so `example.ipynb` runs. If you changed the JS,
rebuild first: `node ext/condenser/anywidget/build.js`.

## The three kinds

```python
cd.points(x, y, z, value=..., category=..., rgb=...)     # a cloud
cd.blocks(x, y, z, value=..., size=(dx, dy, dz))         # a model (sub-blocking optional)
cd.drillholes(collar, survey, intervals, value="AU")     # desurveyed capsules
```

Each takes arrays *or* a table plus column names, and returns a **Layer**.
Display a Layer directly, or stack several with `cd.view(...)` — they share one
frame, so they co-register (and a local origin keeps mine-grid coordinates off
the float32 wall on the GPU).

Drillholes desurvey in the browser through **@gcu/drillhole**, the same
minimum-curvature code micro uses, so a hole lands in the same place in both.

## The toolbar

| | |
|---|---|
| **fit** | reframe on the data |
| **views** | plan · looking north · looking east · isometric |
| **ortho** | parallel projection — sections are unreadable in perspective |
| **pick** | click an element to inspect it (on by default) |
| **rectangle** | drag a box to select — shift adds to the selection |
| **lasso** | draw around elements to select — shift adds |
| **through** | toggle: select the swept *volume* instead of the visible surface |
| **measure** | click two elements for distance, bearing and plunge |
| **knife** | drag a line across the view to cut a section along it |
| **layers** | show/hide each layer |
| **snapshot** | save the view as a PNG |

Plus a **colour legend** bottom-right, a **pick readout** top-right, and a
**scrub bar** whenever a section exists — slide the plane through the model.

It is deliberately small. The toolbar carries what is awkward from Python
(mouse-driven geometry) and what you need *while looking* (the readout, the
legend); everything a line of Python does well stays in Python. Anything you do
here **round-trips**: hide a layer with the toolbar and `w["topo"].visible` is
`False` in the kernel, and a knife cut lands in `w.section`. Pass
`toolbar=False` for a clean figure.

## The knobs

Per **layer** — every one is live, set it and the view updates with no re-send:

| trait | |
|---|---|
| `color` | `'z'` · `'value'` · `'category'` · `'rgb'` · `'flat'` |
| `ramp` | `viridis` · `magma` · `turbo` · `greys` · `spectral` · `fire` |
| `clip` | `[lo, hi]` — clamp the colour scale |
| `threshold` | `[lo, hi]` — **cutoff on the value column** |
| `filter_mode` | `'isolate'` (hide the rest) or `'dim'` |
| `opacity` | screen-door see-through, `1.0` = solid |
| `visible`, `point_size`, `as_points`, `block_edges`, `radius` | |
| `sectioned` | `True` · `False` (exempt) · `'front'` · `'behind'` |
| `selected` | read back: the row picked on this layer |
| `selected_rows` | read back: rows caught by the rectangle/lasso tools |

Per **view**: `section` (or `w.cut(...)`), `background`, `height`, `toolbar`, `edl`,
`edl_strength`, `budget`, `selection`, `selected_rows`, `measurement`, `w.fit()`, `w.look(view, ortho=)`,
`w.clear_selection()`, `w.copy()`, `w["name"]`, `w.add(layer)`.

### Seeing inside a model

A block model is *solid* — from outside you see waste. `threshold` is how you
look at an ore body at all:

```python
w = cd.blocks(x, y, z, value=fe, ramp="turbo")
w.threshold = [30, 99]        # the grade shell appears
w.threshold = []              # back to the full model
```

Dragging a cutoff never re-sends data; the mask is rebuilt in the browser from
the value column it already has.

### Sections

```python
w.cut(axis="y", position=8200500, thickness=40)
w.cut(normal=[1, 1, 0], position=0, thickness=25)   # any orientation
w.cut()                                              # clear
w.look("north", ortho=True)                          # …and look ALONG it
```

A section is only readable when you look **along** it in parallel projection, so
`look()` is the usual companion — `'plan'`, `'north'`, `'south'`, `'east'`,
`'west'`, `'iso'`. The toolbar's *views* and *ortho* buttons do the same.

A layer built with `sectioned=False` stays whole while the rest is cut — the
usual way you keep topography for context. `'front'` / `'behind'` give you a
half-space instead of a slab.

`cut()`, `look()`, `fit()` and `add()` return `None` on purpose: a notebook
displays a cell's value, so returning `self` would build a *second* live view of
the same widget every time you adjusted it.

### Clicking round-trips into pandas

The pick uses the engine's ID buffer, and a record index *is* the row you passed:

```python
w = cd.view(cd.blocks(df, value="FE", name="model"), holes)
# …click something…
w.selection            # {'layer': 0, 'name': 'model', 'row': 12874}
df.iloc[w.selected_row]
```

For drillholes the row is the **interval** row of the assay table.

### Selecting, and measuring

The rectangle and lasso tools hand their result straight back as row indices:

```python
w.selected_rows                  # {'model': array([...]), 'holes': array([...])}
w["model"].selected_rows         # just this layer's rows
df.iloc[w["model"].selected_rows]        # …which is a DataFrame slice
df.iloc[w["model"].selected_rows].FE.mean()
w.clear_selection()
```

Two modes, like micro's:

- **surface** (default) — uses the same ID buffer as a click, so *what you
  select is what you can see*; occluded elements are not caught.
- **through** (`w.select_through = True`, or the toolbar toggle) — sweeps the
  whole volume behind the shape, so a solid block model gives up its interior.
  On the same box over a solid model that is typically ~10× more rows.

Through-mode defeats *occlusion*, which is the point, but not display state: a
hidden layer, an isolate-filtered element, or a block outside the section slab
is not merely behind something, so the tube leaves it alone.

The two modes disagree slightly at the marquee's edge — through tests an
element's **centre**, surface tests its rendered **pixels**, so a wide splat or a
long drillhole interval can paint inside a box its centre falls outside of
(measured: the tube contains ~96% of a surface selection, with the difference
entirely in points and holes, none in blocks).

Rows ride back as packed binary rather than JSON, because a marquee over a big
model can easily select a million of them.

Measure takes two clicks and reports what you actually want off two points:

```python
w.measurement
# {'from': [...], 'to': [...], 'distance': 84.9, 'dx':…, 'dy':…, 'dz':…,
#  'bearing': 41.2, 'plunge': 63.5}
```

Bearing is degrees from north, clockwise; plunge is positive downward.

### Two panels at once

Views of one Viewer **share its state** — that is what makes `w.cut(...)` update
a cell further up, and it also means two displays of `w` can never differ. For
genuinely independent panels, take a copy:

```python
plan = w.copy()
plan.look("plan", ortho=True)
section = w.copy()
section.cut(axis="y", position=8200500, thickness=40)
section.look("north", ortho=True)     # …two panels, one dataset
```

`copy()` reuses the payload bytes, so it costs a widget, not a re-pack.

## Exporting: it keeps working without a kernel

Everything interactive here runs in the browser, so an exported view stays live
— orbit, pick, knife, section scrub, layers, selection, snapshot all work with
the kernel gone. Only the write-backs (`selection`, `selected_rows`,
`measurement`) have nowhere to land.

```python
cd.export_html(w, "model.html")
```

For a whole notebook: turn on **Settings → Save Widget State Automatically** in
JupyterLab, save, then `jupyter nbconvert --to html nb.ipynb`.

Two things to know:

- **`drop_defaults=False` is mandatory**, which is why `export_html` exists.
  ipywidgets drops any trait equal to its default, and anywidget's `_esm` — the
  widget's own JavaScript — *is* its default, so the stock
  `embed_minimal_html(...)` call silently writes a file with no code in it and
  renders nothing.
- **Viewing needs network**, even though the data is embedded: the page pulls
  the ipywidgets html-manager from a CDN. nbconvert can be pointed at a local
  copy instead (`--HTMLExporter.jupyter_widgets_base_url=./vendor/`), which is
  the route to a genuinely offline export.

Size: the payload is base64 in the state, so budget about +33% over the figures
above.

## Honest notes

- `filter_mode='dim'` suits **point clouds** — on a solid block model the dimmed
  blocks still occlude, so use `'isolate'` there.
- `opacity` is a screen-door dither (real depth, no sorting), so it sees a few
  blocks deep, not through a whole model.
- `point_size` and `as_points` are view-wide in the engine, so they fold across
  visible layers rather than applying per layer.
- Sub-blocked models must share a common fine lattice (a whole-number
  subdivision). When they don't, the error says so and points at `cd.points(...)`
  rather than drawing a subtly wrong grid.
- The payload crosses the Jupyter comm channel as one blob, so a layer is
  bounded by your deployment's message limit — roughly 2M blocks ≈ 62 MB, and a
  5M-point cloud is ~162 MB, which is past what many deployments allow.
  Coordinates go over as f64 today even though the engine quantises them per
  chunk anyway, so there is a straightforward ~3× saving available here that
  has not been taken yet.

## Testing

```bash
node test/condenser-widget.mjs
```

Cross-language by construction: the real Python packer runs in this venv, its
bytes cross into a real browser, and the real built module renders them — the
only shape that catches a wire-format drift between the two halves.
