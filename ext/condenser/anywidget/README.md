# gcu-condenser

**Block models and big point clouds in a Jupyter notebook.**

```python
import numpy as np, gcu_condenser as cd

cd.blocks(x, y, z, value=fe)                       # a block model, as real boxes
cd.points(x, y, z, value=grade)                    # a cloud
cd.blocks(df, x="XC", y="YC", z="ZC", value="FE")  # or straight from a DataFrame
```

The renderer is [`@gcu/condenser`](../) — the same streaming engine behind
[micro](https://gentropic.org/micro). Columns go in; the widget quantizes them,
Morton-orders them, and draws a shuffled prefix that refines progressively, so a
few million elements come up in a fraction of a second and sharpen from there.
No decimation pass, no mesh conversion, no kernel round trip while you navigate.

## Why this and not pyvista / k3d

For general 3D in Python those are excellent and this is not trying to replace
them. Two things here are genuinely different:

- **Block models are first class.** A block model draws as instanced
  ray-traced box impostors on the inferred lattice — per-face lighting, exact
  silhouettes, correct occlusion, one quad per block. Glyphing cubes through a
  general mesh pipeline costs an order of magnitude more and falls over at mine
  scale. A 1.9M-block model here paints in ~0.4 s from packed numpy.
- **Scale without preprocessing.** Progressive prefix-LOD is the *default* path,
  not an opt-in decimation you have to configure.

Plus the posture the same audience tends to care about: **no network, no WASM,
no runtime downloads.** The ES module is bundled into the wheel.

If you want general-purpose meshes, volumes, streamlines, or a full VTK
pipeline, use pyvista. If you want to look at a mine-scale model or a big cloud
and click on it, this is smaller and faster.

## Install

Not on PyPI yet. From the repo:

```bash
node ext/condenser/anywidget/build.js     # only if you changed the JS
pip install -e ext/condenser/anywidget
```

## The knobs

Every one is a live traitlet — set it and the view updates without re-sending data.

| trait | what it does |
|---|---|
| `color` | `'z'` · `'value'` · `'category'` · `'rgb'` · `'flat'` |
| `ramp` | `viridis` · `magma` · `turbo` · `greys` · `spectral` · `fire` |
| `clip` | `[lo, hi]` — clamp the colour scale |
| `threshold` | `[lo, hi]` — **cutoff on the value column** |
| `filter_mode` | `'isolate'` (hide the rest) or `'dim'` |
| `opacity` | screen-door see-through, `1.0` = solid |
| `point_size`, `as_points`, `block_edges` | |
| `edl`, `edl_strength` | eye-dome lighting (what makes an unlit cloud legible) |
| `background`, `height`, `budget` | |
| `selected` | **read back**: the row index you clicked, or `-1` |

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

Two honest notes: `filter_mode='dim'` suits **point clouds** — on a solid block
model the dimmed blocks still occlude, so use `'isolate'` there. And `opacity`
is a screen-door dither (real depth, no sorting), which sees a few blocks deep,
not through a whole model.

### Clicking round-trips into pandas

The pick uses the engine's ID buffer, and a record index *is* the row you passed:

```python
w = cd.blocks(df, x="XC", y="YC", z="ZC", value="FE")
# …click a block…
df.iloc[w.selected]
```

## Limits (v0.1)

- **Regular lattices only.** Irregular or sub-blocked models raise, and point
  you at `cd.points(...)` to view the centroids.
- One dataset per widget — no layer stack, no sections, no drillholes yet. All
  of those exist in the engine; they are simply not surfaced here yet.
- The payload crosses the Jupyter comm channel as one blob, so very large models
  are bounded by your deployment's message limit. ~2M blocks ≈ 62 MB.

## Testing

`node test/condenser-widget.mjs` runs the real Python packer in a subprocess,
sends its bytes into a real browser, and renders them with the real built
module — the only test shape that can catch a wire-format drift between the two
halves.
