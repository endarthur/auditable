# @gcu/line

**NumPy-shaped linear algebra in pure JavaScript — and faster than Wasm SIMD for the small-to-medium sizes that dominate real workloads.**

`@gcu/line` is the linear-algebra kernel for the GCU stack: N-D arrays, broadcasting, BLAS-1, decompositions, solvers, norms. Pure JS, no Wasm, no FFI. The whole point is that V8's TurboFan auto-vectorizes simple `Float64Array` loops to AVX f64x4 — twice the lane width Wasm SIMD spec-ceilings at — so hand-tuned JS wins the small/medium sizes that most numerical work actually touches.

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 0.3 (renamed from @gcu/vec in 0.2.0)           |
| Status     | Pre-1.0; shipped 2026-05                       |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | NumPy API; BLAS / LAPACK; V8 numeric tuning    |

---

## Lineage

The NumPy API is the *lingua franca* of numerical computing — designed in the early 2000s, refined for two decades, every Python scientific package speaks it. The same API shape (broadcasting, axes, dtype, strides, fancy indexing) has been adopted by JAX, PyTorch, MXNet, CuPy, dask, xarray. When someone writes `A @ B + C` in numerical Python, they mean the same thing in any of those.

Below NumPy sits BLAS (Basic Linear Algebra Subprograms — level 1 vector ops, level 2 matrix-vector, level 3 matrix-matrix) and LAPACK (linear systems, eigenvalues, decompositions). These have been the standard since Dongarra et al. designed them in 1979; every serious numerical library calls into a BLAS implementation (OpenBLAS, MKL, Accelerate).

`@gcu/line` is the NumPy-shaped surface on top of hand-written JS BLAS-1 and a slim BLAS-3 / LAPACK-shape subset. The implementation is *not* a port of NumPy or BLAS — those are dense C/Fortran codebases tuned for cache hierarchies and L1/L2 prefetching that JS doesn't have access to. Instead, line tunes for what V8 *can* do: tight typed-array loops with unrolled accumulators that the JIT auto-vectorizes to AVX f64x4.

The package was originally named `@gcu/vec` (v0.1, v0.2.0). Renamed to `@gcu/line` because "line" — the kind of thing — reads better than `vec` (which was misleadingly suggestive of "just vectors"). The hand-tuned reductions and matmul that motivated the package work for both vectors and matrices; the name "line" is the abstract category.

See [V8-WINKING.md](./V8-WINKING.md) for the implementation notes on the V8-tuned kernels — that document carries the empirical work behind the BLAS-1 and 4×4 register-tiled matmul claims.

## Premise

Three commitments drive the design:

1. **Float64Array is the type.** Everything ultimately reads/writes a `Float64Array`. ndarrays are descriptor objects (`{ data, shape, strides, dtype }`) over a `Float64Array` view; the work loops always touch the flat buffer directly. No abstract Array-of-Number; no Wasm linear memory; no SharedArrayBuffer (yet). The whole engine assumes flat double-precision contiguous-or-strided buffers.
2. **V8 first.** Hot loops are hand-unrolled to expose the parallelism TurboFan needs to emit AVX. Reductions use 4 parallel accumulators; matmul uses a 4×4 register-tiled kernel. The number 4 is everywhere because TurboFan reliably auto-vectorizes 4-way patterns to f64x4 — see V8-WINKING for the bench data. We could push to 8-way unroll for some shapes but the bench wins are inconsistent across CPU generations.
3. **NumPy where it makes sense.** Broadcasting, axes, fancy indexing, the `solve` / `lstsq` / `qr` / `svd` / `cholesky` naming. We don't ape every NumPy edge case (no `dtype=object`, no masked arrays, no `recarray`), but the 90% of NumPy that 90% of users touch is here and behaves the way they expect.

## Data model

### The `ndarray`

An ndarray is a JS object with:

