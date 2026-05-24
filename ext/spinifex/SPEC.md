# spinifex

**Web GIS for the browser** — map rendering, geodata loaders, terrain, drawing, all client-side.

Spinifex wraps [OpenLayers 10](https://openlayers.org) with a thin convenience API and adds the bits OL doesn't ship by default: SRTM elevation tiles with IndexedDB cache, DEM sampling and profile tools, drawing interactions, and a GDAL Wasm bridge for the rasters/formats OL can't read natively. Designed for geoscientific notebooks where the data and the analysis stay in the same tab.

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 0.1                                            |
| Status     | Pre-1.0; shipped 2026                          |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | OpenLayers 2/3/10; GDAL; QGIS                  |

---

## Lineage

OpenLayers has been the web's serious open-source map library for 20 years — descended from MetaCarta's MapServer client, refactored twice (OL3, OL10), used by every major government and university mapping portal that doesn't pay for ArcGIS or Mapbox. The data model (Map, View, Layer, Source, Feature, Style, Interaction) is well-shaped for "show geography, let the user click on it, get features out."

Spinifex doesn't replace OpenLayers — it wraps the 10% of OL most geoscience notebooks reach for, and adds the 90% they need that OL doesn't ship: SRTM tile retrieval and caching, DEM mathematics (sampling, profiles, derivatives), and a GDAL bridge for the long tail of formats. Roughly the same role [Folium](https://python-visualization.github.io/folium/) plays for Leaflet in Python: a curated wrapper that makes interactive maps feel like a one-liner.

Named after [Triodia](https://en.wikipedia.org/wiki/Triodia_(plant)) (spinifex grass) — Australian outback, tough, everywhere. Lives in `ext/spinifex/`; the load entry is `spx.*`.

## Premise

Three commitments drive the design:

1. **Browser-resident, no server.** Spinifex assumes a tab with the user, their data, and the map rendering — all together. SRTM tiles come from a public S3 bucket (one HTTP GET per tile, cached in IndexedDB); geodata files come from the user's disk via `<input type="file">` or the notebook's VFS. No tile server to spin up, no proxy, no API key. The cost is no server-side spatial joins; the benefit is offline-after-first-fetch and zero ops.
2. **Vendored OL.** OpenLayers 10 is pinned at a specific version and tree-shaken via Rollup into `vendor/ol.bundle.js`. Updating OL is a deliberate build step, not a `npm install` away. Pays off in single-file deployability (auditable notebooks embed spinifex and OL together) and in shipping a known-good OL even when the user's network can't reach a CDN.
3. **Geoscience-first conventions.** Default basemap is a topographic raster (not a satellite or street layer). DEM sampling is bilinear (not nearest). Drawing tools default to amber-on-dark (GCU aesthetic). Coordinate display shows lat/lon in degrees with a configurable precision. These are choices a generic OL wrapper wouldn't make; spinifex is opinionated because the audience is.

## Concepts

### The `spx` namespace

The public API is a single namespace object — `spx.map`, `spx.srtm`, `spx.csv`, `spx.geojson`, `spx.shapefile`, `spx.geotiff`, `spx.draw`. Each call is a top-level convenience that returns a small wrapper object exposing the bits a notebook author actually uses (the underlying OL Layer/Source/Map is always reachable via `.ol` if you need lower-level access).

```js
const map = spx.map('#map', { center: [-43.5, -20.25], zoom: 10, basemap: 'topo' });
const dem = await spx.srtm(map, [-44, -21, -43, -20]);
const points = await spx.csv(map, 'samples.csv', { lon: 'longitude', lat: 'latitude' });
```

The wrappers add the conveniences (`.fit()`, `.remove()`, `.toggle()`); the underlying OL objects continue to work for anything not wrapped.

### Coordinate model

Spinifex defaults to **EPSG:4326** (lat/lon, WGS-84) for inputs and **EPSG:3857** (Web Mercator) for the map projection. Loaders auto-detect column names case-insensitively (`lon`, `longitude`, `easting`, `x`, `coordx`, and their `lat` counterparts) and reproject on load. Other projections are loaded on demand via the proj4 bundle.

DEM sampling stays in geographic coordinates — the underlying tile is in SRTM's native projection but `dem.sample(lat, lon)` interpolates in lat/lon space. Profiles use Haversine distance (great-circle, spherical earth, ~0.5 % error vs. WGS-84 ellipsoid — acceptable for plotting).

### DEM data model

A DEM is a wrapper around a flat `Float32Array` plus georeferencing:

```js
{
  data:     Float32Array,     // row-major, north-edge first
  width:    number,
  height:   number,
  bbox:     [minLon, minLat, maxLon, maxLat],
  cellSize: [dx, dy],         // degrees per cell
  nodata:   number,           // sentinel; usually -32768
  min, max: number,           // computed from data, excluding nodata
}
```

Three operations on a DEM:

- `dem.sample(lat, lon)` — bilinear interpolation at a single point. Returns nodata if any of the 4 corner cells are nodata.
- `dem.profile(lat1, lon1, lat2, lon2, n)` — sample `n` points along the great-circle line. Returns `{ distance: [...], elevation: [...] }`.
- `dem.terrain()` — render as a styled tile via the canvas overlay (see "Terrain rendering" below).

Constructing a DEM directly from a `Float32Array` works for synthetic data; `spx.srtm()` does it from SRTM tiles; `spx.geotiff()` does it from arbitrary GeoTIFFs.

### Layer model

A `SpxLayer` is a thin wrapper around an OL `Layer`. The wrapper adds:

- `.fit(animate?)` — pan/zoom to the layer's extent.
- `.toggle(visible?)` — visibility shortcut.
- `.remove()` — detach from map and clean up.
- A name + a metadata blob (for the layer-panel UI).

Layers added via spinifex appear in a configurable side panel (toggleable, reorderable, drag-to-remove). The panel is opt-in — `spx.map(..., { layerPanel: false })` suppresses it.

### Tile keying and cache

SRTM tiles are 1°×1° chunks named `[NS]<lat>[EW]<lon>.hgt`. Keying:

```
tileKey(lat, lon)  →  "N20W044"     // for lat=-20.25, lon=-43.5: tile containing it
```

Negative-zero quirks are deliberately handled: `lat = -0.5` is in `S00`, not `N00`. The key generation handles all eight quadrants + equator/prime-meridian edges.

Cache strategy: IndexedDB-backed, one row per tile. On miss → fetch from S3 (`https://elevation-tiles-prod.s3.amazonaws.com/skadi/<region>/<key>.hgt.gz`) → decompress (gzip) → store. Tiles persist across page reloads.

Eviction is currently not implemented (the cache grows monotonically). Listed in open questions.

### Drawing interactions

`spx.draw(map, type)` adds an OL `Draw` interaction in the requested geometry type (`Point`, `LineString`, `Polygon`, `Circle`). The returned wrapper exposes:

- `.features` — getter for the array of drawn features (as GeoJSON).
- `.clear()` — remove all drawn features.
- `.stop()` — disable further drawing.
- `.onFinish(handler)` — fires when a feature is completed.

Drawn features render in the GCU amber accent by default; styling is overridable via a `style` option.

## Architecture

Lazy-loading of heavy deps is the major architectural choice. The base bundle (OL + proj4 + spinifex core) is ~507 KB; PapaParse, shpjs, and gdal3.js are loaded on first call to the relevant loader, from CDN. Net effect: cold-load time stays under 100 ms for users who don't touch the heavy formats.

```
src/
  main.js     — module loader (import order; pure concat)
  api.js      — public spx object (the import surface)
  deps.js     — lazy CDN loading (PapaParse, shpjs, gdal3.js)
  proj.js     — projection registration with proj4
  render.js   — styling defaults + DEM terrain canvas
  map.js      — map creation & control
  layers.js   — SpxLayer wrapper + layer-panel UI
  loaders.js  — CSV, GeoJSON, Shapefile, GeoTIFF
  srtm.js     — SRTM tiles + IndexedDB cache
  dem.js      — DEM sampling & profiles
  draw.js     — drawing interactions
  gdal.js     — GDAL Wasm loader & DEM tools

vendor/
  ol.bundle.js  — OpenLayers + proj4, tree-shaken, terser-minified
  build.js      — vendor bundle Rollup config
```

The `build.js` at package root concatenates `src/*` in `main.js`'s declared order, strips ESM import/export statements, and prepends the vendor bundle into a single `index.js`. ~30 KB of glue over ~480 KB of OL.

## Terrain rendering

When a DEM is added to the map, spinifex renders it via a Canvas overlay (one canvas per visible viewport, redrawn on pan/zoom). The render pipeline:

1. Clip the DEM to the visible bbox (skip cells outside).
2. For each visible cell, compute a normalized elevation in `[0, 1]` against the configured `[min, max]` range.
3. Look up the color from a 7-stop gradient (forest green → tan → brown → white).
4. Apply a simple Lambertian hillshade from the configured sun position (azimuth 315°, altitude 45° by default).
5. Composite via alpha blend.

Gradient stops are tuned for natural-looking terrain; configurable via `dem.colorRamp([{ at, color }, …])`. Hillshade is a multiplier on the diffuse color; not a separate layer.

The render is cell-by-cell on the canvas, not a Wasm raster pipeline — fine up to ~1 M cells (under a frame at 60 fps). For larger DEMs, downsample or switch to the GDAL-rendered tile path.

## GDAL integration

For formats OL can't read natively (NetCDF, complex GeoTIFF tags, ECW), spinifex falls back to GDAL via [gdal3.js](https://gdal3.js.org) — GDAL compiled to Wasm. Loaded on first call to `spx.geotiff()` for non-trivial inputs, or explicitly via `spx.gdal()`.

GDAL is also used for DEM derivatives (slope, aspect, hillshade) when the user wants algorithmic outputs rather than visual rendering — those flow through GDAL's `gdaldem` machinery and return a new raster. The lighter version of this lives in `@gcu/raster` for use cases that don't want the GDAL Wasm overhead.

## Open questions

- **Cache eviction policy.** IndexedDB grows monotonically right now. Need LRU + size cap (configurable), or age-based expiry. Listed in the roadmap.
- **Server-side tiling.** Hard-coding the SRTM endpoint as `elevation-tiles-prod.s3.amazonaws.com` is convenient but couples spinifex to AWS's pricing model. A tile-server abstraction (with the SRTM endpoint as the default) would let downstream consumers swap in their own.
- **WebGL renderer for DEM terrain.** Current canvas renderer is fine but caps at ~1 M cells. A WebGL shader pass for terrain rendering would scale further (and would compose with the existing `@gcu/shader` package).
- **Vector tiles (MVT).** OL supports them natively; spinifex doesn't expose a one-liner yet.
- **Feature inspection / attribute table.** Listed in roadmap. Click → popup → inspector pattern, plus a side-panel table view.
- **Coordinate system pivot.** Default `4326 → 3857` works for global rendering; UTM zones are a manual reproject. A `spx.crs('UTM', zone)` shortcut would help.

## Testing

54 tests in `test/spinifex.test.mjs` covering:

- **DEM** — constructor min/max with nodata, `sample()` bilinear at corners / center / between-pixels / OOB / nodata fallback, `profile()` array lengths + distance monotonicity + Haversine accuracy.
- **SRTM** — `tileKey()` all eight quadrants (N/S/E/W, zero padding, negative-zero edge case); `tileUrl()` S3 URL structure; `tilesForBbox()` single/multi/fractional/equator-crossing/empty.
- **Terrain rendering** — `terrainColor()` at ramp stops (0, 0.5, 1), clamping, interpolation between stops.
- **Loaders** — `detectColumn()` with lon/lat/easting/northing/x/y/coordx variants, case insensitivity, missing-column handling, whitespace trimming.
- **Haversine** — zero distance, 1° at equator, longitude at 60°N, antipodal, symmetry.

The browser-only paths (actual OL Map rendering, IDB cache I/O, drawing) are exercised by the examples notebook smoke under `npm run test:examples`.

## What spinifex is NOT

- **A full GIS.** No spatial joins, no topology, no projections-from-string registry beyond what proj4 has. For serious GIS work, this is the user's *display layer*; the analysis happens in `@gcu/raster`, `@gcu/scitra`, or a Python notebook with proper GeoPandas.
- **A QGIS replacement.** QGIS has thousands of plugins and a labelling engine and a layout composer. Spinifex has none of those and isn't trying to.
- **A 3D viewer.** The map is 2D. For 3D geological visualization, see `@gcu/dee` (Three.js-backed).
- **A tile server.** Tiles are pulled from a fixed SRTM endpoint or from arbitrary URLs the user passes. Hosting your own tiles is your job.
- **The grass.** That's the namesake. Tough Australian outback species; the package has the same "everywhere, doesn't fuss, just works" intent.

## Versioning

Pre-1.0 means the `spx.*` namespace shape may add functions; the underlying OL is pinned but exposed (`.ol` on wrappers) so consumers can reach in when needed. The DEM data model and SRTM tile-keying convention are stable.
