# raster

Geospatial raster analysis — terrain derivatives, surface metrics, isolines, and hydrology. Operates on flat `Float32Array` grids with known cell size and nodata value. No map context, no projections, no DOM — pure grid math.

Built as atra kernels (compiled to Wasm) with a JS API wrapper. Loaded via `load("@atra/raster")`.

```js
const { raster } = await load("@atra/raster");

const slope = raster.slope(data, width, height, cellSize);
const aspect = raster.aspect(data, width, height, cellSize);
const hs = raster.hillshade(data, width, height, cellSize, { azimuth: 315, altitude: 45 });

// Fused pass — computes all three in one traversal
const { slope, aspect, hillshade } = raster.terrain(data, width, height, cellSize);
```

## Scope

### What raster does

Grid operations with geospatial/physical meaning:
- **Terrain derivatives** — slope, aspect, curvature (profile, plan, mean)
- **Illumination** — hillshade with configurable sun position
- **Surface metrics** — TRI, TPI, roughness
- **Isolines** — contour extraction via marching squares → GeoJSON
- **Hydrology** — flow direction (D8), flow accumulation, sink filling, watershed delineation

### What raster does NOT do

- Generic N-d array operations → scitra/ndimage
- Convolution, morphology, filters → scitra/ndimage
- Coordinate transforms, reprojection → GDAL or proj4
- Rasterization, polygonization → GDAL
- Map rendering, layers, tiles → spinifex

### Relationship to other modules

```
atra                — compiler (raster kernels compile to Wasm)
scitra/ndimage      — generic array ops (convolution, morphology)
raster              — geospatial grid analysis (this module)
spinifex            — web GIS (consumes raster via DEM methods)
```

The key distinction from ndimage: raster operations know about **cell size** (meters or degrees), **nodata semantics**, and **physical units** (slope in degrees, aspect in compass bearing, distance in meters). ndimage operates on abstract arrays with no physical meaning.

## API

All functions take a flat `Float32Array` with row-major layout (row 0 = north edge). Common parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `data` | Float32Array | Input grid |
| `width` | number | Columns |
| `height` | number | Rows |
| `cellSize` | number or [cx, cy] | Cell size in map units. Single number = square cells. |
| `nodata` | number | Nodata value (default: -9999) |

All functions return `Float32Array` output grids of the same dimensions. Border pixels (no full 3×3 neighborhood) are set to nodata.

### Terrain derivatives

#### `raster.slope(data, w, h, cellSize, opts?)`

Slope angle in degrees (0 = flat, 90 = vertical). Uses Horn's method (weighted 3×3 finite difference).

#### `raster.aspect(data, w, h, cellSize, opts?)`

Aspect in degrees clockwise from north (0/360 = N, 90 = E, 180 = S, 270 = W). Flat areas → -1.

#### `raster.hillshade(data, w, h, cellSize, opts?)`

Shaded relief (0–255). Options:

| Option | Default | Description |
|--------|---------|-------------|
| `azimuth` | 315 | Sun azimuth in degrees (clockwise from N) |
| `altitude` | 45 | Sun altitude in degrees above horizon |
| `zFactor` | 1 | Vertical exaggeration |

#### `raster.terrain(data, w, h, cellSize, opts?)`

Fused single-pass computation. Returns `{ slope, aspect, hillshade }` — three Float32Arrays. One read of the input grid, three outputs. ~3× faster than calling each individually.

#### `raster.curvature(data, w, h, cellSize, opts?)`

Surface curvature. Returns `{ profile, plan, mean }` — three Float32Arrays.

- **profile** — curvature in direction of steepest descent (controls flow acceleration)
- **plan** — curvature perpendicular to slope (controls flow convergence)
- **mean** — average of principal curvatures

### Surface metrics

#### `raster.tri(data, w, h)`

Terrain Ruggedness Index — mean absolute difference between center cell and its 8 neighbors. No cell size needed (pure pixel metric).

#### `raster.tpi(data, w, h)`

Topographic Position Index — center cell minus mean of neighbors. Positive = ridge, negative = valley.

#### `raster.roughness(data, w, h)`

Roughness — difference between max and min elevation in 3×3 neighborhood.

### Isolines

#### `raster.contour(data, w, h, bbox, opts?)`

Extract contour lines via marching squares. Returns GeoJSON FeatureCollection of LineStrings.

