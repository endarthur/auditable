# @gcu/omf1 — Open Mining Format v1 reader/writer

Read and write `.omf` v1 files in the browser and Node. **Zero dependencies,
single file, isomorphic** (`CompressionStream` is a global in Node 18+ and
browsers, and `"deflate"` is zlib/RFC-1950 — matching Python `zlib`).

OMF v1 (`OMF-v0.9.0`) is the version with real-world adoption — Leapfrog, Surpac,
Micromine, Deswik, and Vulcan all ship it. (v2 exists only as a Rust beta with no
shipping consumers; it's a different wire format — see `@gcu/omf2`.)

## API

```js
import { readOMF, openOMF, writeOMF, blockModelGrid, blockModelCentroids } from '@gcu/omf1';

// Eager — load everything (small/medium files).
const project = await readOMF(fileOrArrayBufferOrUint8Array);
const bm = project.elements.find((e) => e.type === 'VolumeElement');
const au = bm.data.find((d) => d.name === 'au').array;     // Float64Array
const [nu, nv, nw] = blockModelGrid(bm.geometry);
const centroids = blockModelCentroids(bm.geometry);        // N×3 Float64Array

// Lazy — header + index only; fetch arrays on demand (big block models).
const reader = await openOMF(file);
const stub = reader.project.elements[0].geometry.vertices;  // { __arrayRef, start, length, dtype }
const verts = await reader.loadArray(stub);
reader.close();

// Write.
const bytes = await writeOMF(project);   // Uint8Array, ready for download/storage
```

**Object model** (the `type` field names the class): `Project` → `elements[]` of
`PointSetElement` / `LineSetElement` / `SurfaceElement` / `VolumeElement`, each with
a `geometry` and `data[]` (`ScalarData`, `MappedData`, `Vector3Data`, …). Numeric
arrays come back as `Float64Array` (`<f8`); integer/index arrays as `BigInt64Array`
(`<i8`, per the format — downcast to `Int32Array` yourself if you know they fit).

## Status & verification

- **Round-trip + structural tested** (`test/omf1.test.mjs`): write → read →
  deep-equal across volume/pointset/surface geometries, scalar + mapped data,
  int64 index arrays, the lazy reader, header/uuid, and the block-model helpers.
- **Real-file cross-validation is the open follow-up** (spec §9.3). The library is
  built to `omf-v1-js-spec.md`; reading an actual Leapfrog/Vulcan/Python-`omf`
  export is the true test. A real `.omf` could surface wire details to reconcile
  (e.g. the exact class-key — we read `__class__`/`type` and write `__class__` —
  or header-UUID byte order; the project is located by class, so that doesn't gate
  reading). **Drop a real `.omf` in and we validate + reconcile.**

## Not covered

OMF v2 (ZIP+Parquet — `@gcu/omf2`), sub-blocked models (v2-only), CRS transforms,
deep index validation (we check magic/version/dtype, not e.g. triangle bounds).

## Canonical source

Spec: `spec_inbox/geology/omf-v1-js-spec.md`. Part of the geoscience/tabular
workbench — wires into `@gcu/flowsheet` as a `load.omf` node (OMF volume →
gridded table, surface → mesh, pointset → scattered table) and feeds the
Data Workbench surface.