```js
{
  data:    Float64Array,    // the buffer
  shape:   number[],        // dimension sizes
  strides: number[],        // element-stride per dimension (NOT byte-stride)
  dtype:   'float64',       // always, currently
  offset:  number,          // start offset into data
  // ... helper methods on the prototype
}
```

Strides are in **elements**, not bytes (one stride unit = 8 bytes for `Float64Array`). This is the only deviation from NumPy's convention; it makes the JS loops cleaner.

A "view" is an ndarray sharing the same underlying buffer with different shape/strides — used for slicing, transposing, reshaping zero-copy. `arr.copy()` materializes a new buffer.

### Broadcasting

Right-aligned axes; size-1 axes broadcast to any size; missing axes broadcast from the left. NumPy's rules exactly:

```
shape (3, 4) + shape (4)         → shape (3, 4)
shape (3, 1) + shape (5)         → shape (3, 5)
shape (2, 3, 4) + shape (3, 1)   → shape (2, 3, 4)
shape (3,) + shape (4,)          → ValueError (incompatible)
```

Broadcasting is virtual — no allocation. The broadcast iterator advances through both operands with appropriate stride adjustments.

### Creation

```js
const a = line.array([[1,2,3],[4,5,6]]);            // from nested arrays
const b = line.zeros([3, 3]);                       // zero-initialised
const c = line.linspace(0, 1, 100);                 // evenly spaced
const d = line.arange(10);                          // 0..9
const e = line.eye(5);                              // identity
const f = line.fromBuffer(buf, [10, 10]);           // wrap a Float64Array
```

Constants follow NumPy: `line.ones`, `line.empty`, `line.full`, `line.logspace`, `line.tri`, `line.diag`.

## Module surface

```
ext/line/src/
  ndarray.js             — ndarray class + broadcasting + indexing
  creation.js            — array, zeros, ones, empty, linspace, arange, eye, ...
  ops.js                 — element-wise math (add, mul, exp, sin, ...)
  reduce.js              — sum, mean, std, var, min, max, argmin, argmax, ...
  shape.js               — reshape, transpose, flatten, concatenate, stack
  selection.js           — slicing, fancy indexing, boolean indexing, where
  linalg-mul.js          — matmul, dot, inner, outer, cross, kron, einsum (subset)
  linalg-solve.js        — solve, solve_triangular, lstsq, pinv
  linalg-norms.js        — norm (vector + matrix), det
  linalg-qr.js           — qr (Householder)
  linalg-svd.js          — svd (Jacobi for small, bidiagonal for large)
  linalg-eigen.js        — eigSym, eigSym3 (closed form for 3×3)
  linalg-lstsq.js        — least squares (qr / normal-equations / svd methods)
  index.js               — public namespace + adder bridge re-exports
```

Splitting linalg across files keeps each file under ~500 lines and lets the test suite import individual factorizations without dragging in the rest. The public namespace (`line.*`) is assembled in `index.js`.

## BLAS-1 — V8-winked reductions

The five BLAS-1 routines (`sum`, `dot`, `norm` (`nrm2`), `mean`, `std`/`var`) are hand-unrolled to use four parallel accumulators:

```js
function dot(x, y, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    s0 += x[i  ] * y[i  ];
    s1 += x[i+1] * y[i+1];
    s2 += x[i+2] * y[i+2];
    s3 += x[i+3] * y[i+3];
  }
  let s = s0 + s1 + s2 + s3;
  for (; i < n; i++) s += x[i] * y[i];
  return s;
}
```

TurboFan vectorizes this to AVX f64x4 (one 256-bit FMA per loop iteration). The wider `s0`/`s1`/`s2`/`s3` accumulators are essential — naive single-accumulator code creates a serial dependency chain the vectorizer can't break.

Empirical: matches alpack (Wasm SIMD, f64x2) at n=8, beats it for n≥64, and stays ahead through n=262144. See V8-WINKING for the full bench plot.

`Math.fround()` calls block vectorization (verified). We don't use f32 paths in line; that single-precision niche belongs in a future package.

## BLAS-3 — register-tiled matmul