| Option | Default | Description |
|--------|---------|-------------|
| `interval` | 100 | Contour interval |
| `base` | 0 | Base contour level |
| `attribute` | `"elev"` | Property name for elevation value |

`bbox` is `[west, south, east, north]` — needed to convert pixel coordinates to geographic coordinates.

```js
const geojson = raster.contour(data, w, h, [-44, -21, -43, -20], { interval: 50 });
```

### Hydrology

#### `raster.fillSinks(data, w, h, opts?)`

Priority-flood sink filling (Barnes et al. 2014) with ε increment. Returns a new `Float32Array` with depressions filled to their pour point. Does not modify the input. Nodata cells are treated as barriers. The ε variant adds a tiny increment (`1e-5`) to each filled cell, creating a monotonic gradient across filled flats so D8 can resolve them without post-processing.

#### `raster.flowDirection(data, w, h, cellSize, opts?)`

D8 flow direction. Each cell points to its steepest downhill neighbor. Returns `Uint8Array` with values 1–128 (powers of 2, encoding 8 compass directions) or 0 (sink/flat). Nodata neighbors are skipped (not candidates for steepest descent) but don't poison the output — only center == nodata → 0. Border cells → 0.

```
 32  64  128
 16   0    1
  8   4    2
```

The D8 kernel is written in atra (Wasm). Diagonal distances use `√(cx² + cy²)`.

#### `raster.flowAccumulation(fdir, w, h)`

Number of upstream cells flowing into each cell. Input is a D8 flow direction grid (from `flowDirection`), not raw elevation. Uses topological-sort BFS: computes in-degrees, seeds queue with headwater cells (in-degree 0), propagates accumulation downstream. Returns `Float32Array` with values ≥ 1 (each cell counts itself).

#### `raster.watershed(fdir, w, h, seeds)`

Watershed delineation from seed points. Input is a D8 flow direction grid. `seeds` is an array of `[col, row]` pixel coordinates. Returns `Int32Array` with basin labels (0 = unassigned, 1+ = basin ID matching seed index + 1). Uses upstream BFS: for each seed, propagates its label to all cells whose flow direction points toward it.

```js
const filled = raster.fillSinks(dem, w, h);
const fdir = raster.flowDirection(filled, w, h, cellSize);
const acc = raster.flowAccumulation(fdir, w, h);
const basins = raster.watershed(fdir, w, h, [[outletCol, outletRow]]);
```

## Atra kernels

The performance-critical inner loops are written in atra and compiled to Wasm. The JS API wrapper handles memory allocation, nodata masking, and result extraction.

### Kernel organization

```
ext/raster/
  raster.atra       — atra source (terrain derivatives, metrics, hydrology)
  api.js            — JS API wrapper (memory management, contour, GeoJSON)
  README.md         — this file
```

Build output: `ext/atra/lib/raster.js` (Wasm + api.js, loaded via `@atra/raster`)

### What goes in atra vs JS

**Atra (Wasm):** tight pixel loops — Horn's method, D8 routing, priority-flood inner loop, flow accumulation propagation. These touch every pixel and benefit from Wasm speed + staying in linear memory.

**JS:** contour extraction (marching squares + GeoJSON assembly — complex data structures, not a hot loop), memory allocation, nodata pre/post processing, option parsing.

### Fused terrain pass

The `raster.terrain()` kernel reads the 3×3 neighborhood once and computes `dz/dx`, `dz/dy` (shared), then:
- slope = `atan(sqrt(dz/dx² + dz/dy²)) × 180/π`
- aspect = `atan2(dz/dy, -dz/dx) × 180/π` (convert to compass)
- hillshade = `cos(zenith) × cos(slope_rad) + sin(zenith) × sin(slope_rad) × cos(azimuth_rad - aspect_rad)`

One pass, three outputs, ~3× memory bandwidth savings on a 13M-pixel SRTM tile.

## Spinifex integration

Spinifex's `DEM` class will delegate to raster:

```js
// In spinifex dem.js
dem.slope()       → raster.slope(dem.data, dem.width, dem.height, cellSize)
dem.hillshade()   → raster.hillshade(dem.data, dem.width, dem.height, cellSize)
dem.contour()     → raster.contour(dem.data, dem.width, dem.height, dem.bbox)
```

Cell size is derived from `dem.bbox` and `dem.width/height`. For SRTM at the equator: ~30m. At higher latitudes, `cellX ≠ cellY` (longitude cells shrink with cos(lat)).

