# gslib.atra

Faithful transcription of Stanford's [GSLIB](http://www.gslib.com/) (Deutsch & Journel, 1998) to [atra](../atra/)/Wasm. Same algorithms, same variable names, same accumulation order. The Fortran is the spec.

## Design principles

- **Mirror Fortran**: variable names, loop structure, and accumulation order match the original. Deviations are documented with comments.
- **Self-contained**: no dependency on alpack or other atra libraries.
- **All f64**: the original Fortran has mixed precision (gcum is `real`, gauinv truncates to `real`). We use f64 throughout. Fortran f32 truncation points are noted with `! NOTE: Fortran uses f32 here` for future bit-identity work.
- **0-indexed**: Fortran 1-indexed arrays and grid indices are adapted to 0-indexed. The `locate` subroutine preserves Fortran's 1-indexed `is`/`ie` convention in its interface for compatibility.
- **Explicit state**: Fortran `common` blocks become array parameters (e.g., acorni's `ixv` state vector).

## Implemented routines

| Routine | Type | Description | Fortran ref |
|---------|------|-------------|-------------|
| `gslib.acorni` | function | ACORN RNG (order 12, modulus 2^30) | acorni.for |
| `gslib.gauinv` | subroutine | Inverse standard normal CDF (Kennedy & Gentle) | gauinv.for |
| `gslib.gcum` | function | Standard normal CDF (Abramowitz & Stegun) | gcum.for |
| `gslib.powint` | function | Power interpolation between two points | powint.for |
| `gslib.locate` | subroutine | Bisection search in sorted array | locate.for |
| `gslib.getindx` | subroutine | Grid cell index from coordinate | getindx.for |
| `gslib.setrot` | subroutine | Anisotropic rotation matrix setup | setrot.for |
| `gslib.sqdist` | function | Squared anisotropic distance | sqdist.for |
| `gslib.cova3` | subroutine | Nested covariance model evaluation (5 types) | cova3.for |
| `gslib.sortem` | subroutine | Quickersort with up to 2 companion arrays | sortem.for |
| `gslib.nscore` | subroutine | Normal score transform | nscore.for |
| `gslib.backtr` | function | Back-transform from normal scores | backtr.for |
| `gslib.setsupr` | subroutine | Build super block network and sort data | setsupr.for |
| `gslib.picksup` | subroutine | Determine which super blocks to search | picksupr.for |
| `gslib.srchsupr` | subroutine | Search within super blocks for nearby data | srchsupr.for |
| `gslib.ksol` | subroutine | Kriging system solver (upper triangular, no pivoting) | ksol.for |
| `gslib.kb2d` | subroutine | 2D ordinary/simple kriging | kb2d.for |
| `gslib.ktsol` | subroutine | Kriging system solver (full matrix, partial pivoting) | ktsol.for |
| `gslib.kt3d` | subroutine | 3D kriging (SK/OK/KT/UK, super block search) | kt3d.for |
| `gslib.ctable` | subroutine | Covariance lookup table and spiral search order | sgsim.for |
| `gslib.srchnd` | subroutine | Search previously simulated grid nodes | sgsim.for |
| `gslib.krige` | subroutine | Kriging system for simulation (SK/OK/LVM/ED/CoK) | sgsim.for |
| `gslib.sgsim` | subroutine | Sequential Gaussian simulation (one realization) | sgsim.for |
| `gslib.ordrel` | subroutine | Order relation correction for indicator CDFs | ordrel.for |
| `gslib.beyond` | subroutine | CDF interpolation and tail extrapolation | beyond.for |
| `gslib.gamv` | subroutine | Experimental variogram computation (all-pairs) | gamv.for |
| `gslib.declus` | subroutine | Cell declustering for sampling bias correction | declus.for |
| `gslib.ik3d` | subroutine | 3D indicator kriging at multiple thresholds | ik3d.for |
| `gslib.ctable_i` | subroutine | Per-cutoff covariance lookup table | sisim.for |
| `gslib.krige_i` | subroutine | Per-cutoff indicator kriging for simulation | sisim.for |
| `gslib.sisim` | subroutine | Sequential indicator simulation (one realization) | sisim.for |
| `gslib.cokb3d` | subroutine | 3D collocated cokriging (primary + secondary) | cokb3d.for |

## Implementation order

Following the dependency chain from primitives to programs:

1. **RNG** — acorni
2. **Probability** — gauinv, gcum
3. **Geometry** — powint, locate, getindx, setrot, sqdist
4. **Covariance** — cova3
5. **Sorting** — sortem
6. **Data transform** — nscore, backtr
7. **Search** — setsupr, picksup, srchsupr
8. **Kriging** — ksol, ktsol, kb2d, kt3d
9. **Simulation** — ctable, srchnd, krige, sgsim
10. **Indicator utilities** — ordrel, beyond
11. **Variography** — gamv
12. **Declustering** — declus
13. **Indicator kriging** — ik3d
14. **Indicator simulation** — ctable_i, krige_i, sisim
15. **Cokriging** — cokb3d

## Rotation matrix storage

Fortran stores `rotmat(MAXROT, 3, 3)` with `rotmat(ind, i, j)`.

Atra uses a flat f64 array: matrix `ind` occupies `rotmat[ind*9 .. ind*9+8]`, with element `(i, j)` at `rotmat[ind*9 + i*3 + j]` (0-indexed, row-major per block).

`setrot` and `sqdist` both take `rotmat: array f64; ind: i32`. `cova3` takes base `irot` and computes `irot + is` for each nested structure.

## Sorting

Fortran's `sortem`/`dsortem` accept up to 7 companion arrays via an `iperm` parameter and use computed GOTOs for dispatch. Atra's `gslib.sortem` simplifies to 2 companion arrays (`b`, `c`) with `nperm` (0, 1, or 2). This covers the common cases (nscore uses nperm=2). For more companions, sort an index array and permute manually.

The sort requires two scratch i32 arrays (`lt`, `ut`) of at least 64 elements each (stack depth for quicksort partitioning). Callers provide these explicitly — atra has no local arrays (all memory is linear/heap).

## Super block search

Fortran's `setsupr` sorts data into super blocks using `sortem` with 4+ companion arrays. Since atra's `sortem` supports only 2 companions (Wasm has no variadic functions), `gslib.setsupr` uses a counting-sort approach instead: compute a source permutation via exclusive prefix sum, then apply it in-place via cycle-following. This avoids sortem entirely, runs in O(n), and is stable (preserves original data order within the same super block).

Output grid parameters are returned via `out[0..8]` (nxsup, nysup, nzsup, xmnsup, ymnsup, zmnsup, xsizsup, ysizsup, zsizsup). Callers pass these to `picksup` and `srchsupr`.

`srchsupr` supports optional octant search (noct > 0) which limits the number of samples per spatial octant. The octant counts are stored in a caller-provided `inoct` i32[8] array (atra has no local arrays).

## Kriging

`ksol` is the kriging system solver — upper triangular Gauss elimination without pivoting, for OK/SK systems. Uses packed columnwise storage where element (i,j) with j>=i is at position `i + j*(j-1)/2` (1-indexed). Returns 0 on success, k>0 if pivot k is near-zero, -1 if neq<=1.

`ktsol` is the full-matrix kriging system solver — Gaussian elimination with partial pivoting. Column-major n x n matrix, single RHS. Handles ill-conditioned systems that arise with drift terms (KT/UK). Interface: `ktsol(n, a, b, s, result)` where `a[n*n]` is the LHS (modified in place), `b[n]` the RHS (modified), `s[n]` the solution, and `result[0]` returns 0 on success, -1 if n<=1, or k if pivot k is near-zero.

`kb2d` is the full 2D ordinary/simple kriging program. Brute-force neighbor search with insertion sort by distance (no super block search — matching Fortran kb2d). Uses `cova3` + `setrot` for covariance evaluation instead of Fortran's inline `cova2`. Block discretization via nxdis x nydis internal points. ktype=0 for simple kriging, ktype=1 for ordinary kriging. Output: `est[nx*ny]` estimates, `estv[nx*ny]` variances, sentinel -999.0 for unestimated nodes.

`kt3d` is the full 3D kriging program. Super block search (setsupr/picksup/srchsupr), block discretization (nxdis x nydis x nzdis), and multiple kriging types: ktype=0 (SK), ktype=1 (OK), ktype=2 (SK with locally varying mean from external variable), ktype=3 (KT/UK with up to 9 polynomial drift terms + optional external drift). Uses `ktsol` for the kriging system. Single-sample case handled separately. Data coordinates shifted relative to block corner for drift term computation. Drift function means (bv) precomputed and stored in `supout[9..17]`. Rescaling factor `resc = 1/(4*radsqd/covmax)` for numerical stability with drift. Skipped from the Fortran program: koption (jackknife cross-validation, always 0), iktype (indicator kriging distribution, always 0), itrend (estimate trend itself, always 0).

All scratch arrays are caller-provided — atra has no local arrays.

## Simulation

`sgsim` implements Sequential Gaussian Simulation — one realization per call. The caller handles normal score transform (`nscore`) and back-transform (`backtr`) externally. All data must be in normal score space.

**Setup chain** (caller must run before sgsim):
1. `setrot` — rotation matrices for variogram structures + search ellipse
2. `setsupr` + `picksup` — super block search network
3. `ctable` — covariance lookup table and spiral search order

**Internal subroutines** (called by sgsim):
- `ctable` — precomputes covariance at all grid-node offsets within the search radius. Builds a spiral search order sorted by variogram distance (closest first). Uses `cova3` for covariance, `sqdist` for anisotropic distance, `sortem` for ordering.
- `srchnd` — spirals out from the current node using ctable's lookup order, collecting previously simulated nodes. Supports octant search (noct > 0). `ixnode`/`iynode`/`iznode` are 1-indexed table positions (matching Fortran).
- `krige` — builds kriging matrix from original data + simulated nodes, solves via `ksol` (packed upper triangular). Data-data and data-simnode covariance via `cova3`; simnode-simnode via covtab lookup when indices are in range. Supports 5 kriging types: 0=SK, 1=OK, 2=LVM, 3=external drift, 4=collocated cosimulation. Singular system fallback: cmean=gmean, cstdev=1.

**sgsim algorithm:**
1. Random path: fill sim with acorni random values, sort to get random visit order
2. Initialize grid to UNEST (-99)
3. Assign conditioning data to nearest grid nodes (flag with 10*UNEST if exact match)
4. Replace flags with actual data values
5. Main loop: for each unvisited node, search for nearby data (srchsupr) and simulated nodes (srchnd), krige conditional mean/stdev, draw random Gaussian value
6. Reassign data to grid nodes (ensure conditioning is honored)

**Skipped features** (vs. Fortran): multiple grid search (`mults`), internal normal score transform (`itrans`), variance reduction (`varred`), octant-only search without super blocks (`sstrat=1`).

**UNEST sentinel:** -99.0 (not -999.0 as in kt3d). Data flags use 10*UNEST = -990.0. A node is unsimulated if `sim[ind] <= UNEST + eps` and `sim[ind] >= 2*UNEST`.

## Indicator utilities

`ordrel` corrects order relation violations in indicator kriging CDFs. For continuous variables (ivtype=1): forward and backward monotonicity passes, averaged. For categorical (ivtype=0): normalize probabilities to sum to 1. All values clamped to [0, 1].

`beyond` interpolates/extrapolates a value from a kriged indicator CDF. Given cutoffs, CDF values, and a target probability (cdfval), returns the corresponding z-value. Middle interpolation is linear between cutoff bounds. Tail options: 1=linear, 2=power, 4=hyperbolic (upper only).

## Variography

`gamv` computes experimental variograms via O(n^2) all-pairs loop with directional/lag filtering. Supports multiple directions and variogram types: 1=semivariogram, 2=cross-semivariogram, 3=covariance, 4=correlogram, 5=general relative, 6=pairwise relative, 7=log semivariogram, 8=madogram. Output arrays indexed as `(id * nvarg + iv) * (nlag + 2) + il`.

## Declustering

`declus` implements cell declustering for correcting sampling bias. Sweeps cell sizes from cmin to cmax, computes inverse-density weights at multiple origin offsets per cell size, and selects the optimal cell size by min or max weighted mean. Final weights are normalized so their average equals 1.

## Indicator kriging

`ik3d` performs 3D indicator kriging with super block search. For each grid node, kriging is performed independently at each cutoff using that cutoff's variogram model. Per-cutoff variogram arrays are indexed `[icut * MAXNST + is]`. Order relations are corrected via `ordrel`. Output: nxyz * ncut CDF values.

## Indicator simulation

`sisim` implements Sequential Indicator Simulation — one realization per call. Same random-path structure as sgsim, but at each node: search nearby data (`srchsupr`) and simulated nodes (`srchnd`), krige indicator at each cutoff via `krige_i`, correct order relations via `ordrel`, draw from CDF via `beyond`.

**Internal subroutines:**
- `ctable_i` — builds spiral search order from first cutoff's variogram, fills covtab for all cutoffs. Returns nlooku and cbb per cutoff.
- `krige_i` — per-cutoff indicator kriging mixing original data + simulated nodes. Uses packed upper-triangular matrix solved via `ksol`.

## Cokriging

`cokb3d` performs 3D collocated cokriging with primary + one secondary variable. Three variogram models: primary-primary (auto), secondary-secondary (auto), primary-secondary (cross). Each can have independent nested structures. The full cokriging matrix is `(na+k) x (na+k)` where na = primary + secondary neighbors and k = Lagrange multipliers. Solved via `ktsol` (partial pivoting).

## RNG

`acorni` implements the ACORN generator (Wikramaratna, 1990) of order 12 with modulus 2^30. State is a 13-element i32 array: `ixv[0]` = seed, `ixv[1..12]` = 0 initially. Each call advances the state and returns a uniform value in [0, 1). The caller owns the state array, enabling multiple independent streams.

## High-level API

The binary distribution (`ext/atra/lib/gslib.js`) includes a high-level wrapper that hides all Wasm memory management. Import via `load("@atra/gslib")`.

### kb2d

2D ordinary/simple kriging. Brute-force neighbor search — good for small grids or when all data are relevant.

```js
const { kb2d } = await load("@atra/gslib");
const result = kb2d({
  data: [[x, y, v], ...],
  grid: { nx: 50, ny: 50, xsiz: 1, ysiz: 1 },
  variogram: {
    nugget: 0.1,
    structures: [{ type: "spherical", contribution: 0.9, range: 10 }],
  },
  search: { radius: 20, ndmax: 16 },
});
// result.est — Float64Array[nx*ny], kriging estimates (-999 = unestimated)
// result.var — Float64Array[nx*ny], kriging variances
```

Options: `grid.xmn`/`ymn` (cell-center origin, default `xsiz/2`), `discretization: { nx, ny }` (block kriging points, default 1x1 = point), `ktype: "OK"|"SK"` (default "OK"), `skmean` (SK global mean, default 0).

Variogram structure types: `spherical`, `exponential`, `gaussian`, `power`, `hole`. Each structure takes `contribution`, `range`, and optionally `angle` (rotation), `rangeMinor` (anisotropy ratio, default = range).

### kt3d

3D kriging with super block search. Handles large datasets efficiently.

```js
const { kt3d } = await load("@atra/gslib");
const result = kt3d({
  data: [[x, y, z, v], ...],
  grid: { nx: 20, ny: 20, nz: 5, xsiz: 1, ysiz: 1, zsiz: 1 },
  variogram: {
    nugget: 0.1,
    structures: [{ type: "spherical", contribution: 0.9, range: 15 }],
  },
  search: { radius: 20, ndmax: 32 },
});
```

Additional search options: `ndmin` (minimum neighbors, default 1), `angle`/`angle2`/`angle3` (search ellipse rotation), `radiusMinor`/`radiusVert` (anisotropic search, default = radius). Variogram structures also accept `angle2`, `angle3`, `rangeVert`.

Supports `ktype: "OK"|"SK"` (default "OK"). KT/UK drift terms are not exposed — use the low-level `instantiate()` interface for those.

### sgsim

Sequential Gaussian simulation. Two-phase: setup allocates all buffers once, `run(seed)` generates realizations. Data must already be in normal score space.

```js
const { sgsim } = await load("@atra/gslib");
const engine = sgsim({
  grid: { nx: 50, ny: 50 },
  variogram: {
    structures: [{ type: "spherical", contribution: 1.0, range: 10 }],
  },
  search: { radius: 20, ndmax: 12, nodmax: 12 },
});

const sim1 = engine.run(69069);   // Float64Array[nx*ny*nz]
const sim2 = engine.run(12345);   // different seed, different realization
engine.dispose();                 // release memory
```

Search options: `nodmax` (max previously simulated nodes, default 12), `noct` (octant search limit, 0 = disabled). Conditioning data: `data: [[x, y, z, v], ...]` (normal scores). Grid defaults: `nz: 1`, `xsiz/ysiz/zsiz: 1`, origins at `siz/2`.

### gamv

Experimental variogram computation. All-pairs O(n^2) with directional/lag filtering.

```js
const { gamv } = await load("@atra/gslib");
const result = gamv({
  data: [[x, y, v], ...],           // or [[x, y, z, v], ...]
  lags: { n: 10, size: 1.0, tolerance: 0.5 },
  directions: [
    { azimuth: 0, tolerance: 90, bandwidthH: Infinity },
  ],
  trim: { min: -1e21, max: 1e21 },
});
// result.distance — Float64Array[ndir * (nlag+2)]
// result.value    — Float64Array[ndir * (nlag+2)], semivariogram values
// result.npairs   — Float64Array[ndir * (nlag+2)]
// result.hm, result.tm — head/tail mean arrays
```

Default: omni-directional (azimuth=0, tolerance=90). For 3D data, directions also accept `dip`, `dipTolerance`, `bandwidthV`.

### declus

Cell declustering for sampling bias correction.

```js
const { declus } = await load("@atra/gslib");
const result = declus({
  data: [[x, y, v], ...],           // or [[x, y, z, v], ...]
  cellRange: [1, 20],               // min/max cell size to sweep
  ncell: 25,                        // number of cell sizes to test
  noff: 8,                          // origin offsets per cell size
  anisotropy: { y: 1, z: 1 },      // cell shape ratios
  criterion: "min",                 // optimize weighted mean: "min" or "max"
});
// result.weights      — Float64Array[nd], average = 1
// result.cellSize     — optimal cell size
// result.weightedMean — weighted mean at optimum
```

### ik3d

3D indicator kriging at multiple thresholds. The wrapper handles indicator transform internally.

```js
const { ik3d } = await load("@atra/gslib");
const result = ik3d({
  data: [[x, y, z, v], ...],
  grid: { nx: 20, ny: 20, nz: 1 },
  cutoffs: [0.5, 1.0, 1.5],
  variograms: [                      // one per cutoff
    { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 10 }] },
    { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 12 }] },
    { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 14 }] },
  ],
  search: { radius: 20, ndmax: 16 },
  ktype: "OK",                       // "OK" or "SK"
  categorical: false,
});
// result.ccdf — Float64Array[nxyz * ncut], CDF values at each cutoff per node
```

### sisim

Sequential Indicator Simulation. Two-phase like sgsim: setup allocates buffers, `run(seed)` generates realizations.

```js
const { sisim } = await load("@atra/gslib");
const engine = sisim({
  grid: { nx: 50, ny: 50 },
  cutoffs: [0.5, 1.0, 1.5],
  variograms: [                      // one per cutoff
    { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 8 }] },
    { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 10 }] },
    { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 12 }] },
  ],
  search: { radius: 20, ndmax: 12, nodmax: 12 },
  data: [[x, y, z, v], ...],        // conditioning data (original scale)
  globalCdf: [0.25, 0.50, 0.75],    // marginal CDF at cutoffs (for SK)
  tails: { lower: { type: 1, param: 0 }, upper: { type: 1, param: 5 } },
  categorical: false,
});
const sim = engine.run(69069);       // Float64Array[nxyz], original scale
engine.dispose();
```

### cokb3d

3D collocated cokriging with primary + secondary variable.

```js
const { cokb3d } = await load("@atra/gslib");
const result = cokb3d({
  data: {
    primary: [[x, y, z, v], ...],
    secondary: [[x, y, z, v], ...],
  },
  grid: { nx: 20, ny: 20, nz: 5 },
  variograms: {
    primary: { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 10 }] },
    secondary: { nugget: 0, structures: [{ type: "spherical", contribution: 1, range: 15 }] },
    cross: { nugget: 0, structures: [{ type: "spherical", contribution: 0.8, range: 12 }] },
  },
  search: { radius: 20, ndmaxPrimary: 16, ndmaxSecondary: 16 },
  ktype: "OK",
  skmean: { primary: 0, secondary: 0 },
});
// result.est — Float64Array[nxyz], cokriging estimates
// result.var — Float64Array[nxyz], cokriging variances
```

### nscore

Normal score transform. Maps any continuous distribution to standard normal.

```js
const { nscore } = await load("@atra/gslib");
const result = nscore({
  data: [3.2, 1.1, 5.7, 2.4, ...],
  weights: [1, 1, 2, 1, ...],        // optional, equal weights if omitted
  trim: { min: 0, max: 100 },        // optional
});
// result.scores — Float64Array[nd], normal scores in original data order
// result.table  — { values, scores }, sorted transform table for backtr
```

The returned `table` contains the data values and their normal scores sorted in ascending order by value. Pass this directly to `backtr()` for back-transformation.

### backtr

Back-transform from normal scores to original data scale. Typically used after simulation in normal score space (sgsim).

```js
const { nscore, backtr, sgsim } = await load("@atra/gslib");

// 1. Transform data to normal scores
const ns = nscore({ data: rawValues });

// 2. Simulate in normal score space
const engine = sgsim({ grid, variogram, search, data: conditioningData });
const simScores = engine.run(69069);

// 3. Back-transform to original scale
const simValues = backtr({
  scores: simScores,
  table: ns.table,
  tails: {
    lower: { type: 1, param: 0, min: 0 },
    upper: { type: 1, param: 5, max: 100 },
  },
});
```

Tail options: `type` 1 = linear interpolation, 2 = power model (param = power), 4 = hyperbolic (upper tail only, param = omega exponent). `min`/`max` set extrapolation limits (default: table extremes).

### vmodel

Theoretical variogram model evaluation at regular lag distances. Useful for plotting model curves against experimental variograms from `gamv`.

```js
const { vmodel } = await load("@atra/gslib");
const result = vmodel({
  variogram: {
    nugget: 0.1,
    structures: [{ type: "spherical", contribution: 0.9, range: 10 }],
  },
  lags: { n: 20, size: 1.0 },
  directions: [
    { azimuth: 0, dip: 0 },
    { azimuth: 90, dip: 0 },
  ],
});
// result.distance    — Float64Array[ndir * nlag], lag distances
// result.value       — Float64Array[ndir * nlag], gamma(h) values
// result.correlation — Float64Array[ndir * nlag], rho(h) = C(h)/C(0)
```

Directions specify the orientation along which to evaluate the model. For isotropic variograms, a single direction suffices. For anisotropic models (structures with `rangeMinor` or `rangeVert`), multiple directions reveal the anisotropy.

## Configuration reference

Full specification of all config objects accepted by the high-level API. Extracted from `api.js`.

### Shared types

#### grid

Regular grid definition. 2D functions (kb2d) ignore z-axis fields.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nx` | number | yes | — | Number of cells in X |
| `ny` | number | yes | — | Number of cells in Y |
| `nz` | number | 3D only | 1 | Number of cells in Z |
| `xsiz` | number | no | 1 | Cell size in X |
| `ysiz` | number | no | 1 | Cell size in Y |
| `zsiz` | number | 3D only | 1 | Cell size in Z |
| `xmn` | number | no | xsiz/2 | X origin (cell center) |
| `ymn` | number | no | ysiz/2 | Y origin (cell center) |
| `zmn` | number | 3D only | zsiz/2 | Z origin (cell center) |

GSLIB convention: origins are cell-centered, so `xmn = xsiz/2` places the first cell at `[0, xsiz]`.

#### variogram

Nested variogram model with nugget effect.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nugget` | number | no | 0 | Nugget effect (C0) |
| `structures` | array | yes | — | Array of nested structures |

Each **structure** object:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string\|number | yes | — | Model type (see below) |
| `contribution` | number | yes | — | Sill contribution (CC) |
| `range` | number | yes | — | Major axis range (AA) |
| `angle` | number | no | 0 | Primary rotation angle (degrees) |
| `angle2` | number | no | 0 | Secondary rotation angle |
| `angle3` | number | no | 0 | Tertiary rotation angle |
| `rangeMinor` | number | no | range | Minor axis range |
| `rangeVert` | number | no | range | Vertical axis range |

Variogram type names: `spherical` (or `sph`, `1`), `exponential` (`exp`, `2`), `gaussian` (`gau`, `3`), `power` (`pow`, `4`), `hole` (`5`).

#### search (common fields)

Fields shared by most search objects. Function-specific fields documented per function.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `radius` | number | yes | — | Search radius (major axis) |
| `ndmax` | number | no | varies | Max data neighbors |
| `ndmin` | number | no | varies | Min data neighbors |
| `angle` | number | no | 0 | Search ellipse rotation (3D functions) |
| `angle2` | number | no | 0 | Secondary rotation |
| `angle3` | number | no | 0 | Tertiary rotation |
| `radiusMinor` | number | no | radius | Minor axis search radius |
| `radiusVert` | number | no | radius | Vertical search radius |

---

### kb2d(opts)

2D ordinary/simple kriging. Returns `{ est, var }` as Float64Array[nx*ny].

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | array | yes | — | `[[x, y, v], ...]` |
| `grid` | object | yes | — | 2D grid (nx, ny) |
| `variogram` | object | yes | — | Variogram model |
| `search` | object | yes | — | See below |
| `discretization` | object | no | `{}` | Block kriging discretization |
| `ktype` | string | no | "OK" | "OK" or "SK" |
| `skmean` | number | no | 0 | Simple kriging mean |

**search:**

| Field | Type | Default |
|-------|------|---------|
| `radius` | number | required |
| `ndmax` | number | min(nd, 20) |
| `ndmin` | number | 1 |

**discretization:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `nx` | number | 1 | Points in X (1 = point kriging) |
| `ny` | number | 1 | Points in Y |

---

### kt3d(opts)

3D kriging with super block search. Returns `{ est, var }` as Float64Array[nx*ny*nz].

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | array | yes | — | `[[x, y, z, v], ...]` |
| `grid` | object | yes | — | 3D grid |
| `variogram` | object | yes | — | Variogram model |
| `search` | object | yes | — | See below |
| `discretization` | object | no | `{}` | Block kriging discretization |
| `ktype` | string | no | "OK" | "OK" or "SK" |
| `skmean` | number | no | 0 | Simple kriging mean |

**search:**

| Field | Type | Default |
|-------|------|---------|
| `radius` | number | required |
| `ndmax` | number | min(nd, 20) |
| `ndmin` | number | 1 |
| `angle` | number | 0 |
| `angle2` | number | 0 |
| `angle3` | number | 0 |
| `radiusMinor` | number | radius |
| `radiusVert` | number | radius |

**discretization:**

| Field | Type | Default |
|-------|------|---------|
| `nx` | number | 1 |
| `ny` | number | 1 |
| `nz` | number | 1 |

---

### sgsim(opts)

Sequential Gaussian simulation. Returns `{ run(seed), dispose() }`. Data must be in normal score space.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `grid` | object | yes | — | 3D grid |
| `variogram` | object | yes | — | Variogram model |
| `search` | object | yes | — | See below |
| `data` | array | no | `[]` | `[[x, y, z, v], ...]` conditioning data (normal scores) |

**search:**

| Field | Type | Default |
|-------|------|---------|
| `radius` | number | required |
| `ndmax` | number | 10 |
| `ndmin` | number | 0 |
| `nodmax` | number | 12 |
| `angle` | number | 0 |
| `angle2` | number | 0 |
| `angle3` | number | 0 |
| `radiusMinor` | number | radius |
| `radiusVert` | number | radius |

`nodmax` controls the max previously simulated nodes to use as neighbors.

---

### gamv(opts)

Experimental variogram computation. Returns `{ distance, value, npairs, hm, tm }` as Float64Array[ndir * (nlag+2)].

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | array | yes | — | `[[x, y, v], ...]` or `[[x, y, z, v], ...]` |
| `lags` | object | yes | — | Lag specification |
| `directions` | array | no | `[{ azimuth: 0, tolerance: 90 }]` | Directional filters |
| `trim` | object | no | `{}` | Data trimming limits |

**lags:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `n` | number | yes | — | Number of lags |
| `size` | number | yes | — | Lag distance |
| `tolerance` | number | no | size/2 | Lag tolerance |

**directions[]:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `azimuth` | number | 0 | Azimuth angle (degrees) |
| `tolerance` | number | 90 | Angular tolerance |
| `bandwidthH` | number | 1e21 | Horizontal bandwidth |
| `dip` | number | 0 | Dip angle (3D) |
| `dipTolerance` | number | 90 | Dip angular tolerance |
| `bandwidthV` | number | 1e21 | Vertical bandwidth |

**trim:**

| Field | Type | Default |
|-------|------|---------|
| `min` | number | -1e21 |
| `max` | number | 1e21 |

---

### declus(opts)

Cell declustering. Returns `{ weights, cellSize, weightedMean }`.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | array | yes | — | `[[x, y, v], ...]` or `[[x, y, z, v], ...]` |
| `cellRange` | [number, number] | yes | — | [min, max] cell sizes to sweep |
| `ncell` | number | no | 25 | Number of cell sizes to test |
| `noff` | number | no | 8 | Origin offsets per cell size |
| `anisotropy` | object | no | `{}` | Cell shape ratios |
| `criterion` | string | no | "min" | Optimize weighted mean: "min" or "max" |
| `trim` | object | no | `{}` | Data trimming limits |

**anisotropy:**

| Field | Type | Default |
|-------|------|---------|
| `y` | number | 1 |
| `z` | number | 1 |

**trim:** same as gamv.

---

### ik3d(opts)

3D indicator kriging. Returns `{ ccdf }` as Float64Array[nxyz * ncut].

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | array | yes | — | `[[x, y, z, v], ...]` |
| `grid` | object | yes | — | 3D grid |
| `cutoffs` | number[] | yes | — | Threshold values |
| `variograms` | object[] | yes | — | One variogram per cutoff |
| `search` | object | yes | — | See below |
| `ktype` | string | no | "OK" | "OK" or "SK" |
| `categorical` | boolean | no | false | Categorical (true) or continuous (false) indicators |

**search:**

| Field | Type | Default |
|-------|------|---------|
| `radius` | number | required |
| `ndmax` | number | min(nd, 20) |
| `ndmin` | number | 1 |
| `noct` | number | 0 |
| `angle` | number | 0 |
| `angle2` | number | 0 |
| `angle3` | number | 0 |
| `radiusMinor` | number | radius |
| `radiusVert` | number | radius |

`noct` limits samples per octant (0 = disabled).

---

### sisim(opts)

Sequential indicator simulation. Returns `{ run(seed), dispose() }`.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `grid` | object | yes | — | 3D grid |
| `cutoffs` | number[] | yes | — | Threshold values |
| `variograms` | object[] | yes | — | One variogram per cutoff |
| `search` | object | yes | — | See below |
| `data` | array | no | `[]` | `[[x, y, z, v], ...]` conditioning data (original scale) |
| `globalCdf` | number[] | no | computed | Marginal CDF at cutoffs |
| `ktype` | string | no | "OK" | "OK" or "SK" |
| `categorical` | boolean | no | false | Categorical or continuous indicators |
| `tails` | object | no | `{}` | CDF tail extrapolation |
| `zmin` | number | no | auto | Minimum possible value |
| `zmax` | number | no | auto | Maximum possible value |

If `globalCdf` is omitted, it's computed from conditioning data. If no data, uniform quantiles are used.

`zmin` defaults to `cutoffs[0] - cutRange`, `zmax` defaults to `cutoffs[ncut-1] + cutRange`, where `cutRange = cutoffs[ncut-1] - cutoffs[0]`.

**search:**

| Field | Type | Default |
|-------|------|---------|
| `radius` | number | required |
| `ndmax` | number | 10 |
| `ndmin` | number | 0 |
| `nodmax` | number | 12 |
| `noct` | number | 0 |
| `angle` | number | 0 |
| `angle2` | number | 0 |
| `angle3` | number | 0 |
| `radiusMinor` | number | radius |
| `radiusVert` | number | radius |

**tails:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lower.type` | number | 1 | 1=linear, 2=power |
| `lower.param` | number | 0 | Lower tail parameter |
| `upper.type` | number | 1 | 1=linear, 2=power, 4=hyperbolic |
| `upper.param` | number | 5 | Upper tail parameter |

---

### cokb3d(opts)

3D collocated cokriging. Returns `{ est, var }` as Float64Array[nxyz].

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | object | yes | — | Primary + secondary data |
| `grid` | object | yes | — | 3D grid |
| `variograms` | object | yes | — | Three variogram models |
| `search` | object | yes | — | See below |
| `discretization` | object | no | `{}` | Block kriging discretization |
| `ktype` | string | no | "OK" | "OK" or "SK" |
| `skmean` | object | no | `{}` | SK means for both variables |

**data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `primary` | array | yes | `[[x, y, z, v], ...]` |
| `secondary` | array | yes | `[[x, y, z, v], ...]` (collocated, same coordinates) |

**variograms:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `primary` | object | yes | Primary auto-variogram |
| `secondary` | object | yes | Secondary auto-variogram |
| `cross` | object | yes | Cross-variogram |

**search:**

| Field | Type | Default |
|-------|------|---------|
| `radius` | number | required |
| `ndmaxPrimary` | number | min(nd, 16) |
| `ndmaxSecondary` | number | min(nd, 16) |
| `ndmin` | number | 1 |
| `angle` | number | 0 |
| `angle2` | number | 0 |
| `angle3` | number | 0 |
| `radiusMinor` | number | radius |
| `radiusVert` | number | radius |

**discretization:**

| Field | Type | Default |
|-------|------|---------|
| `nx` | number | 1 |
| `ny` | number | 1 |
| `nz` | number | 1 |

**skmean:**

| Field | Type | Default |
|-------|------|---------|
| `primary` | number | 0 |
| `secondary` | number | 0 |

---

### nscore(opts)

Normal score transform. Returns `{ scores, table }`.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | number[] | yes | — | Raw data values (1D array) |
| `weights` | number[] | no | equal | Declustering or sampling weights |
| `trim` | object | no | `{}` | Data trimming limits |

**trim:**

| Field | Type | Default |
|-------|------|---------|
| `min` | number | -1e21 |
| `max` | number | 1e21 |

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `scores` | Float64Array[nd] | Normal scores in original data order |
| `table.values` | Float64Array[nd] | Sorted original values |
| `table.scores` | Float64Array[nd] | Corresponding normal scores (sorted by value) |

---

### backtr(opts)

Back-transform from normal scores. Returns `Float64Array[n]`.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scores` | Float64Array\|number[] | yes | — | Normal scores to back-transform |
| `table` | object | yes | — | Transform table from `nscore().table` |
| `tails` | object | no | `{}` | Tail extrapolation options |

**table:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `values` | Float64Array | yes | Sorted original data values |
| `scores` | Float64Array | yes | Corresponding normal scores (sorted) |

**tails:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lower.type` | number | 1 | 1=linear, 2=power |
| `lower.param` | number | 0 | Lower tail parameter (power exponent) |
| `lower.min` | number | table min | Minimum extrapolation limit |
| `upper.type` | number | 1 | 1=linear, 2=power, 4=hyperbolic |
| `upper.param` | number | 0 | Upper tail parameter |
| `upper.max` | number | table max | Maximum extrapolation limit |

---

### vmodel(opts)

Variogram model evaluation. Returns `{ distance, value, correlation }` as Float64Array[ndir * nlag].

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `variogram` | object | yes | — | Variogram model (same as kb2d/kt3d) |
| `lags` | object | yes | — | Lag specification |
| `directions` | array | no | `[{ azimuth: 0, dip: 0 }]` | Evaluation directions |

**lags:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `n` | number | yes | — | Number of lags |
| `size` | number | yes | — | Lag spacing |

**directions[]:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `azimuth` | number | 0 | Azimuth angle (degrees, from N) |
| `dip` | number | 0 | Dip angle (degrees, from horizontal) |

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `distance` | Float64Array[ndir * nlag] | Lag distances |
| `value` | Float64Array[ndir * nlag] | Semivariogram gamma(h) |
| `correlation` | Float64Array[ndir * nlag] | Correlogram C(h)/C(0) |

## Testing

```
npm test
```

Tests compile gslib.atra to Wasm via `bundle()`, instantiate with shared memory, and verify each routine against known values and Fortran behavior.

`test/gslib-validate.js` runs validation against Fortran Gslib90 reference executables for kb2d (4 configs), kt3d (8 configs), and sgsim (20 realizations). The new programs (gamv, declus, ik3d, sisim, cokb3d) are tested via unit tests in `test/gslib.test.js`.

## GSLIB parity roadmap

### Feature gaps in existing routines

Implemented routines that are missing features compared to the original Fortran.

#### atra code gaps (not implemented in Wasm)

| Routine | Missing feature | Impact |
|---------|----------------|--------|
| **sgsim** | `itrans` — internal nscore/backtr | Back-transforming 100k+ nodes requires 100k JS→Wasm calls. Array-level `backtr` in atra or internal transform would eliminate crossing overhead. |
| **sgsim** | `mults` — multiple grid search | No multi-grid acceleration for very large grids. Single-grid search only. |
| **sgsim** | `varred` — variance reduction factor | Cannot scale kriging variance (used in some post-processing workflows). |
| **kt3d** | `koption` — jackknife cross-validation | Cannot do leave-one-out validation within kt3d. Must be done externally in JS. |
| **kt3d** | `itrend` — estimate trend surface itself | Cannot output the drift/trend component separately from the residual. |
| **beyond** | Power interpolation in middle range | Middle CDF interpolation is always linear (option 1 only). Fortran supports power (option 2). |
| **beyond** | Global CDF rescaling (option 3) | Cannot rescale indicator CDF to match a target global distribution. |
| **beyond** | zval→cdfval direction | Only draws values from CDF (cdfval→zval). Cannot compute CDF probability for a given value. |
| **precision** | f32 truncation in gauinv/gcum | All f64 vs Fortran's mixed precision. Normal scores differ slightly from Fortran output. May matter for bit-reproducibility validation. |

#### API wrapper gaps (atra supports it, api.js doesn't expose it)

| Wrapper | Missing feature | What atra supports |
|---------|----------------|-------------------|
| **kt3d** | ktype 2 — SK with locally varying mean | atra accepts `ktype=2` + `ve` array as local mean per data point |
| **kt3d** | ktype 3 — KT/UK with polynomial drift | atra accepts `ktype=3` + `idrif[9]` flags + optional external drift via `ve` |
| **sgsim** | ktype 1–4 in internal krige | atra's `krige` supports OK (1), LVM (2), external drift (3), collocated cosim (4). API hardcodes SK (0). |
| **sgsim** | `sec`, `lvm`, `colocorr` | Secondary variable, locally varying mean grid, collocated correlation — atra accepts them, API zeros them. |
| **sgsim** | `noct` — octant search | atra supports it, API hardcodes 0. |

### Missing programs

Non-graphical programs from GSLIB 2nd edition (Deutsch & Journel, 1998) not yet implemented. Excludes PostScript plotting programs (histplt, scatplt, pixelplt, probplt, qpplt, locmap, bivplt, vargplt, plotem) and variant SISIM implementations (sisim_gs, sisim_lm).

#### Tier 1 — High priority

| Program | Description | Approach |
|---------|-------------|----------|
| **postsim** | Post-process simulation realizations: E-type mean, probability maps, percentiles | New atra subroutine + api.js wrapper |
| **postik** | Post-process indicator kriging CCDFs: E-type, probability above threshold | Similar to postsim, uses `beyond` |
| **trans** | Univariate distribution transform (match target CDF) | New atra subroutine, uses sortem/locate/powint |

#### Tier 2 — Medium priority

| Program | Description | Approach |
|---------|-------------|----------|
| **lusim** | LU decomposition simulation (full covariance matrix) | Needs Cholesky factorization, O(n^3), small grids only |
| **gam** | Grid variogram (exploits regular spacing) | Much faster than gamv for gridded data |
| **varmap** | Variogram map/volume in lag space | 2D/3D anisotropy detection |
| **scatsmth** | Bivariate scatterplot smoothing | Conditional probabilities for soft kriging calibration |

#### Tier 3 — Lower priority

| Program | Description | Approach |
|---------|-------------|----------|
| **histsmth** | Histogram smoothing via simulated annealing | Smooth CDF honoring data statistics |
| **pfsim** | Probability field simulation | Pre-kriged CDFs + probability field |
| **gtsim** | Gaussian truncated simulation | Categorical via truncated Gaussian |
| **sasim** | Simulated annealing simulation | Multiple objective functions |
| **ellipsim** | Boolean/ellipsoidal object simulation | Object-based, not pixel-based |
| **bicalib** | Markov/Bayes calibration | Soft indicator calibration from secondary info |
| **bigaus** | Indicator variograms from biGaussian model | Checking biGaussian assumptions |

#### Skipped

| Program | Reason |
|---------|--------|
| **addcoord** | File format utility — JS constructs grid coordinates directly |
| **rotcoord** | Trivial 2D coordinate rotation |
| **draw** | Monte Carlo CDF sampling — trivial in JS |
| **anneal** | Post-process categorical realizations — very specialized |
