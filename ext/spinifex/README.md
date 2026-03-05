# spinifex

Web GIS for auditable notebooks. Map rendering, geodata loaders, SRTM elevation, drawing interactions, GDAL processing. Built on OpenLayers 10, runs entirely in the browser.

```js
const { spx } = await load("./ext/spinifex/index.js");

const map = spx.map("#map", { center: [-43.5, -20.25], zoom: 10, basemap: "topo" });
const dem = await spx.srtm(map, [-44, -21, -43, -20]);
const elev = dem.data.sample(-20.5, -43.5);  // bilinear elevation lookup
```

~1,260 lines of source across 11 modules. Bundles to a single `index.js` (~507 KB including vendored OL + proj4).

---

## API

### `spx.map(target, opts?)`

Create an interactive map.

```js
const map = spx.map("#map", {
  center: [-43.5, -20.25],  // [lon, lat]
  zoom: 10,
  basemap: "topo"            // "topo" | "osm" | "satellite"
});
```

**Returns** a map wrapper with:

| Property/Method | Description |
|----------------|-------------|
| `bounds` | `[west, south, east, north]` in WGS84 (getter) |
| `center` | `[lon, lat]` (getter/setter) |
| `zoom` | number (getter/setter) |
| `fitBounds(bbox, padding?)` | Fit view to extent |
| `setBasemap(name)` | Swap tile source |
| `ol` | Raw OpenLayers map instance |

### `spx.srtm(map, bounds?, opts?)`

Download SRTM GL1 elevation tiles (30m resolution) from AWS S3, mosaic them, render as a terrain layer.

```js
const dem = await spx.srtm(map, [-44, -21, -43, -20], {
  name: "SRTM",
  onProgress: (tileName, i, total) => console.log(`${tileName} (${i}/${total})`)
});
```

**Bounds** can be: `[west, south, east, north]` array, a layer with `.bounds`, or omitted to use the map's current view.

**Returns** a `SpxLayer` with DEM methods attached:

| Property/Method | Description |
|----------------|-------------|
| `data` | `DEM` instance |
| `sample(lat, lon)` | Bilinear elevation lookup, returns meters or `null` |
| `profile(latA, lonA, latB, lonB, opts?)` | Cross-section extraction |
| `width`, `height` | Grid dimensions |
| `min`, `max` | Elevation range (meters) |
| `bbox` | `[west, south, east, north]` |

**Profile result:**

```js
const p = dem.data.profile(-20.3, -43.8, -20.5, -43.2, { samples: 500 });
// p.dist  — Float64Array, cumulative distance in meters (Haversine)
// p.elev  — Float32Array, sampled elevations
// p.lat   — Float64Array
// p.lon   — Float64Array
```

