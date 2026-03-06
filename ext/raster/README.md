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

#### `raster.flowDirection(data, w, h, cellSize)`

D8 flow direction. Each cell points to its steepest downhill neighbor. Returns `Uint8Array` with values 1–128 (powers of 2, encoding 8 compass directions) or 0 (sink/flat).

```
 32  64  128
 16   0    1
  8   4    2
```

#### `raster.flowAccumulation(data, w, h, cellSize)`

Number of upstream cells flowing into each cell. Requires filled DEM (no sinks). Returns `Float32Array`.

#### `raster.fillSinks(data, w, h)`

Priority-flood sink filling (Barnes et al. 2014). Returns a new `Float32Array` with depressions filled to their pour point. Does not modify the input.

#### `raster.watershed(data, w, h, cellSize, seeds)`

Watershed delineation from seed points. `seeds` is an array of `[col, row]` pixel coordinates. Returns `Int32Array` with basin labels (0 = unassigned, 1+ = basin ID matching seed order).

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

## Roadmap

### Phase 1 — Core terrain (first implementation)
- [x] slope, aspect, hillshade, terrain (fused)
- [x] TRI, TPI, roughness
- [x] contour (JS marching squares)
- [x] tests for all above

### Phase 2 — Hydrology
- [ ] fillSinks (priority-flood)
- [ ] flowDirection (D8)
- [ ] flowAccumulation
- [ ] watershed
- [ ] tests

### Phase 3 — Advanced
- [ ] curvature (profile, plan, mean)
- [ ] viewshed (ray-cast from observer point)
- [ ] variable cell size (non-square cells for geographic coordinates)
- [ ] optional WebGPU path for large grids (>10M pixels)

### Phase 4 — Spinifex integration
- [ ] DEM methods delegating to raster
- [ ] Replace GDAL slope/aspect/hillshade/contour for default case
- [ ] Keep GDAL as fallback for reprojection, format conversion
