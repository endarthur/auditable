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

## Status

v0.1. Validated end-to-end against a real Wolfpass dataset; round-trip tested on synthetic data. Currently supports v1.0 mesh-collection format (`<collectionOfMeshes>` under `<leapfrogObject>`). Block models, point sets, and other Leapfrog object types are out of scope here — they belong in sibling packages.

## License

BSD-3-Clause. The file format is Seequent's; the parser is an original implementation.
