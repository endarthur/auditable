# spinifex — Web GIS

**spinifex** is a GIS module wrapping OpenLayers 10. Map rendering, geodata loaders, SRTM
elevation tiles, drawing interactions, DEM processing, and GDAL Wasm support — all running
entirely in the browser.

## Quick Start

```js
const sp = await load("@spinifex");

// create a map centered on Minas Gerais, Brazil
const map = sp.map("#map", { center: [-43.5, -20.25], zoom: 10, basemap: "topo" });

// load SRTM elevation data
const dem = await sp.srtm(map, [-44, -21, -43, -20]);

// sample elevation at a point
const elev = dem.data.sample(-20.5, -43.5);  // bilinear interpolation, meters
```

The module is loaded via `load("@spinifex")` which returns the `spx` API object.

---

## Map Creation

### `sp.map(target, opts?)`

Create an interactive map in a DOM element.

```js
const map = sp.map("#map", {
  center: [-43.5, -20.25],  // [lon, lat]
  zoom: 10,
  basemap: "topo"
});
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `center` | `[0, 0]` | `[lon, lat]` initial center |
| `zoom` | `2` | Initial zoom level |
| `basemap` | `"topo"` | `"topo"` \| `"osm"` \| `"satellite"` or custom tile URL |
| `scalebar` | `true` | Show scale bar |
| `scaleUnits` | `"metric"` | `"metric"` \| `"imperial"` \| `"nautical"` |
| `coordinates` | `true` | Show lat/lon at cursor position |

**Map object:**

| Property / Method | Description |
|-------------------|-------------|
| `bounds` | `[west, south, east, north]` in WGS84 (getter) |
| `center` | `[lon, lat]` (getter/setter) |
| `zoom` | Zoom level (getter/setter) |
| `fitBounds(bbox, padding?)` | Fit view to extent |
| `setBasemap(name)` | Swap tile source |
| `exportImage(type?)` | Export map as data URL (default `"image/png"`) |
| `measure(type?)` | Interactive measurement (`"distance"` or `"area"`) |
| `ol` | Raw OpenLayers map instance |

---

## Layers

All loaders return a `SpxLayer` wrapping an OpenLayers layer. A floating layer panel
appears automatically when layers are added.

| Property / Method | Description |
|-------------------|-------------|
| `show()` | Make layer visible |
| `hide()` | Hide layer |
| `remove()` | Remove layer from map |
| `zoomTo()` | Fit map to layer extent |
| `visible` | Visibility state (getter) |
| `bounds` | `[west, south, east, north]` or `null` |
| `name` | Layer name (string) |
| `type` | `"csv"` \| `"geojson"` \| `"shp"` \| `"tif"` \| `"srtm"` |
| `data` | Raw data (rows, GeoJSON, DEM, etc.) |
| `ol` | Raw OpenLayers layer instance |

---

## Data Loaders

### `sp.csv(map, source, opts?)`

Load CSV with auto-detected coordinate columns.

```js
const layer = await sp.csv(map, "data.csv", { name: "Samples" });
// layer.data — parsed rows as array of objects
```

Detects columns named `lon`/`longitude`/`lng`/`x`/`easting` and
`lat`/`latitude`/`y`/`northing`. Falls back to a data-only layer (no map geometry) if
coordinates are not found. Source can be a URL, text string, File, or Blob. Uses PapaParse
(lazy-loaded from CDN).

### `sp.geojson(map, data, opts?)`

Load GeoJSON features onto the map.

```js
const layer = sp.geojson(map, geojsonObject, { name: "Boundary", crs: "EPSG:4326" });
```

### `sp.shp(map, source, opts?)`

Load Shapefile. Source: ArrayBuffer, File, Blob, or URL. Uses shpjs (lazy-loaded from CDN).

```js
const layer = await sp.shp(map, file, { name: "Geology" });
```

### `sp.tif(map, source, opts?)`

Load GeoTIFF (supports Cloud-Optimized GeoTIFF streaming). Renders as a WebGL tile layer.
Source: URL string, ArrayBuffer, File, or Blob.

```js
const layer = await sp.tif(map, "https://example.com/dem.tif");
```

### `sp.load(map, file)`

Auto-detect format by file extension and load. Supports `.csv`, `.geojson`/`.json`,
`.shp`/`.zip`, `.tif`/`.tiff`. Falls back to GDAL for unrecognized formats (if GDAL is
loaded).

```js
const layer = await sp.load(map, file);
```

---

## SRTM Elevation Tiles

### `sp.srtm(map, bounds?, opts?)`

Download SRTM GL1 elevation tiles (30m resolution) from AWS S3, mosaic them, and render as
a terrain layer.

```js
const dem = await sp.srtm(map, [-44, -21, -43, -20], {
  name: "SRTM",
  onProgress: (tileName, i, total) => console.log(`${tileName} (${i}/${total})`)
});
```

**Bounds** can be a `[west, south, east, north]` array, a layer with `.bounds`, or omitted
to use the map's current view.

**Limits:** max 16 tiles per request. Each tile covers 1 degree x 1 degree at 3601 x 3601
pixels.

**Returns** a `SpxLayer` with DEM methods attached:

| Property / Method | Description |
|-------------------|-------------|
| `data` | `DEM` instance |
| `data.sample(lat, lon)` | Bilinear elevation lookup (meters or `null`) |
| `data.profile(latA, lonA, latB, lonB, opts?)` | Cross-section extraction |
| `data.width`, `data.height` | Grid dimensions |
| `data.min`, `data.max` | Elevation range (meters) |
| `data.bbox` | `[west, south, east, north]` |

### Tile Caching

SRTM tiles are cached in IndexedDB (`spx-srtm` database) as raw gzipped bytes (~2.5 MB
each). Subsequent loads skip the network.

```js
await sp.cache.list()            // [{key: 'S21W044', size: 2621440, ts: ...}, ...]
await sp.cache.size()            // {count: 3, bytes: 7864320}
await sp.cache.delete('S21W044') // remove one tile
await sp.cache.clear()           // remove all tiles
```

---

## DEM Sampling and Profiles

The `DEM` object (available as `dem.data` from `sp.srtm()`) supports elevation queries and
cross-section extraction.

### Sampling

```js
const elev = dem.data.sample(-20.5, -43.5);  // returns meters, or null if out of bounds
```

Uses bilinear interpolation. Nodata value is -9999.

### Profiles

Extract a cross-section between two geographic points:

```js
const p = dem.data.profile(-20.3, -43.8, -20.5, -43.2, { samples: 500 });
// p.dist  — Float64Array, cumulative distance in meters (Haversine)
// p.elev  — Float32Array, sampled elevations
// p.lat   — Float64Array
// p.lon   — Float64Array
```

The default sample count is 500.

---

## Drawing Interactions

### `sp.draw(map, type, opts?)`

Interactive drawing. Returns a promise that resolves when the user finishes drawing.

```js
const pt = await sp.draw(map, "point");
// pt.coord — [lon, lat]