The matrix-matrix multiply uses a 4×4 register-tiled kernel. For each 4×4 output block, eight register-resident accumulators hold the partial sums; the inner loop streams through the corresponding column of A and row of B once, accumulating into the registers. Two 4-element vectors per inner iteration; TurboFan vectorizes both to f64x4.

Performance crossover:

| Size N | line (JS) | alpack (Wasm SIMD) | Winner |
|---|---|---|---|
| 128 | 12 ms | 18 ms | line |
| 256 | 67 ms | 75 ms | line |
| 512 | 480 ms | 480 ms | tie |
| 1024 | 3.4 s | 3.4 s | tie |
| 4096 | 200 s | 200 s | tie |

For N ≥ 512, the matmul is dominated by memory bandwidth and the two implementations converge. For N ≤ 256 (the typical estimator-shape input — chunks of 100-200 training points), line wins by 30-50%.

The matmul falls back to a `2 × 2` blocked kernel when one dimension is below 4 (no-good for register-tile padding) — still vectorized, just smaller blocks.

## Decompositions

- **QR** via Householder reflections. Numerically stable, the right choice for solving least-squares.
- **SVD** dispatches by size: Jacobi rotations for small (n ≤ 64) and bidiagonalization + QR for larger. The Jacobi path is direct from the linear-algebra textbooks; the bidiagonal path is shorter than LAPACK's golden-rule and trades a small amount of accuracy for substantially less code.
- **Cholesky** for symmetric positive-definite. In-place over the lower triangle; falls back to a clearer error if the matrix is not positive-definite.
- **Eigensymmetric** (`eigSym`) via Jacobi rotations for general n, plus a `eigSym3` closed-form analytic for 3×3 (the case that comes up in stress tensors and PCA on 3-channel data).

Throw on numerical breakdown rather than returning NaN: if Cholesky hits a negative pivot or QR finds a zero column, the call raises with a useful error message.

## Solvers

- `solve(A, b)` — Ax=b via LU with partial pivoting.
- `solve_triangular(L, b, { lower, unit, trans })` — back/forward sub, used by Cholesky and inside more complex factorizations.
- `lstsq(A, b, { method })` — least squares; `method` selects `'qr'` (Householder), `'normal'` (normal equations, faster but less accurate), or `'svd'` (rank-revealing pseudo-inverse for rank-deficient `A`).
- `pinv(A)` — Moore-Penrose pseudo-inverse via SVD.

