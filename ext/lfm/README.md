# @gcu/lfm

Reader and writer for Leapfrog Model files (`.lfm`) — the Leapfrog Geo / Edge mesh export format for triangulated geological domain models (lithology / alteration / intrusion shells).

Single-file ESM, zero runtime deps, browser-only (uses `DOMParser`, `DecompressionStream` / `CompressionStream`, `crypto.subtle`).

## Usage

```js
import { readLFM, writeLFM, LFMError } from '@gcu/lfm';

// Read
const result = await readLFM(arrayBuffer, {
  onProgress: msg => console.log(msg),
});
// result: { collectionName, version, meshes: [{name, colour, attributes,
//          vertices: Float64Array, triangles: Int32Array, vCount, tCount}], binary }

// Read-modify-write
result.meshes[0].colour = { r: 255, g: 100, b: 50 };
const buffer = await writeLFM(result);
const blob = new Blob([buffer], { type: 'application/x-leapfrog-model' });
```

Returned coordinates are unmodified — in the file's native CRS (typically a UTM-like grid in metres). Recentring is a rendering concern, not a parsing one — see the rendering recipe in the project's spec for the gotchas (WebGL `float32` precision at large absolute coordinates, polygon-offset for shared geological contacts, etc.).

## Validation

`readLFM` throws `LFMError` for any LFM-specific failure: bad SHA-256, unsupported `datatype`/`compression`/`endian`, out-of-range triangle indices, declared-vs-decompressed-size mismatch. Other thrown values (e.g. `DecompressionStream` errors from a corrupt zlib stream) bubble up unwrapped.

`writeLFM` runs the same invariants before emitting bytes.

## Rendering with @gcu/dee

If you also use `@gcu/dee` (a Three.js scene layer), there's a thin adapter:

```js
import { readLFM } from '@gcu/lfm';
import { addLFMtoDee, lfmCentroid } from '@gcu/lfm/dee-adapter';
import * as dee from '@gcu/dee';

const result = await readLFM(arrayBuffer);
const scene = dee.create(container, {
  origin: lfmCentroid(result),  // recentres coordinates for f32 precision
  THREE,
});
const layers = addLFMtoDee(scene, result, { opacity: 0.7 });
// layers[i]._meta = { storedColour, attributes, volume, vCount, tCount }
```

The adapter handles four conventions specific to nested geological domain rendering:

- **Coordinate recentring**: vertices are subtracted by `dee.origin` in F64 *before* the f32 downcast, so f32 storage holds local-scale values instead of UTM-scale ones (~0.5 m quantisation at 5M northing → cm precision at scene extents).
- **`renderOrder = -volume`**: largest containing meshes draw first under transparency.
- **`polygonOffset` rank by ascending volume**: smallest (cutting) mesh wins at shared contact surfaces, matching Leapfrog's convention.
- **`floorRenderColor`**: black-coded classes substitute a slight-tinted charcoal at render time. The file's stored RGB stays on `layer._meta.storedColour` for swatches and round-trip exports.

`@gcu/dee` is an optional peer dep — if you only need the parser/writer, you can ignore this entirely.

## Status

v0.1. Validated end-to-end against a real Wolfpass dataset; round-trip tested on synthetic data. Currently supports v1.0 mesh-collection format (`<collectionOfMeshes>` under `<leapfrogObject>`). Block models, point sets, and other Leapfrog object types are out of scope here — they belong in sibling packages.

## License

BSD-3-Clause. The file format is Seequent's; the parser is an original implementation.