These methods replace the current GDAL wrappers (`spx.slope`, `spx.contour`, etc.) for the common case. GDAL remains available for reprojection, format conversion, and edge cases.

## Build

```bash
node ext/atra/build.js        # compiles raster.atra → ext/atra/lib/raster.js
node ext/spinifex/build.js    # rebuild spinifex (if DEM integration changed)
node build.js                 # rebuild auditable.html
node gen_examples.js           # regenerate examples
```

## Testing

Tests in `test/raster.test.mjs`. Pure math, no browser needed.

### Terrain derivatives
- Flat grid → slope=0, aspect=-1, hillshade=constant
- Constant north-facing slope → slope=known angle, aspect=180 (south-facing flow)
- Known synthetic surface (plane, cone, hemisphere) → compare to analytical solution
- Nodata handling: nodata in 3×3 neighborhood → output nodata
- Border pixels → nodata
- `terrain()` fused output matches individual `slope()` + `aspect()` + `hillshade()`

### Surface metrics
- Flat grid → TRI=0, TPI=0, roughness=0
- Step edge → known TRI/TPI/roughness values
- Nodata propagation

### Contour
- Flat grid at exactly contour level → single contour
- Linear ramp → evenly spaced parallel contours
- Isolated peak → closed contour rings
- Contour coordinates are in geographic (bbox) space, not pixel space
- GeoJSON structure: FeatureCollection with LineString features, elevation attribute

### Hydrology
- V-shaped valley → flow converges to valley floor
- fillSinks: artificial pit filled to pour point elevation
- flowDirection: known D8 encoding for simple slopes
- flowAccumulation: total count equals grid size minus 1 at outlet
- watershed: two basins separated by ridge → correct labeling

## Hydrology — algorithm notes

Background research for Phase 2 implementation. These are well-established algorithms from the hydrology/geomorphology literature, chosen for suitability to flat-array Wasm kernels.

### Depression filling

**Priority-Flood (Barnes et al. 2014)** — the standard approach. Uses a priority queue (min-heap) seeded with edge cells. Pops the lowest cell, raises neighbors that are lower than it (filling depressions to their pour point), pushes them onto the queue. O(n log n) for the heap variant. The "ε variant" adds a tiny increment to each filled cell so filled areas drain outward rather than becoming flats.

An alternative is **breaching** (Lindsay 2016) — instead of raising depressions, it carves channels through barriers. Produces more realistic drainage on landscapes with road embankments or levees. More complex to implement (requires finding least-cost breach paths). Not planned for Phase 2 but worth noting.

**Implementation plan:** Priority-flood in JS (api.js), not atra. The priority queue is a variable-size data structure with insert/extract-min — not a fixed-stride pixel loop. Atra excels at tight per-pixel kernels with predictable memory access; a heap doesn't fit that pattern. The inner loop is simple (compare + conditionally raise), so JS overhead is minimal relative to the queue operations.

### Flow direction

