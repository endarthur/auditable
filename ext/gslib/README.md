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

Items 1-9 are implemented. Future: sisim (sequential indicator simulation).

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

## RNG

`acorni` implements the ACORN generator (Wikramaratna, 1990) of order 12 with modulus 2^30. State is a 13-element i32 array: `ixv[0]` = seed, `ixv[1..12]` = 0 initially. Each call advances the state and returns a uniform value in [0, 1). The caller owns the state array, enabling multiple independent streams.

## Testing

```
npm test
```

Tests compile gslib.atra to Wasm via `bundle()`, instantiate with shared memory, and verify each routine against known values and Fortran behavior.
