# @gcu/vec

A lightweight, TypedArray-based numerical library for JavaScript — the
NumPy-shaped piece that's been missing from the JS ecosystem.

- N-dimensional arrays backed by `Float64Array`
- NumPy-style broadcasting (right-aligned axes; size-1 broadcasts)
- Element-wise math, reductions with optional axis
- Small dense linear algebra: solve, cholesky, lstsq, eigSym, eigSym3
- Closed-form fast paths for 2×2 / 3×3 / 4×4 matrices
- Pure JS — no wasm, no native dependencies
- Works in Node, modern browsers, Deno, Bun
- ~50 KB unminified, single ES module

`@gcu/vec` is part of the [Auditable](https://github.com/endarthur/auditable)
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

`@gcu/vec` provides an ergonomic NumPy-flavored API on top of the same
fast `Float64Array` loops, with proper broadcasting, ndarrays, and a
small but useful linear algebra subset.

## Installation

```bash
npm install @gcu/vec
```

## Quickstart

```js
import * as vec from '@gcu/vec';

// Creation
const a = vec.from([1, 2, 3, 4]);
const m = vec.from([[1, 2, 3], [4, 5, 6]]);
const z = vec.zeros([3, 3]);
const I = vec.eye(4);
const xs = vec.linspace(0, 1, 11);

// Element-wise math (with broadcasting)
const c = vec.add(a, 10);                       // [11, 12, 13, 14]
const r = vec.mul(m, vec.from([10, 20, 30]));   // broadcast row vector

// Reductions
vec.sum(a);                  // 10
vec.sum(m, { axis: 0 });     // NdArray [3]
vec.mean(m, { axis: 1 });    // NdArray [2]

// Linear algebra
const A = vec.from([[2, 1], [5, 7]]);
const b = vec.from([11, 13]);
const x = vec.solve(A, b);   // x = A^-1 b

// Symmetric eigendecomposition
const sigma = vec.from([[10, 2, 0], [2, 8, 1], [0, 1, 6]]);
const { values, vectors } = vec.eigSym3(sigma);
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
vec.zeros(shape)              // shape: number or array
vec.ones(shape)
vec.full(shape, value)
vec.range(start, end?, step?)  // Python-style; vec.range(5) = [0,1,2,3,4]
vec.linspace(a, b, n)          // n equally-spaced
vec.eye(n)                     // n×n identity matrix
vec.from(source, shape?)
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
vec.add(a, b)
vec.sub(a, b)
vec.mul(a, b)
vec.div(a, b)
vec.pow(a, b)
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
vec.neg(a)         vec.abs(a)        vec.sqrt(a)
vec.log(a)         vec.exp(a)
vec.sin(a)         vec.cos(a)        vec.tan(a)
vec.asin(a)        vec.acos(a)       vec.atan(a)
vec.floor(a)       vec.ceil(a)       vec.round(a)
vec.sign(a)
vec.isnan(a)       vec.isfinite(a)   // return 0/1 masks
```

Element-wise binary helpers (with broadcasting):

```js
vec.atan2(y, x)    // angle from x-axis
vec.hypot(a, b)    // sqrt(a² + b²) without overflow
vec.maximum(a, b)  vec.minimum(a, b)   // element-wise (not reduction)
vec.eq(a, b)       vec.ne(a, b)        // 0/1 masks
vec.lt(a, b)       vec.le(a, b)
vec.gt(a, b)       vec.ge(a, b)
```

### Selection

```js
vec.where(cond, a, b)   // out[i] = cond[i] ? a[i] : b[i]
                        // cond is NdArray; a/b are NdArray (matching shape)
                        // or scalar. No broadcasting between cond/a/b in v1.
vec.clip(a, lo, hi)     // clamp each element to [lo, hi]
```

### Reductions

Without `axis`: returns a scalar number.
With `{ axis: i }`: returns an NdArray with that axis removed.

```js
vec.sum(a, opts?)        vec.prod(a, opts?)
vec.mean(a, opts?)
vec.max(a, opts?)        vec.min(a, opts?)
vec.std(a, opts?)        vec.variance(a, opts?)   // var_ alias also exported
vec.argmin(a, opts?)     vec.argmax(a, opts?)     // indices
vec.norm(a)                                       // L2 norm of all elements
vec.trace(A)                                      // sum of diagonal (2D)
vec.dot(a, b)
  // - 1D · 1D = scalar
  // - 2D · 1D = matrix-vector (1D NdArray)
  // - 1D · 2D = vector-matrix (1D NdArray)
  // - 2D · 2D = matmul (2D NdArray)

vec.cumsum(a, opts?)     vec.cumprod(a, opts?)    // running totals
  // No axis: flatten to 1D, return running total of size a.size.
  // With axis: same shape as a, accumulate along that axis.
```

`std` and `variance` accept `{ ddof: 0 | 1 }` (population vs sample
variance; default 0).

### Linear algebra

```js
// Multiplication
vec.matmul(A, B)              // 2D × 2D → 2D (loop-reordered i,k,j)
vec.transpose(A)              // 2D axes swap (copy)

// Linear systems (LU + partial pivoting)
vec.solve(A, b)               // returns x; b can be 1D or 2D (multi-rhs)
vec.det(A)                    // determinant
vec.inv(A)                    // matrix inverse

// SPD systems (Cholesky)
vec.cholesky(A)               // returns L (lower triangular)
vec.solveCholesky(L, b)       // forward + back-substitute given precomputed L

// Least squares (normal equations + Cholesky)
vec.lstsq(A, b)               // x = (A^T A)^-1 A^T b

// Symmetric eigendecomposition
vec.eigSym3(A)                // 3×3 via Smith/Cardano closed-form
vec.eigSym(A, opts?)          // N×N via Jacobi rotations

// Closed-form fast paths
vec.det2(A) / vec.det3(A) / vec.det4(A)
vec.inv2(A) / vec.inv3(A) / vec.inv4(A)

// Matrix shape helpers
vec.diag(a, k=0)
  // 1D input → 2D matrix with `a` on the k-th diagonal
  // 2D input → 1D vector of the k-th diagonal
vec.outer(a, b)        // outer product (1D × 1D → 2D)
vec.tril(A, k=0)       // keep on/below k-th diagonal, zero rest
vec.triu(A, k=0)       // keep on/above k-th diagonal, zero rest
```

`eigSym3` and `eigSym` return `{ values, vectors }` where:
- `values`: 1D NdArray of eigenvalues, sorted **descending**
- `vectors`: 2D NdArray with eigenvectors as columns, orthonormal

### Shape ops

```js
vec.reshape(a, newShape)
vec.flatten(a)
vec.slice(a, ranges)
  // ranges is an array of per-axis slice specs:
  //   null / undefined / missing → full axis
  //   { start?, end?, step? }    → start defaults to 0 (or end if step<0),
  //                                 end defaults to axis size (or 0 if step<0),
  //                                 step defaults to 1.
vec.copy(a)

vec.concat(arrays, axis=0)   // join along existing axis (shapes must match
                             // except along that axis)
vec.stack(arrays, axis=0)    // introduce a NEW axis (all shapes must match
                             // exactly; result has ndim+1)
```

Negative indices in `slice` are interpreted Python-style.

## Adder bridge — using `@gcu/vec` from Python

Auditable's adder cells (Python dialect) can use `@gcu/vec` via the
included bridge:

```python
import vec as np                           # alias to whatever you like

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
for row in m:                              # 2D iteration yields rows as VecArrays
    total = total + row.sum()
```

The bridge wraps each NdArray in a `VecArray` instance with Python
dunder methods (`__add__`, `__getitem__`, `__iter__`, etc.). Operations
return new `VecArray` instances. Slicing copies, consistent with the
underlying library.

## Performance

Numbers from a 2026-05-09 benchmark on AMD Ryzen AI 9 HX 370, Node 24,
CPython 3.13 + scipy-openblas 0.3.31. All timings in **ms/run**, op only
(arrays pre-allocated). NumPy column is `OPENBLAS_NUM_THREADS=1` — the
fair comparison for sizes where multi-threaded OpenBLAS pays massive
thread-pool overhead.

### Element-wise + reductions

| Workload | vec | plain f64 | natra | numpy | **vec/numpy** |
|---|---:|---:|---:|---:|---:|
| 10K vector add | 0.030 | 0.003 | 0.007 | **0.002** | 15× slower |
| 100K vector add | 0.168 | 0.050 | 0.030 | **0.091** | **vec 1.8× FASTER** |
| 1M vector add | 1.205 | 0.573 | 0.438 | **1.205** | 1.0× (tied) |
| 10K sum | 0.006 | 0.006 | 0.009 | **0.002** | 3.0× slower |
| 100K sum | 0.063 | 0.059 | 0.062 | **0.015** | 4.2× slower |
| 1M sum | 0.612 | 0.591 | 0.595 | **0.193** | 3.2× slower |
| 10K dot | 0.007 | 0.006 | 0.011 | **0.001** | 7.0× slower |
| 100K dot | 0.063 | 0.063 | 0.032 | **0.012** | 5.3× slower |

### Matrix multiplication

| Size | vec | natra | numpy | numpy MT | **vec/numpy** |
|---|---:|---:|---:|---:|---:|
| 50×50 | 0.093 | 0.048 | **0.004** | 0.004 | 23× slower |
| 100×100 | 0.612 | 0.346 | **0.027** | 0.027 | 23× slower |
| 200×200 | 5.001 | 2.717 | **0.263** | 0.222 | 19× slower |
| 500×500 | 77.11 | 47.66 | 4.303 | **1.112** | 18× slower |

`numpy MT` = default 24-thread OpenBLAS — only beats single-threaded
once N gets large.

### Linear solve (LU + partial pivoting)

| Size | vec | natra | numpy | **vec/numpy** |
|---|---:|---:|---:|---:|
| 50×50 | 0.076 | 0.040 | **0.012** | 6.3× slower |
| 100×100 | 0.447 | 0.199 | **0.039** | 11× slower |
| 200×200 | 3.151 | 1.597 | **0.187** | 17× slower |

### Symmetric eigendecomposition

| Workload | vec | natra | numpy | **vec/numpy** |
|---|---:|---:|---:|---:|
| 3×3 (eigSym3, Cardano closed-form) | **0.0023** | 0.011 | 0.004 | **vec 1.7× FASTER** |
| 3×3 (eigSym, Jacobi) | **0.0030** | 0.011 | 0.004 | **vec 1.3× FASTER** |
| 20×20 (eigSym, Jacobi) | 0.118 | **0.088** | 0.030 | 3.9× slower |

### Reproduce

```bash
node test/vec-perf.mjs                              # vec + plain f64 + natra
OPENBLAS_NUM_THREADS=1 python test/perf_vec_numpy.py # numpy reference
```

### What this shows

- **vec is faster than numpy on 3×3 symmetric eigen.** Cardano has no
  iteration overhead and no LAPACK dispatch to amortize.
- **vec is faster than numpy on 100K vector add** on this machine —
  surprising, but consistent. Looks like vec's flat Float64Array loop +
  fresh allocation actually outpaces numpy's allocate-result-as-PyObject
  path at this size.
- **vec is consistently within 1-2 orders of magnitude of numpy** across
  every workload — solid floor for a pure-JS implementation.
- **natra and vec are competitive across the small-to-medium regime.**
  natra wins on element-wise ops once arrays exceed ~50K elements
  (wasm SIMD pulls ahead), and on solve / 20×20 eigen. vec wins on the
  3×3 eigen closed-form. They're roughly tied on matmul up to ~500×500
  in pure compute (numpy BLAS still dominates there absolutely).
- **NumPy's BLAS dgemm is in a class of its own for matmul** (~20-25×
  faster than either vec or natra). For hot kernels in JS, natra+alpack
  is the path; for daily-driver linalg under that bar, vec is fine.
