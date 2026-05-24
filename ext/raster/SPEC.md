# @gcu/raster

**Geospatial raster analysis — terrain, surface metrics, isolines, hydrology — on flat `Float32Array` grids.**

raster is the package that does *math on grids*. It knows about cell size, nodata, and physical units (slope in degrees, aspect in compass bearings, distance in meters); it doesn't know about projections, map rendering, or coordinate transforms. That separation is deliberate: a grid is a grid; whether it lives at EPSG:4326 or UTM Zone 23S is somebody else's problem.

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 0.1                                            |
| Status     | Pre-1.0; shipped 2026-05                       |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | GDAL `gdaldem`; ESRI Spatial Analyst; ArcInfo  |

---

## Lineage

The vocabulary of raster analysis was set by GIS systems of the 1980s-90s. **GRASS GIS** (US Army CERL, 1982) defined `r.slope.aspect`, `r.flow`, `r.watershed` — the long-standing public-domain tools that everything since has imitated. **ESRI's Spatial Analyst** (1996) shipped the same primitives commercially with names like Slope, Aspect, Hillshade, Flow Direction, Flow Accumulation, Watershed. **GDAL's `gdaldem`** (1998+) reimplemented the core five (slope, aspect, hillshade, color-relief, TRI/TPI/roughness) as command-line tools that became the canonical reference for "what does slope mean, computationally?"

