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

## Implementation order

Following the dependency chain from primitives to programs:

1. **RNG** — acorni
2. **Probability** — gauinv, gcum
3. **Geometry** — powint, locate, getindx, setrot, sqdist
4. **Covariance** — cova3
5. **Sorting** — sortem
6. **Data transform** — nscore, backtr
7. **Search** — setsupr, picksup, srchsupr
8. Kriging — kt3d/kb2d core loops
9. Simulation — sgsim/sisim core loops

Items 1-8 are implemented. Item 9 is future work.

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

`kt3d` is the full 3D kriging program. Super block search (setsupr/picksup/srchsupr), block discretization (nxdis x nydis x nzdis), and multiple kriging types: ktype=0 (SK), ktype=1 (OK), ktype=2 (SK with locally varying mean from external variable), ktype=3 (KT/UK with up to 9 polynomial drift terms + optional external drift). Uses `ktsol` for the kriging system. Single-sample case handled separately. Data coordinates shifted relative to block corner for drift term computation. Drift function means (bv) precomputed and stored in `supout[9..17]`. Rescaling factor `resc = 1/(4*radsqd/covmax)` for numerical stability with drift.

All scratch arrays are caller-provided — atra has no local arrays.

## RNG

`acorni` implements the ACORN generator (Wikramaratna, 1990) of order 12 with modulus 2^30. State is a 13-element i32 array: `ixv[0]` = seed, `ixv[1..12]` = 0 initially. Each call advances the state and returns a uniform value in [0, 1). The caller owns the state array, enabling multiple independent streams.

## Testing

```
npm test
```

Tests compile gslib.atra to Wasm via `bundle()`, instantiate with shared memory, and verify each routine against known values and Fortran behavior.