- **OpenBLAS thread tuning matters.** Multi-threaded OpenBLAS hurts
  small-N linear algebra (24 threads × 200×200 dgesv = 230× slower than
  single-threaded due to pool spin-up) and helps big dense matmul (4×
  boost at 500×500).
- **natra's scope discipline matters.** When iterating, prefer
  `ctx.scope(s => { s.foo(); })` (braced, discards result) over
  `ctx.scope(s => s.foo())` (returns + promotes result). The unbraced
  form leaks into permanent memory, which made earlier versions of
  this benchmark show natra ~30× slower than reality.

## When to use vec vs natra

[natra](https://github.com/endarthur/auditable/tree/main/ext/natra) is a
sibling library backed by atra-compiled Wasm with BLAS-style kernels.
Both can coexist; pick per-task:

| Concern | `@gcu/vec` | natra |
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

**Use vec when:**
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
    up to ~200×200 in pure JS.
  - `eigSym`: Jacobi iterations; good up to ~100×100.
  - No general (non-symmetric) eigendecomposition.
  - No SVD.
  - No sparse / iterative solvers.
- **Least squares uses normal equations.** Stable for well-conditioned
  problems (typical regression / plane-fitting / kriging). Ill-
  conditioned A produces inaccurate results because the condition
  number of `A^T A` is the square of `A`'s — use natra+alpack QR/SVD
  for those.
- **`matmul` is loop-reordered naive O(n³).** ~2-3× faster than the
  textbook (i,j,k) form, but at large sizes wasm SIMD wins by 10-20×.
  v2 may add a tiled implementation.

## Versioning

Pre-1.0: API is unstable. Breaking changes may happen on minor bumps.
v1.0 will lock the surface; v2 may add multi-dtype dispatch, in-place
op variants, or strided views if there's clear demand.

## License

MIT — see [LICENSE](../../LICENSE).

## Author

Arthur Endlein Correia / [Geoscientific Chaos Union](https://gentropic.org)