**D8 (O'Callaghan & Mark 1984)** — each cell points to the steepest downhill neighbor among 8 compass directions. Simple, deterministic, widely used. Output is a power-of-2 encoding (1, 2, 4, 8, 16, 32, 64, 128) for the 8 directions, 0 for sinks/flats. Diagonal neighbors use `√2 × cellSize` for slope comparison.

Other methods exist (D-infinity: Tarboton 1997 — continuous angle, splits flow proportionally; MFD: multiple flow directions weighted by slope) but D8 is the right starting point: simple, fast, sufficient for watershed delineation and stream extraction.

**Implementation plan:** Atra kernel. Classic per-pixel loop: read 3×3 neighborhood, compute slope to each neighbor (accounting for diagonal distance), pick steepest. Perfect fit for Wasm — fixed-stride, no branching data structures.

### Flow accumulation

**Topological sort approach:** Build the dependency graph from the flow direction grid. Process cells in upstream-to-downstream order (reverse topological sort). Each cell adds its own count (1) plus its accumulated upstream count to its downstream neighbor. O(n) after the sort.

In practice, this is implemented by:
1. Compute in-degree for each cell (count how many neighbors flow INTO it)
2. Seed a queue with all cells that have in-degree 0 (headwater cells)
3. BFS: dequeue a cell, add its accumulation to its downstream neighbor, decrement that neighbor's in-degree. When in-degree reaches 0, enqueue it.

This is a BFS traversal, not a per-pixel kernel — each cell is visited exactly once but in data-dependent order. Similar to priority-flood, the queue makes this better suited to JS than atra.

**Recursive alternative:** Walk upstream from each cell recursively. Elegant but O(n) stack depth in the worst case (long river = deep recursion). Atra's `tailcall` compiles to Wasm `return_call` (constant stack space), but flow accumulation isn't tail-recursive — a cell with multiple upstream tributaries must sum ALL their contributions before returning, so the recursive call can't be in tail position. The BFS/topological approach avoids recursion entirely.

**Implementation plan:** JS (api.js). The flow direction grid (from atra) is the input; accumulation is a BFS traversal over it.

### Watershed delineation

**Upstream BFS from seed points:** Given a flow direction grid and seed points (pour points / outlets), propagate basin labels upstream. For each seed, BFS to all cells whose flow path eventually reaches that seed. Each cell gets the label of its basin.

Implementation: Initialize labels array with seed labels. Use a queue. For each cell in the queue, check all 8 neighbors — if a neighbor's flow direction points TO this cell, assign it the same label and enqueue it. O(n) total.

**Implementation plan:** JS (api.js). Another BFS traversal over the flow direction grid.

### Stream network extraction

**Threshold on flow accumulation:** Cells with accumulation above a threshold are "stream" cells. Extract connected stream segments as polylines. Can assign Strahler order: headwater streams = order 1, confluence of two order-k streams = order k+1, confluence of different orders = max.

Not planned for Phase 2 (can be done as a post-processing step in user code) but the flow accumulation grid makes it trivial.

### Derived indices

- **TWI (Topographic Wetness Index):** `ln(accumulation × cellArea / tan(slope))` — predicts soil moisture. Requires both flow accumulation and slope grids.
- **Stream Power Index:** `accumulation × tan(slope)` — predicts erosion potential.

These are simple per-pixel formulas on existing grids — could be atra kernels or one-liners in user code.

### What goes in atra vs JS (hydrology)

| Algorithm | Where | Why |
|-----------|-------|-----|
| D8 flow direction | atra | Per-pixel 3×3 kernel, fixed stride, pure math |
| Priority-flood fill | JS | Priority queue (variable-size heap), not a pixel loop |
| Flow accumulation | JS | BFS traversal in data-dependent order |
| Watershed BFS | JS | Queue-based upstream traversal |
| TWI / stream power | either | Simple per-pixel formula on existing grids |

### On atra's tail call and recursion

Atra's `tailcall` compiles to Wasm `return_call` — constant stack space recursion. This is valuable for algorithms expressible as tail recursion (e.g., iterative refinement, state machines, tree walks where you only follow one branch). However, the core hydrology algorithms don't benefit:

- **Flow accumulation** is NOT tail-recursive. A cell at a confluence receives flow from multiple upstream tributaries. You must sum all of them before passing the result downstream — the recursive calls aren't in tail position.
- **Priority-flood** is iterative (heap-based), not recursive.
- **Watershed BFS** is iterative (queue-based), not recursive.

The right pattern for these is iterative traversal (BFS/topological sort), which maps naturally to JS loops over typed arrays. Atra's strength remains in the per-pixel kernels (D8 direction, TWI) where every cell gets the same fixed computation.

## Roadmap

### Phase 1 — Core terrain (first implementation)
- [x] slope, aspect, hillshade, terrain (fused)
- [x] TRI, TPI, roughness
- [x] contour (JS marching squares)
- [x] tests for all above

### Phase 2 — Hydrology
- [x] fillSinks — priority-flood in JS (Barnes et al. 2014, ε variant)
- [x] flowDirection — D8 in atra (per-pixel 3×3 kernel)
- [x] flowAccumulation — topological sort BFS in JS
- [x] watershed — upstream BFS in JS
- [x] tests

### Phase 3 — Advanced
- [x] curvature (profile, plan, mean)
- [ ] viewshed (ray-cast from observer point)
- [ ] variable cell size (non-square cells for geographic coordinates)
- [ ] optional WebGPU path for large grids (>10M pixels)

### Phase 4 — Spinifex integration
- [ ] DEM methods delegating to raster
- [ ] Replace GDAL slope/aspect/hillshade/contour for default case
- [ ] Keep GDAL as fallback for reprojection, format conversion
