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

## Implementation order

Following the dependency chain from primitives to programs:

1. **RNG** — acorni
2. **Probability** — gauinv, gcum
3. **Geometry** — powint, locate, getindx, setrot, sqdist
4. **Covariance** — cova3
5. Sorting — sortem, dsortem
6. Data transform — nscore, backtr
7. Search — setsupr, srchsupr, picksupr
8. Kriging — kt3d/kb2d core loops
9. Simulation — sgsim/sisim core loops

Items 1-4 are implemented. Items 5+ are future work.

## Rotation matrix storage

Fortran stores `rotmat(MAXROT, 3, 3)` with `rotmat(ind, i, j)`.

Atra uses a flat f64 array: matrix `ind` occupies `rotmat[ind*9 .. ind*9+8]`, with element `(i, j)` at `rotmat[ind*9 + i*3 + j]` (0-indexed, row-major per block).

`setrot` and `sqdist` both take `rotmat: array f64; ind: i32`. `cova3` takes base `irot` and computes `irot + is` for each nested structure.

## RNG

`acorni` implements the ACORN generator (Wikramaratna, 1990) of order 12 with modulus 2^30. State is a 13-element i32 array: `ixv[0]` = seed, `ixv[1..12]` = 0 initially. Each call advances the state and returns a uniform value in [0, 1). The caller owns the state array, enabling multiple independent streams.

## Testing

```
npm test
```

Tests compile gslib.atra to Wasm via `bundle()`, instantiate with shared memory, and verify each routine against known values and Fortran behavior.
