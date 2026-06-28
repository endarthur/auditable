# @gcu/frame

The coordinate-frame contract for the GCU geometry stack. Zero-dependency, pure,
single-file ESM.

Geological data lives at projected-coordinate magnitudes (UTM easting ~5×10⁵,
northing ~7.7×10⁶, RL ~10³ m). Doing math and rendering directly in those large
numbers causes two failures with one cause:

- **the float32 wall** — at northing 7.7×10⁶ a 32-bit float resolves to ~1 m, so any
  GPU / `Float32Array` path jitters, z-fights, and collapses near-coincident vertices;
- **catastrophic cancellation** — derived quantities (lengths, cross products,
  intersection parameters) lose relative precision, and a fixed ε like `1e-9` is
  meaningless against operands of magnitude `1e6`.

`@gcu/frame` is the fix: work in a small-magnitude **local frame**, holding the offset
to **world** as explicit, inspectable metadata. `world` is canonical; `local = world −
origin`; the round-trip is lossless at f64.

## The Frame value

```js
import { makeFrame } from '@gcu/frame';

const f = makeFrame({ origin: [600000, 7700000, 1000], crs: 'EPSG:31983', units: 'm' });
```

A frame carries two faculties with different reach:

1. **numerical framing** — the `origin` offset, for the precision path. Anything bound
   for a `Float32Array`/GPU buffer passes through the frame first.
2. **coordinate identity** — the `crs` descriptor + `units`, universal provenance so
   "what do these world numbers mean" is never silent.

## Hard boundary

Frame **names** a CRS; it never **changes** one. Reprojection (datum shifts, projection
changes) is a geodetic operation that lives elsewhere — crossing CRS here throws. A
working offset is a translation for numerical convenience, not a reprojection.

Frame is **pure translation**: rotation/scale are out of scope. A block model's own
dip/rake orientation is intrinsic model geometry — a separate concern, never conflated
with the working frame.

## API

| | |
|---|---|
| `makeFrame({origin, crs?, units?})` | construct/normalise a Frame (origin → `[x,y,z]`) |
| `WORLD` | identity frame (origin at world zero) |
| `toLocal(pt, f)` / `toWorld(pt, f)` | single point `[x,y]` or `[x,y,z]` |
| `toLocalCoords(buf, f, {stride})` / `toWorldCoords(...)` | bulk flat `x,y,z,…` buffer → new `Float64Array` |
| `originFromBounds(bounds, {round, strategy})` | sticky origin from `{min, max}` (centroid/floor, rounded) |
| `frameFromBounds(bounds, opts)` | a Frame straight from bounds |
| `extentTolerance(f, extent, {rel})` | frame-relative ε for constructed-geometry tests |
| `delta(from, to)` | translation between two frames (throws on CRS/units mismatch) |
| `withFrame(artifact, f)` | stamp `.frame` without moving coordinates |
| `rebaseCoords(buf, from, to, {stride})` | re-express a buffer between frames → `{coords, record}` |
| `sameProjection(a, b)` / `frameEq(a, b)` | comparisons |

Points and origins are **arrays** (`[x,y]` / `[x,y,z]`), matching the rest of the tree
(flat `Float64`/`Float32` vertex buffers, `dee.origin`, `grid.origin`).

## License

MIT © Arthur Endlein Correia