For estimator-shape Cholesky and lstsq, `@gcu/line` is direct and fine; for very large problems (n ≥ 10000), [@gcu/alpack](https://www.npmjs.com/package/@gcu/alpack) (Wasm LAPACK) is the right tool.

## Norms

- Vector: L1, L2, L∞, p-norm.
- Matrix: Frobenius, induced (1, 2, ∞), nuclear (sum of singular values via SVD).

Stable implementations: L2 norm uses scaling to avoid overflow on near-overflow inputs (`||x||₂ = max(|x|) × ||x / max(|x|)||₂`).

## Closed-form fast paths

`det`, `inv`, and `solve` for 2×2 / 3×3 / 4×4 ship as explicit closed-form expansions — no LU, no SVD, no matmul. These shapes come up constantly (homogeneous coordinates, stress tensors, rotation matrices, RGBA pixel transforms); the explicit forms are ~10× faster than the generic LU path.

## When to use line vs. natra vs. alpack

| Use case | Tool |
|---|---|
| Vectors / matrices ≤ ~1k elements | line |
| Element-wise broadcasting, axis reductions | line or natra; line wins on small sizes |
| Matmul up to ~256 | line (register-tiled JS) |
| Matmul ≥ ~1024 | line ties alpack; either fine |
| BLAS-1 (dot, sum, nrm2) on contiguous Float64Array | line |
| Large strided / multi-dim BLAS via natra's interface | natra (which uses atra under the hood) |
| LAPACK-grade factorizations on n ≥ 5000 | alpack (Wasm LAPACK) |
| Sparse matrices | None of these (see future @gcu/sparse) |

The decision tree: **prefer line** for everything that fits in a JS `Float64Array` and isn't a deep-LAPACK workload. Cross to natra when the array is part of a larger atra/Wasm pipeline; cross to alpack when the linear-algebra demand is heavy.

## Adder bridge

`line` ships with an adder (Python) bridge — `from line import …`. The bridge module mirrors NumPy's surface so Python notebooks read naturally:

```python
import line as np

A = np.array([[1,2,3],[4,5,6]])
v = np.linspace(0, 1, 100)
q, r = np.linalg.qr(A)
```

`np.linalg.*` exports `qr`, `svd`, `solve`, `lstsq`, `pinv`, `cholesky`, `eigSym`, `norm`, `det`, `matrix_rank`.

Values are JS Float64Arrays / line ndarrays under the hood — no marshalling. Adder Python values *are* JS values; the bridge is a thin namespace, not an FFI.

## Architecture

The library is ~6 500 lines across the files listed above. Each linalg-* module is ~500-1000 lines. The bench / V8-tuning work lives in `test/line-v8-winking-bench.mjs` and is not part of the shipped bundle.

Build is a concat-and-strip: `node ext/line/build.js` reads `index.js`'s declared import order, concatenates the sources, removes `import` / `export` statements, and emits a single ESM module.

## Testing

Three test files (`test/line-core.test.mjs`, `test/line-extra.test.mjs`, `test/line-adder.test.mjs`) covering ~1500 cases:

- ndarray creation, indexing, slicing, fancy indexing, boolean indexing
- broadcasting on arbitrary shapes
- element-wise ops vs scalar reference
- reductions (sum, mean, std, min, max, argmin, …) with and without axes
- shape ops (reshape, transpose, flatten, concatenate, stack, split)
- linalg: dot, matmul, det, inv, solve, lstsq (all 3 methods), pinv, qr, svd, cholesky, eigSym
- norm (vector + matrix variants)
- closed-form 2×2 / 3×3 / 4×4 paths vs. generic
- adder bridge: every NumPy alias resolves to the right line function

## Open questions

- **f32 path.** A separate `Float32Array` BLAS would halve memory bandwidth + double SIMD lane count. Not in line; possibly a sibling `@gcu/line-f32` later.
- **Sparse matrices.** No support. The right shape is a separate package (CSR / CSC + sparse BLAS); not on roadmap.
- **GPU compute.** WebGPU matmul for n ≥ 4096 might win significantly, but the implementation cost is high and the niche is small (most JS workloads don't approach that size).
- **Better SVD.** Current bidiagonal path is correct but not LAPACK-grade. For estimator-shape uses it's fine; if someone hits a numerical edge case, the option is to delegate to alpack.
- **Strict mode.** Some calls accept `Float64Array` and convert; some require ndarrays. Could be more consistent.

## What @gcu/line is NOT

- **A NumPy port.** We share the API; we don't share the implementation. Performance characteristics differ; some advanced features (masked arrays, structured arrays, broadcast-incompatible vectorize) are absent.
- **A wrapper over Wasm BLAS.** Pure JS. If you want Wasm-accelerated BLAS, see [@gcu/alpack](https://www.npmjs.com/package/@gcu/alpack).
- **A tensor framework.** No autograd, no GPU dispatch, no convolution layers. For ML workloads use TF.js or call out to a real framework.
- **A symbolic CAS.** No exact arithmetic, no expression trees. SymPy-shape is a different category.

## Versioning

Pre-1.0 means: the ndarray model is stable, the BLAS-1 / matmul / factorization API is stable, the adder bridge surface is stable. New solvers and decompositions land on minor versions. The internal V8 tuning may change (and should always remain at least as fast as the published claims).

The package was renamed from `@gcu/vec` to `@gcu/line` at 0.3.0 — older `@gcu/vec` releases are deprecated and pointed at the new name.
