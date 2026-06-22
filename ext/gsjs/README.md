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
| Recipe API (JSON spec + builder eDSL, `run`/`estimate`/`evaluate`) | ✅ |
| Browser-loadable bundle (`@gcu/build` + gcu-make, sift inlined) | ✅ |
| Notebook examples (live top-cut · domains · artifact + swath/GT) | ✅ |
| Reactive cell wiring (estimate once → slider `onInput` re-realizes) | ✅ |
| Neighbourhood M3a — moving ellipsoid, kd-tree, deterministic tie-break | ✅ |
| Neighbourhood M3b — sector search (nsect / maxPer / minPer / minFilled) | ✅ |
| Orientation conventions (`orient.js`: gslib + leapfrog, matrix-canonical) | ✅ |
| Neighbourhood M3b — per-hole cap · min-distance thinning | ✅ |
| Neighbourhood M3b — bench (2.5D: vertical band + 2D ellipse) | ✅ |
| **M3c — pure-JS kriging driver, neighbourhood-fed (`krige()`)** | ✅ (== kt3d to f64) |
| M3c — block kriging (discretized RHS + cbb) | ✅ (== kt3d est+var to f64) |
| M3c follow-ups — categories · recipe wiring · perf wave | ⏳ |
| Distance-restricted capping · unique neighbourhood (deferred) | ⏳ |
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

## Recipe API

A recipe is a **JSON-serializable estimation spec** — the shippable, diffable,
language-independent artifact (a regulator diffs two versions; a non-JS consumer
reads it). A composable JS eDSL builds it; `toJSON()`/`fromJSON()` round-trip.

```js
import { recipe, variogram, search, ok, sk, topcut, hgr, none,
         run, estimate, evaluate, fromJSON } from '@gcu/gsjs';

const r = recipe({
  data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU', domain: 'DOMAIN' }, source: 'dh.csv' },
  block_grid: { nx: 200, ny: 200, nz: 50, xmn: 5, ymn: 5, zmn: 50,
                xsiz: 10, ysiz: 10, zsiz: 10, discretization: [3, 3, 1] },
  domains: [
    { id: 'HG', where: "DOMAIN == 'HG'",          // sift predicate — serializable
      model: ok({
        variogram: variogram([{ type: 'spherical', cc: 0.7, aa: 80,
                                anis: [0.5, 0.3], ang: [45, 0, 0] }], { c0: 0.1 }),
        search:    search({ radius: 100, anis: [0.5, 0.3], ang: [45, 0, 0], ndmin: 4, ndmax: 20 }),
        realization: hgr({ cap: 35, d_thresh: 60, grade_thresh: 12 }),
      }) },
    { id: 'LG', where: "DOMAIN == 'LG'", model: ok({ /* … */ }) },
  ],
  output: { distances: true, aggregations: [
    { kind: 'stats' }, { kind: 'gradeTonnage', cutoffs: [0.5, 1, 2] }, { kind: 'swath', axis: 'x' },
  ] },
});

r.toJSON();                          // the canonical artifact (ship/review/diff)
const r2 = fromJSON(r.toJSON());     // rebuild executable recipe (idempotent)

// staged: estimate() is expensive (search + solve, per domain); evaluate() is
// the cheap tail (realize + aggregate) a live cap/HGR slider re-runs alone.
const kr  = estimate(r, { rows, blockDomains });           // rows = host data; blockDomains = per-block id
const res = evaluate(kr, { HG: { transform_params: { cap: 28 } } });  // slider → re-realize, NO re-krige
// or all at once:
const full = run(r, { rows, blockDomains });
// res.estimates (Float64Array[nxyz]) · res.status · res.aggregations.{stats,gradeTonnage,swath_x} · res.domains[]
```

**Canonical JSON** uses the compact GSLIB vocab (`{c0, structures:[{type, cc, aa,
anis:[ay/ax,az/ax], ang:[strike,dip,plunge]}]}`); the executor translates it to
`kriging()`'s verbose form. `where` is a **@gcu/sift** predicate (typed string →
JSON spec) so the artifact stays self-contained — a raw JS-function `where` runs
in memory but `toJSON()` refuses it. Domains assign **samples** via `where` (over
data rows) and **blocks** via host-supplied `ctx.blockDomains` (per-block id);
unmatched blocks fall to `default_model` or stay `NOT_ATTEMPTED`. `run()` adds no
numerical drift — it equals a hand-driven `kriging()`+`realize()` to f64.
Construction-time validation throws on bad models (range > 0, ndmax ≥ ndmin, …).
SK_LVM builds (artifact-complete) but `run()` rejects it until kriging() gains
ktype 2.

## Build & test

```
node ext/gsjs/build.js        # co-compiles gslib.atra (frozen) + gsjs.atra → index.js
node --test test/gsjs.test.mjs
```

`gsjs` owns its build (reads `gslib.atra` only as a static-link dependency — the
fork reuses gslib's kernels in gsjs's own wasm; `ext/gslib` is never edited). TODO:
wire `build.js` into `gcu-make`.

## Resume pointer

Recipe API + browser-loadable bundle + three notebook examples shipped (live
top-cut, domains, artifact+swath/GT — all browser-verified; the reactive split
proven: estimate once, slider `onInput` re-realizes in ~0.5 ms vs ~35 ms krige).
The build is on `@gcu/build` + gcu-make (sift + scitra's KDTree inlined; atra→wasm
via atrac's `bundleRecipe`). **M3a shipped** — the search neighbourhood foundation
(`neigh.js`: `createNeighborhood`/`indexSamples`/`select` for the moving ellipsoid,
scitra kd-tree built in `setrot`-transformed coords so the ellipsoid is a sphere
query, deterministic tie-break; bit-identical to a brute-force scan, ported
setrot/sqdist faithful vs gslib wasm). Next: **M3b** — the selection-policy passes
(nsect sectors, per-hole cap, min-distance, distance-restricted capping) + unique +
bench; then **M3c** — feed `select()` into the kriging fork (the kt3d decoupling →
octant/sector kriging, `ext/gslib` untouched). **π is a flag** (`createNeighborhood`
`{ faithful }`): the default uses accurate `Math.PI` (gsjs is the modern library);
`faithful: true` uses gslib's truncated-π literal `3.141592654`, making `setrot`/
`sqdist` **bit-identical to gslib's wasm at f64 ULP** — for oracle-parity validation
and for feeding gsjs's gslib-wasm kriging fork so selection stays bit-identical
(atra's sin/cos are JS `Math` imports, so π is the only divergence — not trig). Then
M-last WebGPU backend. State tracked in the `project_gsjs_started` memory.
