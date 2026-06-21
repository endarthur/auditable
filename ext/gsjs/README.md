# @gcu/gsjs

Modern geostatistics for the browser — the evolving sibling to the **frozen**
[`@gcu/gslib`](../gslib) oracle. Where `gslib` is a faithful Fortran-to-atra
transcription of GSLIB (the numerical reference, never changed except to be
*more* faithful), `gsjs` is where the design evolves: it exposes intermediate
kriging state, runs over arbitrary targets, and (later) GPU-accelerates
realization — all validated bit-for-bit against `gslib`.

The "js" is the **host runtime** (JS-on-browser brokers WebGPU + runtime-compiled
atra/WASM), not a backend lock.

## Status

| piece | state |
|---|---|
| Kriging fork (OK + SK) | ✅ reconstructs `gslib.kt3d` to f64 |
| Realization oracle + predicates (none/topcut/hgr_hard/hgr_soft) | ✅ |
| Targets + categories (grid / mask / points / sub-blocked) | ✅ |
| CPU aggregations (stats / histogram / swath / grade-tonnage) | ✅ |
| Swappable backend seam (`cpuBackend` default) | ✅ |
| **Recipe API** (JSON spec + builder eDSL) | ⏳ next |
| Reactive cell wiring (notebook integration) | ⏳ |
| Neighbourhood module (SPEC-neigh: sectors/per-hole/bench/kd-tree) | ⏳ |
| WebGPU backend (realize + aggregate) | ⏳ last (drop-in, validated vs CPU oracle) |
| LVM (ktype 2) · trend/UK/ED · cokriging | out of v1 |

Design is **CPU-first, GPU-last**: the whole usable v1 runs on proven CPU behind
a backend-agnostic seam; WebGPU is added at the end as pure optimization,
validated against the finished CPU path. (Specs: `spec_inbox/gsjs-SPEC.md` +
`spec_inbox/SPEC-neigh.md`.)

## API

```js
import { kriging, realize, stats, histogram, swath, gradeTonnage } from '@gcu/gsjs';

// 1. Krige → a BlockEstimateTensor (weights + sample indices + variance + status)
const r = kriging({
  data: [[x, y, z, value], ...],
  variogram: { nugget: 0.1, structures: [{ type: 'spherical', contribution: 0.9, range: 30 }] },
  search: { radius: 50, ndmin: 1, ndmax: 8 },
  ktype: 'OK',                 // or 'SK' (+ skmean)
  discretization: { nx: 3, ny: 3, nz: 1 },   // block kriging; omit → point kriging
  // — one target front door: —
  grid: { nx, ny, nz, xmn, ymn, zmn, xsiz, ysiz, zsiz },  // full box (allocation-free)
  // grid + mask: boolean[nxyz] or (ix,iy,iz,x,y,z,idx)=>bool — only active blocks (sparse)
  // points: [[x,y,z], ...] | [[x,y,z,dx,dy,dz], ...] (per-point dims, auto-categorized)
  //         | points:[[x,y,z],...] + dimCategories:[[dx,dy,dz],...] + cats:[...]
  distances: true,             // capture per-sample distance (needed by HGR realization)
});

// 2. Realize → per-target estimates. Cheap; re-run on cap/HGR slider changes
//    WITHOUT re-kriging (the transform is linear in z).
const est = realize(r, r.values, { transform: 'topcut', params: { cap: 35 } });

// 3. Aggregate (all mask by status; only STATUS.OK contributes)
const s  = stats(est, r.status);
const h  = histogram(est, r.status, { min: 0, max: 10, nbins: 50 });
const sw = swath(est, r.status, r.geom, { axis: 'x' });   // r.geom = {grid} | {coords}
const gt = gradeTonnage(est, r.status, { cutoffs: [0.5, 1, 2], blockTonnage: 1 });
```

**BlockEstimateTensor** (`r`): `indices` `weights` `n_actual` `kv` `status`
(`distances?`) padded to `K = ndmax`, plus `sk_mean`, `values` (super-block
reordered — `indices` reference these), `coords` / `gridIndex` / `geom`,
`n_targets` (`= n_blocks`), `n_categories`. Status enum: `OK / INSUFFICIENT_DATA
/ SINGULAR_SYSTEM / NOT_ATTEMPTED` — never a value sentinel.

**Categories** are the block-dimension primitive: shared = 1, sub-blocked = K,
unique-per-block = N. The expensive block-variance `cbb` is memoized once per
category, so cost scales with the number of *distinct* geometries.

**Backend seam** (`getBackend`/`setBackend`): `cpuBackend` is the default and the
oracle a future WebGPU/atra backend validates against, per kernel.

## Build & test

```
node ext/gsjs/build.js        # co-compiles gslib.atra (frozen) + gsjs.atra → index.js
node --test test/gsjs.test.mjs
```

`gsjs` owns its build (reads `gslib.atra` only as a static-link dependency — the
fork reuses gslib's kernels in gsjs's own wasm; `ext/gslib` is never edited). TODO:
wire `build.js` into `gcu-make`.

## Resume pointer

Next: the **recipe API** — `recipe()` / `variogram()` / `ok()` / `sk()` / `hgr()`
builders producing a JSON-serializable spec (`toJSON`/`fromJSON`), with
construction-time validation, on top of the target-based `kriging()`. Shape is
specced in `spec_inbox/gsjs-SPEC.md` §"Recipe API". Then reactive cell wiring;
then M3 (neighbourhood). State tracked in the `project_gsjs_started` memory.
