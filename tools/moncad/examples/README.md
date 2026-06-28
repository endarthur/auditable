# moncad example DXFs

Sample drawings that render well in moncad v0 (LINE / LWPOLYLINE+bulge / CIRCLE / POINT).
Open one with **File → Open**, or drag it onto the board.

| File | What it is | Shows off |
|---|---|---|
| `qf-pit.dxf` | An open-pit: crest + benches + ramp spiral + a drillhole-collar grid + section lines, at Quadrilátero-Ferrífero-ish **UTM 23S** coordinates. | The **frame-correct readout** — pan around and the footer reads true eastings/northings (~600 000 / 7 790 000) while it renders jitter-free in local space. |
| `contours.dxf` | Nested wavy structure contours + scattered drillholes, also at UTM. | Smooth nested closed polylines; the geological case. |
| `faceplate.dxf` | A rounded-rectangle faceplate (bulge-arc corners) with a screen aperture and four button holes, in **mm**. | True **bulge arcs** as corner fillets; circles as holes. The mechanical-drafting case. |
| `rosette.dxf` | A flower-of-life (19 circles) plus a dense hypotrochoid spiral (~1 600 points). | Arc/segment **density** — a couple of thousand segments, smooth pan/zoom. |

## Regenerating

These are *generated* — built as `@gcu/dxf` Documents and written with the library's own
writer (so making them also exercises the writer's round-trip):

```
node tools/moncad/examples/gen.mjs
```

Edit `gen.mjs` to add or tweak examples. All four round-trip through `@gcu/dxf`'s reader
with zero warnings.