`@gcu/raster` carries that vocabulary forward. The function names match (`slope`, `aspect`, `hillshade`, `tri`, `tpi`, `roughness`, `flow_direction`, `flow_accumulation`, `fill_sinks`, `watershed`); the algorithms match (Horn's slope, D8 flow direction, Wang & Liu sink-fill). What's different is the runtime: instead of native binaries, the implementations are [atra](https://www.npmjs.com/package/@gcu/atra)-compiled Wasm kernels with a small JS wrapper. Identical math, different deployment target.

The package lives in `ext/raster/` because that's where the JS wrapper is; the actual math is in `raster.atra`. Calling raster is `await load('@atra/raster')` (the atra-library namespace).

## Premise

Three commitments drive the design:

1. **Grid math without map context.** Inputs are flat `Float32Array`s plus a cell size and a nodata value. No projection, no extent, no metadata. This makes raster composable: `@gcu/spinifex` calls it with map-ready data; a synthetic-test notebook calls it with `Float32Array.from({length: 10000}, Math.random)`. The data model is the same.
2. **Atra kernels for hot paths.** Per-cell math (slope at every pixel of a 4096×4096 grid) is bandwidth- and arithmetic-intensive. Atra compiles to tight Wasm bytecode that runs in a `WebAssembly.Memory` linear buffer, with no allocation churn and no JS-Wasm boundary cost per cell. For algorithms where the hot loop is straight forward (Horn's slope, hillshade), atra wins decisively over JS. For algorithms where the hot loop is sparse pointer-chasing (flow accumulation along D8 paths), JS is comparable or wins; we measure.
3. **Physical correctness as defaults.** Slope returns degrees, not radians. Aspect returns compass bearing (0° = N, increasing clockwise), not math-convention radians. Hillshade uses standard cartographic defaults (azimuth 315°, altitude 45°). Cell size is in the same units as the grid coordinates (meters or degrees); slope respects that. Hydrology distances use the cell-size scaling. These choices match GDAL and ArcGIS; deviation from the convention is the wrong call.

## Data model

A raster grid is three things:

- `data` — a flat `Float32Array` in row-major order, north-edge first (row 0 = top of grid).
- `width`, `height` — extent in cells.
- `cellSize` — single number (square cells) or `[dx, dy]`. Same units as the grid coordinates (typically meters; can be degrees).
- `nodata` — a sentinel value indicating "no measurement here." Common choices: `-32768`, `-9999`, `NaN`. The choice is per-call; raster passes it through.

`Float32Array` is the only supported precision. f32 has plenty of range for elevations in meters (±3.4e38) and angles in degrees, and doubles the SIMD lane count vs f64. For applications that need more precision, do the upstream math in f64 and downcast.

## Algorithm choices

### Terrain — Horn's algorithm

`slope`, `aspect`, and curvature use Horn (1981)'s 3×3 derivative formula:

```
dz/dx = ((z+2 + 2·z+1 + z+0) - (z-2 + 2·z-1 + z-0)) / (8 · dx)
dz/dy = (analogous for y)
slope = atan(sqrt((dz/dx)² + (dz/dy)²))
aspect = atan2(dz/dy, -dz/dx)   (with quadrant-correction for compass bearing)
```

The Horn weighting (1-2-1 across the 3×3 window) trades a small amount of smoothing for substantially better numerical stability than the alternative Zevenbergen-Thorne formulation. GDAL uses Horn by default; ArcGIS uses Horn; raster uses Horn.

### Illumination — standard cartographic hillshade

```
hs = cos(zenith) · cos(slope) + sin(zenith) · sin(slope) · cos(azimuth - aspect)
```

With `zenith = 90° - altitude`. Defaults: azimuth 315° (light from NW), altitude 45° (low-sun cartographic convention). Output range [0, 255] cast to uint8 for direct display use; an unscaled `[0, 1]` mode is available.

The fused `raster.terrain()` call computes slope + aspect + hillshade in a single 3×3-window traversal — the only saving is reading the 9 cells once instead of three times, but at 4096×4096 that's a 3× speedup.

### Surface metrics — TRI, TPI, roughness

- **TRI** (Terrain Ruggedness Index, Riley et al. 1999) — mean absolute difference between a cell and its 8 neighbors.
- **TPI** (Topographic Position Index, Weiss 2001) — difference between a cell and the mean of its 8 neighbors. Positive = ridge; negative = valley.
- **Roughness** — range (max − min) over a 3×3 window.

Window size is hard-coded at 3×3 (per GDAL convention). A larger-window TPI is sometimes useful (5×5 or 9×9 for landform classification); deferred to v0.2.

### Isolines — marching squares

`contour(data, width, height, levels)` extracts isolines at the specified elevation levels. Implementation is the canonical marching-squares algorithm (Lorensen & Cline 1987's 2D variant). Output is GeoJSON-shaped:

```js
{
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { level: 100 }, geometry: { type: 'LineString', coordinates: [...] } },
    ...
  ]
}
```

Cell-by-cell traversal; chains adjacent segments into continuous lines. Closed-loop detection (e.g. peaks) is handled by the chain-walking pass. Saddle cell ambiguities resolve by choosing the orientation that produces fewer crossings (a common heuristic).

### Hydrology

The hydrology stack is the most opinionated part of raster. Five functions, each builds on the previous:

#### Sink fill (Wang & Liu 2006)

DEMs have spurious sinks — pits one cell deep from data noise or interpolation artifacts. Wang & Liu's priority-flood algorithm walks the boundary inward, raising any interior cell to match its lowest already-processed neighbor. After fill, every cell drains to the grid edge.

Implementation: a binary min-heap (priority queue) over boundary cells. Pop the lowest, push its unprocessed neighbors at `max(neighbor_z, this_z)`. O(n log n) on a grid of n cells; runs in a few hundred ms on a 4096×4096 grid.

#### Flow direction (D8)

For each cell, compute the steepest-descent direction among the 8 neighbors. Output is a uint8 per cell, encoding the direction as `1..8` (or `0` for sinks; should be empty after fill).

Encoding convention is **D8 powers-of-two** matching ArcGIS:

```
32  64  128
16   *    1
 8   4    2
```

Powers-of-two because the encoding doubles as a bitmask for multi-direction routing (D-infinity, Mfd) if we ever add it.

#### Flow accumulation

For each cell, count the number of upstream cells that flow into it. Implementation is a topological-sort traversal: visit cells in descending elevation order; for each cell, add its accumulated count to its D8 downstream neighbor.

Output is uint32 per cell. Stream-network derivation is downstream: `data >= threshold` masks the cells that constitute streams.

#### Watershed delineation

Given an outlet cell, walk upstream via the inverse D8 (the cells whose D8 points TO this cell) to find every cell that drains to the outlet. Output is a boolean mask.

For multi-outlet delineation, run once per outlet and accumulate labels.

### Choice: D8 over D-infinity / Mfd

D8 (single-flow direction, eight neighbors, all-flow-to-one) is the classical algorithm and what every operational hydrologist learns first. D-infinity (Tarboton 1997) and Multiple-Flow-Direction (Quinn 1991) distribute flow proportionally; they're more physically accurate for flat or low-slope terrain.

Raster ships D8. If higher accuracy is needed, the underlying API (`flow_direction`, `flow_accumulation`) is fine for the D8 use case; a D-infinity variant could land as `flow_direction_dinf` later.

## Architecture

```
ext/raster/
  api.js          — JS wrapper exporting the public surface
  index.js        — atra-compiled raster.atra (BUILD OUTPUT)
  raster.atra     — the actual math: atra source for every kernel
  package.json
  README.md
  SPEC.md         — this file
  LICENSE
```

The package compiles via `node ext/atra/atrac.js raster.atra` producing `index.js` (a pre-bundled atra library — self-extracting Wasm + JS glue). Loading is `await load('@atra/raster')`; this resolves to the local `index.js` in dev, to a pre-installed module in saved notebooks, or to the bundled `@atra/raster` library elsewhere.

## Spinifex integration

`@gcu/spinifex` consumes `@gcu/raster` for its DEM operations: when a user computes slope/aspect/hillshade on a loaded DEM, spinifex calls into raster's kernels. The data shape is the same: spinifex's `DEM` wraps a `Float32Array` + cellSize + nodata, which is exactly what raster takes.

The split: spinifex owns the *map context* (projection, layer composition, rendering); raster owns the *math*. A user can do raster work without spinifex (no map needed) and spinifex without raster (visualizing prebuilt rasters from disk).

## Testing

68 tests in `test/raster.test.mjs` covering:

- Terrain — slope, aspect, hillshade against analytical reference grids (planar slope, pure-N aspect, etc.). Nodata propagation: a single nodata cell in a 3×3 window produces nodata output (cannot compute the derivative).
- Surface metrics — TRI, TPI, roughness against hand-computed reference.
- Contour — marching squares on synthetic Gaussians; verify closed loops form correctly, levels produce reasonable line counts.
- Hydrology — sink fill on a 3-pit synthetic DEM; flow direction on a known sloped surface; flow accumulation on a chain DEM (every cell's accumulation should equal its row+1 if the slope is straight east-west).

Reference grids are checked into the test directory; updating them requires `--update-snapshots`.

## Open questions

- **D-infinity / multi-flow direction.** Listed in roadmap. The D8 implementation is the bulk of the work; adding D-inf is a few-hundred-line addition to `raster.atra`.
- **Viewshed.** Line-of-sight computation from a viewer position. Significant work (efficient algorithms involve auxiliary grids); not in v0.1.
- **Pure-JS fallback.** Some users may want the small-grid path without the atra Wasm load cost. A `raster-js` companion (pure JS, no Wasm) for grids ≤ ~512² would suffice; deferred.
- **Color relief / hypsometric tinting.** GDAL has `gdaldem color-relief`; we don't. Easy to add — a color ramp interpolated through elevation bands.
- **Larger window sizes.** TRI / TPI / roughness are hard-coded at 3×3 windows. Configurable window size would land as an opts bag.
- **Streaming raster I/O.** Currently the whole grid lives in memory. For grids that exceed RAM, tile-by-tile processing would be a separate package.

## What @gcu/raster is NOT

- **A generic N-D array library.** For element-wise math, broadcasting, FFTs: use `@gcu/natra` (numpy-shape) or `@gcu/scitra/ndimage`. Raster operates on 2D grids only.
- **A coordinate transform / reprojection library.** For projecting between EPSG codes: use `proj4` (via spinifex) or GDAL.
- **A vector GIS.** No polygon operations, no buffering, no overlay analysis. That's a different shape (looking forward: maybe `@gcu/geom` someday).
- **A map renderer.** Hillshade returns numbers, not pixels. Display is spinifex / dee / a custom canvas pass.
- **A full GIS suite.** It does the math, not the analysis workflow. Composition (chain: load DEM → fill sinks → flow accumulation → threshold → vectorize) is the user's job.

## Versioning

Pre-1.0 means: the function signatures (`slope`, `aspect`, `hillshade`, etc.) are stable; the D8 flow-direction encoding is stable; the GeoJSON output shape of `contour` is stable. New algorithms (D-infinity, viewshed) land on minor versions.
