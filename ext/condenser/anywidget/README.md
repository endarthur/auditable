# gcu-condenser

**Block models, drillholes and big point clouds — in a Jupyter notebook.**

```python
import numpy as np, gcu_condenser as cd

cd.blocks(df, x="XC", y="YC", z="ZC", value="FE")        # on its own
cd.view(                                                  # …or stacked, co-registered
    cd.blocks(df, value="FE", name="model", threshold=[28, 99]),
    cd.drillholes(collar, survey, assay, value="AU"),
    cd.points(tx, ty, tz, name="topo", sectioned=False),
).cut(axis="y", position=8200500, thickness=40)
```

The renderer is [`@gcu/condenser`](../) — the same streaming engine behind
[micro](https://gentropic.org/micro). Columns go in; the widget quantizes them,
Morton-orders them, and draws a shuffled prefix that refines progressively, so a
few million elements come up in a fraction of a second and sharpen from there.
No decimation pass, no mesh conversion, no kernel round trip while you navigate.

Start with **[`example.ipynb`](example.ipynb)** — a runnable tour, no data files needed.

## Why this and not pyvista / k3d

For general 3D in Python those are excellent and this is not trying to replace
them. Two things here are genuinely different:

- **Block models are first class.** A model draws as instanced ray-traced box
  impostors on the inferred lattice — per-face lighting, exact silhouettes,
  correct occlusion, one quad per block — including **sub-blocked** models,
  where every block renders at its true size. Glyphing cubes through a general
  mesh pipeline costs an order of magnitude more and falls over at mine scale.
  1.9M blocks pack in 75 ms and paint in ~0.4 s.
- **Scale without preprocessing.** Progressive prefix-LOD is the *default* path,
  not an opt-in decimation you have to configure.

Plus the posture the same audience tends to care about: **no network, no WASM,
no runtime downloads.** The ES module is bundled into the wheel.

If you want general meshes, volumes, streamlines or a full VTK pipeline, use
pyvista. If you want to look at a mine-scale model with its drillholes and click
on it, this is smaller and faster.

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

Per **view**: `section` (or `w.cut(...)`), `background`, `height`, `edl`,
`edl_strength`, `budget`, `selection`, `w.fit()`, `w["name"]`, `w.add(layer)`.

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
```

A layer built with `sectioned=False` stays whole while the rest is cut — the
usual way you keep topography for context. `'front'` / `'behind'` give you a
half-space instead of a slab.

### Clicking round-trips into pandas

The pick uses the engine's ID buffer, and a record index *is* the row you passed:

```python
w = cd.view(cd.blocks(df, value="FE", name="model"), holes)
# …click something…
w.selection            # {'layer': 0, 'name': 'model', 'row': 12874}
df.iloc[w.selected_row]
```

For drillholes the row is the **interval** row of the assay table.

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
  bounded by your deployment's message limit — roughly 2M blocks ≈ 62 MB.

## Testing

```bash
node test/condenser-widget.mjs
```

Cross-language by construction: the real Python packer runs in this venv, its
bytes cross into a real browser, and the real built module renders them — the
only shape that catches a wire-format drift between the two halves.
