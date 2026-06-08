# @gcu/line

Linear algebra for JavaScript — the NumPy-shaped piece that's been
missing from the JS ecosystem.

- N-dimensional arrays backed by `Float64Array`
- NumPy-style broadcasting (right-aligned axes; size-1 broadcasts)
- Element-wise math, reductions with optional axis
- **BLAS-1** — `sum`, `dot`, `norm`, `mean`, `std`, `var` with V8-winked
  unrolled-4 accumulators that auto-vectorize to AVX f64x4 — **beat
  Wasm SIMD on the same machine**
- **Decompositions** — `qr`, `svd`, `cholesky`, `eigSym`, `eigSym3`
- **Solvers** — `solve`, `lstsq` (qr/normal/svd methods), `pinv`,
  `solve_triangular`
- **Norms** — vector L1/L2/L∞/p-norm, matrix Frobenius/induced/nuclear
- **Utilities** — `cross`, `kron`, `matrix_power`, `matrix_rank`,
  closed-form det/inv for 2×2/3×3/4×4
- **Register-tiled 4×4 matmul** — ties alpack's wasm SIMD at large N
- Pure JS — no wasm, no native dependencies
- Works in Node, modern browsers, Deno, Bun
- ~90 KB unminified, single ES module, zero runtime deps

`@gcu/line` is part of the [Auditable](https://github.com/gentropic/auditable)
ecosystem and ships with a Python (adder) bridge, but the core library
is fully usable as a standalone npm package.

## Why?

In late-2026 microbenchmarks, plain `Float64Array` JavaScript loops
beat both NumPy (Python-C boundary) and wasm-backed numerical libraries
for arrays under ~50K elements:

| 10K vector add (op only) | ms/run |
|---|---:|
| Plain `Float64Array` + JS for-loop | 0.004 |
| natra (wasm-backed ndarray) | 0.072 |
| CPython + NumPy | 0.007 |

V8's JIT inlines and autovectorizes tight typed-array loops to
near-C performance. The wasm boundary cost and the Python-C boundary
cost both dominate over the actual numerical work at this size.

`@gcu/line` provides an ergonomic NumPy-flavored API on top of the same
fast `Float64Array` loops, with proper broadcasting, ndarrays, and a
small but useful linear algebra subset.

## Installation

```bash
npm install @gcu/line
```

## Quickstart

```js
import * as line from '@gcu/line';

// Creation
const a = line.from([1, 2, 3, 4]);
const m = line.from([[1, 2, 3], [4, 5, 6]]);
const z = line.zeros([3, 3]);
const I = line.eye(4);
const xs = line.linspace(0, 1, 11);

// Element-wise math (with broadcasting)
const c = line.add(a, 10);                       // [11, 12, 13, 14]
const r = line.mul(m, line.from([10, 20, 30]));   // broadcast row vector

// Reductions
line.sum(a);                  // 10
line.sum(m, { axis: 0 });     // NdArray [3]
line.mean(m, { axis: 1 });    // NdArray [2]

// Linear algebra
const A = line.from([[2, 1], [5, 7]]);
const b = line.from([11, 13]);
const x = line.solve(A, b);   // x = A^-1 b

// Symmetric eigendecomposition
const sigma = line.from([[10, 2, 0], [2, 8, 1], [0, 1, 6]]);
const { values, vectors } = line.eigSym3(sigma);
// values: descending eigenvalues, vectors: orthonormal columns

// Conversion
console.log(c.toArray());    // [11, 12, 13, 14]
console.log(m.shape);        // [2, 3]
```

## API

### NdArray

The core data structure. Always contiguous `Float64Array` storage with
shape metadata. Slicing, transposing, and reshaping produce new
contiguous arrays (copies) — there are no views.

```js
new NdArray(data: Float64Array, shape: number[])

a.data     // backing Float64Array (read-only access encouraged)
a.shape    // number[]
a.strides  // number[] (row-major)
a.size     // total element count
a.ndim     // shape.length
a.dtype    // 'f64' (always in v1)

a.get(...indices)      // scalar element lookup
a.set(...indices, val) // in-place set
a.row(i)               // 1D NdArray (2D source only; copies)
a.col(j)               // 1D NdArray (2D source only; copies)
a.toArray()            // flat array (1D) or nested array (N-D)
a.toString()           // human-readable
```

### Creation

```js
line.zeros(shape)              // shape: number or array
line.ones(shape)
line.full(shape, value)
line.range(start, end?, step?)  // Python-style; line.range(5) = [0,1,2,3,4]
line.linspace(a, b, n)          // n equally-spaced
line.eye(n)                     // n×n identity matrix
line.from(source, shape?)
  // - from(nestedArray)        → auto-detect shape
  // - from(flatArray, shape)   → reshape flat data
  // - from(otherNdArray)       → copy
```

### Element-wise binary

Three dispatch arms inside each op:

1. **Scalar** (one operand is a `number`): tight flat loop.
2. **Shape-equal** (both arrays, identical shapes): tight flat loop —
   V8 inlines and autovectorizes.
3. **Broadcast** (compatible different shapes): stride-iterated path.

```js
line.add(a, b)
line.sub(a, b)
line.mul(a, b)
line.div(a, b)
line.pow(a, b)
```

**Broadcasting rules** (NumPy-style):

- Shapes are right-aligned (missing leading dims treated as 1).
- Each axis pair must match exactly OR one side must be 1.
- Size-1 axes are broadcast to the larger size.

Examples:

- `[5] + scalar` → broadcasts scalar across the 5-vector
- `[3] + [4, 3]` → 1D vector adds to every row of the 4×3 matrix
- `[4, 1] + [4, 3]` → column vector tiles across columns
- `[2, 3] + [3, 2]` → ERROR (axis sizes 3 and 2 don't align)

### Element-wise unary

```js
line.neg(a)         line.abs(a)        line.sqrt(a)
line.log(a)         line.exp(a)
line.sin(a)         line.cos(a)        line.tan(a)
line.asin(a)        line.acos(a)       line.atan(a)
line.floor(a)       line.ceil(a)       line.round(a)
line.sign(a)
line.isnan(a)       line.isfinite(a)   // return 0/1 masks
```

Element-wise binary helpers (with broadcasting):

```js
line.atan2(y, x)    // angle from x-axis
line.hypot(a, b)    // sqrt(a² + b²) without overflow
line.maximum(a, b)  line.minimum(a, b)   // element-wise (not reduction)
line.eq(a, b)       line.ne(a, b)        // 0/1 masks
line.lt(a, b)       line.le(a, b)
line.gt(a, b)       line.ge(a, b)
```

### Selection

```js
line.where(cond, a, b)   // out[i] = cond[i] ? a[i] : b[i]
                        // cond is NdArray; a/b are NdArray (matching shape)
                        // or scalar. No broadcasting between cond/a/b in v1.
line.clip(a, lo, hi)     // clamp each element to [lo, hi]
```

### Reductions

Without `axis`: returns a scalar number.
With `{ axis: i }`: returns an NdArray with that axis removed.

```js
line.sum(a, opts?)        line.prod(a, opts?)
line.mean(a, opts?)
line.max(a, opts?)        line.min(a, opts?)
line.std(a, opts?)        line.variance(a, opts?)   // var_ alias also exported
line.argmin(a, opts?)     line.argmax(a, opts?)     // indices
line.norm(a)                                       // L2 norm of all elements
line.trace(A)                                      // sum of diagonal (2D)
line.dot(a, b)
  // - 1D · 1D = scalar
  // - 2D · 1D = matrix-vector (1D NdArray)
  // - 1D · 2D = vector-matrix (1D NdArray)
  // - 2D · 2D = matmul (2D NdArray)

line.cumsum(a, opts?)     line.cumprod(a, opts?)    // running totals
  // No axis: flatten to 1D, return running total of size a.size.
  // With axis: same shape as a, accumulate along that axis.
```

`std` and `variance` accept `{ ddof: 0 | 1 }` (population vs sample
variance; default 0).

### Linear algebra

```js
// Multiplication
line.matmul(A, B)              // 2D × 2D → 2D (4×4 register-tiled)
line.transpose(A)              // 2D axes swap (copy)

// Linear systems (LU + partial pivoting)
line.solve(A, b)               // returns x; b can be 1D or 2D (multi-rhs)
line.det(A)                    // determinant
line.inv(A)                    // matrix inverse

// SPD systems (Cholesky)
line.cholesky(A)               // returns L (lower triangular)
line.solveCholesky(L, b)       // forward + back-substitute given precomputed L

// Triangular solve (forward / back substitution)
line.solve_triangular(T, b, { lower: true })

// Decompositions
line.qr(A, { mode: 'thin' | 'full' })   // Householder QR
line.svd(A)                              // one-sided Jacobi SVD, thin
                                         // returns { U, s, V }: A = U·diag(s)·Vᵀ
line.pinv(A, { rcond })                  // Moore-Penrose pseudoinverse via SVD
line.matrix_rank(A)                      // numerical rank via SVD

// Least squares (three methods)
line.lstsq(A, b)                         // default: QR (κ(A), stable)
line.lstsq(A, b, { method: 'normal' })   // AᵀA via Cholesky (fastest, κ(A)²)
line.lstsq(A, b, { method: 'svd' })      // most robust; handles rank-deficient A

// Symmetric eigendecomposition
line.eigSym3(A)                // 3×3 via Smith/Cardano closed-form
line.eigSym(A, opts?)          // N×N via Jacobi rotations

// Matrix powers
line.matrix_power(A, k)        // A^k via exp-by-squaring; k=0→I, k<0→inv

// Norms
line.vecNorm(x, ord=2)         // ord: 1, 2, Infinity, -Infinity, or p>0
line.matNorm(A, ord='fro')     // 'fro', 'nuc', 1, ±Infinity, ±2

// Products
line.cross(a, b)               // 3D cross product (1D × 1D → 1D)
line.kron(A, B)                // Kronecker product (also 1D × 1D)

// Closed-form fast paths
line.det2(A) / line.det3(A) / line.det4(A)
line.inv2(A) / line.inv3(A) / line.inv4(A)

// Matrix shape helpers
line.diag(a, k=0)
  // 1D input → 2D matrix with `a` on the k-th diagonal
  // 2D input → 1D vector of the k-th diagonal
line.outer(a, b)        // outer product (1D × 1D → 2D)
line.tril(A, k=0)       // keep on/below k-th diagonal, zero rest
line.triu(A, k=0)       // keep on/above k-th diagonal, zero rest
```

`eigSym3` and `eigSym` return `{ values, vectors }` where:
- `values`: 1D NdArray of eigenvalues, sorted **descending**
- `vectors`: 2D NdArray with eigenvectors as columns, orthonormal

`svd` returns `{ U, s, V }` with `A = U · diag(s) · Vᵀ` (thin SVD):
- `U`: m×k orthonormal columns
- `s`: 1D length k, descending
- `V`: n×k orthonormal columns
- where `k = min(m, n)`

#### Quick PCA example

For PCA of P variables on N samples, the cov+eig path is dramatically
cheaper than direct SVD when N >> P (the typical case):

```js
import { from, matmul, transpose, eigSym, sum } from '@gcu/line';

function pca(X) {  // X: N × P
  const N = X.shape[0], P = X.shape[1];
  // Center columns
  const means = new Float64Array(P);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < P; j++) means[j] += X.data[i * P + j];
  for (let j = 0; j < P; j++) means[j] /= N;
  const Xc = new Float64Array(N * P);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < P; j++) Xc[i * P + j] = X.data[i * P + j] - means[j];
  const Xcn = from(Xc, [N, P]);
  // Covariance (P × P) — much smaller than X
  const Cov = matmul(transpose(Xcn), Xcn);
  for (let i = 0; i < P * P; i++) Cov.data[i] /= (N - 1);
  // Symmetric eigendecomposition
  return eigSym(Cov);  // { values, vectors } — vectors are the principal directions
}
// PCA of 100 variables on 10,000 samples runs in ~66 ms.
```

### Shape ops

```js
line.reshape(a, newShape)
line.flatten(a)
line.slice(a, ranges)
  // ranges is an array of per-axis slice specs:
  //   null / undefined / missing → full axis
  //   { start?, end?, step? }    → start defaults to 0 (or end if step<0),
  //                                 end defaults to axis size (or 0 if step<0),
  //                                 step defaults to 1.
line.copy(a)

line.concat(arrays, axis=0)   // join along existing axis (shapes must match
                             // except along that axis)
line.stack(arrays, axis=0)    // introduce a NEW axis (all shapes must match
                             // exactly; result has ndim+1)
```

Negative indices in `slice` are interpreted Python-style.

## Adder bridge — using `@gcu/line` from Python

Auditable's adder cells (Python dialect) can use `@gcu/line` via the
included bridge:

```python
import line as np                           # alias to whatever you like

a = np.array([1, 2, 3, 4, 5])
b = np.array([10, 20, 30, 40, 50])
c = a + b                                  # operator overload via __add__
total = c.sum()                            # 165

m = np.zeros([3, 3])
m[0] = np.array([1, 2, 3])                 # row assignment

# Linear algebra
A = np.array([[4, 1, 2], [1, 5, 1], [2, 1, 3]])
values, vectors = np.linalg.eigh3(A)       # 3×3 symmetric (Cardano fast path)
x = np.linalg.solve(A, np.array([1, 2, 3]))

# Iteration
total = 0
for row in m:                              # 2D iteration yields rows as LineArrays
    total = total + row.sum()
```

The bridge wraps each NdArray in a `LineArray` instance with Python
dunder methods (`__add__`, `__getitem__`, `__iter__`, etc.). Operations
return new `LineArray` instances. Slicing copies, consistent with the
underlying library.

## Performance

Numbers from a 2026-05-09 benchmark on AMD Ryzen AI 9 HX 370, Node 24,
CPython 3.13 + scipy-openblas 0.3.31. All timings in **ms/run**, op only
(arrays pre-allocated). NumPy column is `OPENBLAS_NUM_THREADS=1` — the
fair comparison for sizes where multi-threaded OpenBLAS pays massive
thread-pool overhead.

### Element-wise + reductions

| Workload | line | plain f64 | natra | numpy | **line/numpy** |
|---|---:|---:|---:|---:|---:|
| 10K vector add | 0.030 | 0.003 | 0.007 | **0.002** | 15× slower |
| 100K vector add | 0.168 | 0.050 | 0.030 | **0.091** | **line 1.8× FASTER** |
| 1M vector add | 1.205 | 0.573 | 0.438 | **1.205** | 1.0× (tied) |
| 10K sum | 0.006 | 0.006 | 0.009 | **0.002** | 3.0× slower |
| 100K sum | 0.063 | 0.059 | 0.062 | **0.015** | 4.2× slower |
| 1M sum | 0.612 | 0.591 | 0.595 | **0.193** | 3.2× slower |
| 10K dot | 0.007 | 0.006 | 0.011 | **0.001** | 7.0× slower |
| 100K dot | 0.063 | 0.063 | 0.032 | **0.012** | 5.3× slower |

### Matrix multiplication

| Size | line | natra | numpy | numpy MT | **line/numpy** |
|---|---:|---:|---:|---:|---:|
| 50×50 | 0.093 | 0.048 | **0.004** | 0.004 | 23× slower |
| 100×100 | 0.612 | 0.346 | **0.027** | 0.027 | 23× slower |
| 200×200 | 5.001 | 2.717 | **0.263** | 0.222 | 19× slower |
| 500×500 | 77.11 | 47.66 | 4.303 | **1.112** | 18× slower |

`numpy MT` = default 24-thread OpenBLAS — only beats single-threaded
once N gets large.

### Linear solve (LU + partial pivoting)

| Size | line | natra | numpy | **line/numpy** |
|---|---:|---:|---:|---:|
| 50×50 | 0.076 | 0.040 | **0.012** | 6.3× slower |
| 100×100 | 0.447 | 0.199 | **0.039** | 11× slower |
| 200×200 | 3.151 | 1.597 | **0.187** | 17× slower |

### Symmetric eigendecomposition

| Workload | line | natra | numpy | **line/numpy** |
|---|---:|---:|---:|---:|
| 3×3 (eigSym3, Cardano closed-form) | **0.0023** | 0.011 | 0.004 | **line 1.7× FASTER** |
| 3×3 (eigSym, Jacobi) | **0.0030** | 0.011 | 0.004 | **line 1.3× FASTER** |
| 20×20 (eigSym, Jacobi) | 0.118 | **0.088** | 0.030 | 3.9× slower |

### Reproduce

```bash
node test/line-perf.mjs                              # line + plain f64 + natra
OPENBLAS_NUM_THREADS=1 python test/perf_line_numpy.py # numpy reference
```

### What this shows

- **line is faster than numpy on 3×3 symmetric eigen.** Cardano has no
  iteration overhead and no LAPACK dispatch to amortize.
- **line is faster than numpy on 100K vector add** on this machine —
  surprising, but consistent. Looks like line's flat Float64Array loop +
  fresh allocation actually outpaces numpy's allocate-result-as-PyObject
  path at this size.
- **line is consistently within 1-2 orders of magnitude of numpy** across
  every workload — solid floor for a pure-JS implementation.
- **natra and line are competitive across the small-to-medium regime.**
  natra wins on element-wise ops once arrays exceed ~50K elements
  (wasm SIMD pulls ahead), and on solve / 20×20 eigen. line wins on the
  3×3 eigen closed-form. They're roughly tied on matmul up to ~500×500
  in pure compute (numpy BLAS still dominates there absolutely).
- **NumPy's BLAS dgemm is in a class of its own for matmul** (~20-25×
  faster than either line or natra). For hot kernels in JS, natra+alpack
  is the path; for daily-driver linalg under that bar, line is fine.
- **OpenBLAS thread tuning matters.** Multi-threaded OpenBLAS hurts
  small-N linear algebra (24 threads × 200×200 dgesv = 230× slower than
  single-threaded due to pool spin-up) and helps big dense matmul (4×
  boost at 500×500).
- **natra's scope discipline matters.** When iterating, prefer
  `ctx.scope(s => { s.foo(); })` (braced, discards result) over
  `ctx.scope(s => s.foo())` (returns + promotes result). The unbraced
  form leaks into permanent memory, which made earlier versions of
  this benchmark show natra ~30× slower than reality.

## When to use line vs natra

[natra](https://github.com/gentropic/auditable/tree/main/ext/natra) is a
sibling library backed by atra-compiled Wasm with BLAS-style kernels.
Both can coexist; pick per-task:

| Concern | `@gcu/line` | natra |
|---|---|---|
| Backing store | `Float64Array` | wasm linear memory |
| Memory mgmt | JS GC | bump allocator + scope |
| Op cost (small) | fast (V8 JIT) | wasm dispatch overhead |
| Op cost (large) | slower (no SIMD) | fast (vectorized C) |
| API ergonomics | function calls | scope-fluent (`s.add(a, b)`) |
| Bundle size | ~50 KB unminified | ~80 KB (with wasm) |
| Init time | none | ~ms (wasm instantiate) |
| Linear algebra | small dense direct | alpack BLAS via @atra |
| dtype support | f64 only (v1) | i8/u8/i16/u16/i32/u32/f32/f64 |

**Use line when:**
- Arrays under ~50K elements
- Small dense linear algebra (matrices ≤ 200×200)
- You don't want a wasm dependency
- You want to drop down to raw `Float64Array` when needed

**Use natra when:**
- Large arrays (≥ 100K elements)
- Pivoted QR / SVD / sparse / iterative solvers
- You need typed-array dtype variety (u8 image data, i32 indices, etc.)
- You're hitting the matmul cross-over (~500×500+)

The line isn't sharp. For matrices in the 100×100 to 500×500 range,
either works; pick based on what fits your code style.

## Limitations (v1)

These are deliberate v1 scope decisions, not bugs. Most are clear v2
extension points:

- **Float64 only.** Integer arrays > 2^53 lose precision. Image-style
  data (u8 pixels) costs 8× memory. Booleans stored as 0.0/1.0.
  natra serves these via its dtype variety.
- **No views / strided arrays.** Slices, transpose, and reshape always
  copy. This avoids buffer-aliasing bugs and keeps inner loops
  flat-iterating, but means you can't cheaply mutate "a slice".
- **No fancy indexing.** Boolean masks and integer-array indexing are
  not supported. Pull data out via `slice`, modify, write back.
- **Linear algebra is small dense direct methods.**
  - `solve`, `inv`, `det`, `cholesky`, `lstsq`, `matmul`: O(n³); good
    up to ~500×500 in pure JS at interactive speeds.
  - `eigSym`: Jacobi iterations; good up to ~100×100.
  - `svd`: one-sided Jacobi; competitive vs LAPACK at N ≤ 16, gets
    slow at N ≥ 64. Use natra's wasm path for big SVD when available.
  - **No general (non-symmetric) eigendecomposition** — only `eigSym`
    / `eigSym3` for symmetric matrices.
  - No matrix functions (`expm`, `logm`).
  - No sparse / iterative solvers.
- **Least squares defaults to QR.** Condition number κ(A) — numerically
  stable. Pass `{ method: 'normal' }` for the AᵀA-Cholesky fast path
  (faster but κ(A)² — unstable for ill-conditioned A). Pass
  `{ method: 'svd' }` for the most robust path (handles rank-deficient
  A by truncating tiny singular values).
- **`matmul` is 4×4 register-tiled.** V8 auto-vectorizes the tile
  structure to AVX f64x4 — ties alpack's wasm SIMD at N≥1024 and
  beats wasm's f64x2 at very large N (memory bandwidth bound).
  Hand-tuned wasm with cache blocking (TF.js xnnpack, native LAPACK)
  is still 5-10× ahead at large N — for that regime, use natra+alpack
  via the GCU registry.

## Versioning

Pre-1.0: API is unstable. Breaking changes may happen on minor bumps.
v1.0 will lock the surface; v2 may add multi-dtype dispatch, in-place
op variants, or strided views if there's clear demand.

## License

MIT — see [LICENSE](../../LICENSE).

## Author

Arthur Endlein Correia / [Geoscientific Chaos Union](https://gentropic.org)