**Tile caching:** tiles are automatically cached in IndexedDB (`spx-srtm` database) as raw gzipped bytes (~2.5 MB each). Subsequent loads skip the network fetch. See [Cache management](#cache-management) below.

**Limits:** max 16 tiles per request. Each tile covers 1\u00b0\u00d71\u00b0 at 3601\u00d73601 pixels.

### `spx.csv(map, source, opts?)`

Load CSV with auto-detected coordinate columns.

```js
const layer = await spx.csv(map, "data.csv", { name: "Samples" });
// layer.data — parsed rows as array of objects
```

Detects columns named `lon/longitude/lng/x/easting` and `lat/latitude/y/northing`. Falls back to data-only layer (no map geometry) if coordinates aren't found. Source can be a URL, text string, File, or Blob. Uses PapaParse (lazy-loaded from CDN).

### `spx.geojson(map, data, opts?)`

Load GeoJSON.

```js
const layer = spx.geojson(map, geojsonObject, { name: "Boundary", crs: "EPSG:4326" });
```

### `spx.shp(map, source, opts?)`

Load Shapefile.

```js
const layer = await spx.shp(map, file, { name: "Geology" });
```

Source: ArrayBuffer, File, Blob, or URL. Uses shpjs (lazy-loaded from CDN).

### `spx.tif(map, source, opts?)`

Load GeoTIFF (supports Cloud-Optimized GeoTIFF streaming).

```js
const layer = await spx.tif(map, "https://example.com/dem.tif");
```

Renders as WebGL tile layer. Source: URL string, ArrayBuffer, File, or Blob.

### `spx.load(map, file)`

Auto-detect format by extension and load.

```js
const layer = await spx.load(map, file);
```

Supports `.csv`, `.geojson`/`.json`, `.shp`/`.zip`, `.tif`/`.tiff`. Falls back to GDAL for unrecognized formats (if GDAL is loaded).

### `spx.draw(map, type, opts?)`

Interactive drawing. Returns a promise that resolves when the user finishes.

```js
const pt = await spx.draw(map, "point");
// pt.coord — [lon, lat]

const line = await spx.draw(map, "polyline", { maxPoints: 2 });
// line.coords — [[lon, lat], ...]

const poly = await spx.draw(map, "polygon");
// poly.coords — [[lon, lat], ...]

const rect = await spx.draw(map, "rectangle");
// rect.extent — [west, south, east, north]
```

### `spx.proj(code, def)`

Register a custom CRS definition.

```js
spx.proj("EPSG:31983", "+proj=utm +zone=23 +south +datum=WGS84 +units=m");
```

### GDAL processing

Full GDAL via Wasm (gdal3.js@2), lazy-loaded on first use. Unlocks contour generation, slope/aspect/hillshade, and universal format support for anything GDAL can read.

#### `spx.gdal()`

Pre-load the GDAL Wasm runtime (~5 MB). Called automatically by other GDAL functions on first use.

```js
await spx.gdal();
```

#### `spx.load(map, file)` with GDAL fallback

When `spx.load()` can't match the file extension to a built-in loader, it falls back to GDAL. GDAL auto-detects vector vs raster, converts internally (ogr2ogr to GeoJSON, gdal_translate to GeoTIFF), and returns a layer.

```js
const layer = await spx.load(map, file);   // .gpkg, .kml, .gdb, .ecw, etc.
```

#### `spx.contour(dem, opts?)`

Generate contour lines from a DEM as GeoJSON.

```js
const geojson = await spx.contour(dem.data, {
  interval: 100,      // contour interval in meters (default: 100)
  attribute: "elev"   // elevation attribute name (default: "elev")
});
// geojson — standard GeoJSON FeatureCollection of LineStrings
```

Display on the map:

```js
const contourLayer = spx.geojson(map, geojson, { name: "Contours" });
```

#### `spx.slope(dem)`

Compute slope raster from a DEM. Returns raw GeoTIFF bytes as ArrayBuffer.

```js
const slopeBuf = await spx.slope(dem.data);
const slopeLayer = await spx.tif(map, slopeBuf, { name: "Slope" });
```

#### `spx.aspect(dem)`

Compute aspect raster from a DEM. Returns raw GeoTIFF bytes as ArrayBuffer.

```js
const aspectBuf = await spx.aspect(dem.data);
const aspectLayer = await spx.tif(map, aspectBuf, { name: "Aspect" });
```

#### `spx.hillshade(dem, opts?)`

Compute hillshade raster from a DEM. Returns raw GeoTIFF bytes as ArrayBuffer.

```js
const hsBuf = await spx.hillshade(dem.data, { azimuth: 315 });
const hsLayer = await spx.tif(map, hsBuf, { name: "Hillshade" });
```

#### How it works

DEM processing functions build a minimal GeoTIFF in memory (raw Float32 data with TIFF IFD headers), pass it to GDAL Wasm, and return the output. This means any `DEM` object from `spx.srtm()` can be processed directly — no file I/O, no server, everything in-browser.

### Cache management

SRTM tiles are cached in IndexedDB to avoid re-downloading.

```js
await spx.cache.list()            // [{key: 'S21W044', size: 2621440, ts: 1709654400000}, ...]
await spx.cache.size()            // {count: 3, bytes: 7864320}
await spx.cache.delete('S21W044') // remove one tile
await spx.cache.clear()           // remove all tiles
```

---

## Layers

All loaders return a `SpxLayer` wrapping an OpenLayers layer.

```js
layer.show()
layer.hide()
layer.remove()
layer.zoomTo()
layer.visible      // getter
layer.bounds       // [west, south, east, north] or null
layer.name         // string
layer.type         // 'csv' | 'geojson' | 'shp' | 'tif' | 'srtm'
layer.data         // raw data (rows, GeoJSON, DEM, etc.)
layer.ol           // raw OpenLayers layer instance
```

A floating layer panel appears automatically when layers are added (toggle visibility, double-click to zoom).

---

## DEM

The `DEM` class handles elevation sampling and profile extraction.

```js
const dem = new DEM(float32Array, width, height, [west, south, east, north]);
dem.sample(lat, lon)                             // bilinear interpolation, null if OOB
dem.profile(latA, lonA, latB, lonB, {samples})   // cross-section
dem.min, dem.max                                 // elevation range (excluding nodata)
```

Nodata value is -9999. Rendering uses a 7-stop terrain color ramp (green \u2192 brown \u2192 white) with hillshade. Downsamples to 2048\u00d72048 max for canvas rendering.

---

## Architecture

### Modules

```
src/
  main.js       11 lines    module loader (import order)
  api.js        26 lines    public spx object
  deps.js       26 lines    lazy CDN loading (PapaParse, shpjs)
  proj.js        6 lines    projection registration
  render.js    118 lines    styling + DEM terrain canvas
  map.js        97 lines    map creation & control
  layers.js    106 lines    SpxLayer wrapper + layer panel UI
  loaders.js   240 lines    CSV, GeoJSON, Shapefile, GeoTIFF
  srtm.js      263 lines    SRTM tiles + IndexedDB cache
  dem.js        91 lines    DEM sampling & profiles
  draw.js       62 lines    drawing interactions
  gdal.js      216 lines    GDAL Wasm loader & DEM tools
```

### Dependencies

| Dependency | Version | Loading |
|-----------|---------|---------|
| OpenLayers | 10.5.0 | Vendored, tree-shaken |
| proj4 | 2.15.0 | Vendored |
| PapaParse | 5.x | Lazy-loaded from CDN (CSV) |
| shpjs | 6.x | Lazy-loaded from CDN (Shapefile) |
| gdal3.js | 2.x | Lazy-loaded from CDN (fallback formats) |

### Build

```bash
node ext/spinifex/build.js    # bundle src/ into index.js
```

The build concatenates ES modules in import order, strips import/export statements, and prepends a vendored OL + proj4 bundle. The vendored bundle is built separately via `vendor/build.js` (Rollup + terser).

---

## Styling

GCU aesthetic: amber (#c89b3c) accent for points, lines, and polygon fills. Default styles are dispatched by geometry type. Terrain rendering uses a 7-stop gradient from forest green (low elevation) through brown to white (high elevation), alpha-blended with a simple hillshade.

---

## Testing

No tests yet. Priority targets (all pure-math, no browser needed):

- **dem.js** — `sample()` bilinear interpolation (interior, edges, corners, nodata neighbors, out-of-bounds), `profile()` distance/elevation arrays, Haversine accuracy
- **srtm.js** — `tileKey()` for all quadrants (N/S/E/W, zero-padding), `tileUrl()` folder structure, `tilesForBbox()` tile enumeration and edge cases, IDB cache round-trip (`tilePut`/`tileGet`), mosaic overlap math
- **render.js** — `terrainColor()` at ramp boundaries (0, 0.5, 1) and interpolation between stops
- **loaders.js** — CSV column auto-detection (lon/latitude/easting/x variants, case sensitivity, missing columns)

---

## Roadmap

### Infrastructure
- Tests for pure-math functions (see Testing section above)
- Add spinifex to CLAUDE.md project structure and build checklist
- Build-time size tracking

### Feature interaction
- Click/hover on features to inspect attributes (popup/tooltip)
- Attribute table for loaded vector data
- Feature selection by click, box, or polygon
- Style-by-attribute: color/size features based on column values
- Custom style functions passed to loaders

### Map controls
- Coordinate display on mouse move
- Scale bar (`ol.control.ScaleLine`)
- Map export as PNG/JPEG
- Measurement tools (distance, area)

### Tile management
- LRU eviction policy for IDB cache (configurable max size)
- Cache age expiry
- Pre-fetch tiles for visible extent

### Data formats
- KML/KMZ loader (native, without GDAL)
- GPX loader (native, without GDAL)
- WMS/WMTS layer support
- Vector tile support (MVT)

### DEM processing
- Pure-JS slope/aspect/hillshade (lightweight alternative to GDAL for simple cases)
- Viewshed analysis
- Watershed delineation
- Volume calculation between surfaces
- Configurable color ramps for DEM rendering

### Drawing
- Edit/modify drawn features after creation
- Snap to existing features
- Drawing undo/redo
- Export drawn features as GeoJSON

### Integration
- Bridge to gslib/atra for geostatistical workflows on DEM data
- Spatial query: select features by extent, polygon, or buffer