const line = await sp.draw(map, "polyline", { maxPoints: 2 });
// line.coords — [[lon, lat], ...]

const poly = await sp.draw(map, "polygon");
// poly.coords — [[lon, lat], ...]

const rect = await sp.draw(map, "rectangle");
// rect.extent — [west, south, east, north]
```

---

## Measurement

### `map.measure(type?)`

Interactive distance or area measurement. Returns a promise that resolves when drawing is
complete.

```js
const m = await map.measure('distance');
// m.distance — total distance in meters
// m.coords   — [[lon, lat], ...]
// m.layer    — the drawn feature layer

const a = await map.measure('area');
// a.area   — area in square meters
// a.coords — [[lon, lat], ...]
// a.layer  — the drawn feature layer
```

The measurement geometry stays on the map with a dashed amber stroke. Remove it with
`m.layer.remove()` when done.

---

## Map Export

### `map.exportImage(type?)`

Export the current map view as a data URL. Composites all visible layers.

```js
const dataUrl = await map.exportImage();            // PNG
const jpegUrl = await map.exportImage('image/jpeg'); // JPEG

// display inline
const img = document.createElement('img');
img.src = dataUrl;
ui.display(img);
```

---

## GDAL Wasm Processing

Full GDAL via Wasm (gdal3.js), lazy-loaded on first use (~5 MB). Provides contour
generation, terrain analysis, and universal format support for anything GDAL can read.

### `sp.gdal()`

Pre-load the GDAL Wasm runtime. Called automatically by other GDAL functions on first use.

```js
await sp.gdal();
```

### `sp.contour(dem, opts?)`

Generate contour lines from a DEM as GeoJSON.

```js
const geojson = await sp.contour(dem.data, {
  interval: 100,      // contour interval in meters (default: 100)
  attribute: "elev"   // elevation attribute name (default: "elev")
});
// geojson — GeoJSON FeatureCollection of LineStrings

const contourLayer = sp.geojson(map, geojson, { name: "Contours" });
```

### `sp.slope(dem)`

Compute slope raster from a DEM. Returns GeoTIFF bytes as ArrayBuffer.

```js
const slopeBuf = await sp.slope(dem.data);
const slopeLayer = await sp.tif(map, slopeBuf, { name: "Slope" });
```

### `sp.aspect(dem)`

Compute aspect raster from a DEM. Returns GeoTIFF bytes as ArrayBuffer.

```js
const aspectBuf = await sp.aspect(dem.data);
const aspectLayer = await sp.tif(map, aspectBuf, { name: "Aspect" });
```

### `sp.hillshade(dem, opts?)`

Compute hillshade raster from a DEM. Returns GeoTIFF bytes as ArrayBuffer.

```js
const hsBuf = await sp.hillshade(dem.data, { azimuth: 315 });
const hsLayer = await sp.tif(map, hsBuf, { name: "Hillshade" });
```

!!! info "How GDAL processing works"
    DEM processing functions build a minimal GeoTIFF in memory (raw Float32 data with
    TIFF IFD headers), pass it to GDAL Wasm, and return the output. Any `DEM` object from
    `sp.srtm()` can be processed directly — no file I/O, no server.

### GDAL Format Fallback

When `sp.load()` encounters an unrecognized file extension, it falls back to GDAL. GDAL
auto-detects vector vs raster, converts internally (ogr2ogr to GeoJSON, gdal_translate to
GeoTIFF), and returns a layer.

```js
const layer = await sp.load(map, file);   // .gpkg, .kml, .gdb, .ecw, etc.
```

---

## Projections

### `sp.proj(code, def)`

Register a custom CRS definition using proj4 syntax.

```js
sp.proj("EPSG:31983", "+proj=utm +zone=23 +south +datum=WGS84 +units=m");
```

Registered projections are available to all loaders. Use the `crs` option in loaders to
specify the source CRS of input data when it differs from WGS84 (EPSG:4326).

---

## Dependencies

| Dependency | Loading | Purpose |
|-----------|---------|---------|
| OpenLayers 10 | Vendored (tree-shaken) | Map rendering, layers, interactions |
| proj4 | Vendored | Coordinate transformations |
| PapaParse | Lazy-loaded from CDN | CSV parsing |
| shpjs | Lazy-loaded from CDN | Shapefile reading |
| gdal3.js | Lazy-loaded from CDN | Raster/vector processing, format conversion |
