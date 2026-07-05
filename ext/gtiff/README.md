# @gcu/gtiff

A minimal, **WASM-free** GeoTIFF reader. Pure JS; deflate rides the
platform's `DecompressionStream`, so Sealed builds (CSP `connect-src
'none'`, no WASM) can carry it without breaking their claims.

## What it reads (v0.1)

- classic TIFF, little- or big-endian (BigTIFF punts with a clear error)
- **strips and tiles**, edge tiles clipped
- compression: none · **LZW** (early-change, libtiff-verified) ·
  **deflate** (8 / 32946) · PackBits
- predictors: 1 (none) · **2** (horizontal, 8/16/32-bit) · **3**
  (floating-point byte-plane)
- samples: uint/int/float at 8/16/32/64 bits; multi-band chunky reads
  band 0 (with a warning)
- the whole **IFD chain** — a COG's overview pyramid is `images[1..n]`,
  so a coarse full-extent read is one small decode
- geo: ModelPixelScale + ModelTiepoint (+ axis-aligned
  ModelTransformation), GeoKeys → `EPSG:n` **identity only — never a
  reprojection** (@gcu/frame's rule), PixelIsArea/Point, GDAL_NODATA

## API

```js
import { readGTiff, gridFromGTiff } from '@gcu/gtiff';

const g = await readGTiff(blobOrBytes);      // parses IFDs, no pixel decode
g.images[0];                                  // { width, height, compression, …, read() }
const data = await g.images[0].read();        // TypedArray, row-major, row 0 = top
g.geo;                                        // { origin, scale, pixelIsPoint, crs, nodata }

const grid = await gridFromGTiff(g /*, level */);
// { nx, ny, data, x0, y0, dx, dy, nodata, crs } — x0/y0 = SAMPLE (0,0)
// CENTER, row r's centre is y0 − r·dy (dy positive), overview levels
// inherit IFD0's geo scaled by the size ratio
```

Structural failures throw with plain messages; ignorable oddities land in
`warnings`.

## Verification

`test/gtiff.test.mjs` encodes its own fixtures (an in-test TIFF writer
with LZW/PackBits encoders + node:zlib deflate) and decodes them back —
every codec × layout × endianness path round-trips. The LZW early-change
timing is additionally verified byte-exact against Pillow/libtiff-written
files (int32 + float32 LZW, deflate).

## Roadmap

windowed reads (`readWindow` — decode only the tiles a view touches),
BigTIFF, a writer (mesh→grid rasterize export wants ESRI ASCII first,
GeoTIFF later). JPEG-in-TIFF (orthophotos) without a JS JPEG decoder:
stitch JPEGTables (tag 347) + each tile's bytes into a JFIF blob and let
the BROWSER decode it (`createImageBitmap`) — the platform already ships
the codec, same move as deflate-via-DecompressionStream.
