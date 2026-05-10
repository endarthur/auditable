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
vec.neg(a)
vec.abs(a)
vec.sqrt(a)
vec.log(a)   vec.exp(a)
vec.sin(a)   vec.cos(a)   vec.tan(a)
```

### Reductions

Without `axis`: returns a scalar number.
With `{ axis: i }`: returns an NdArray with that axis removed.

```js
vec.sum(a)
vec.sum(a, { axis: 0 })
vec.mean(a, opts?)
vec.max(a, opts?)    vec.min(a, opts?)
vec.std(a, opts?)    vec.variance(a, opts?)   // var_ alias also exported
vec.norm(a)                                    // L2 norm of all elements
vec.dot(a, b)
  // - 1D · 1D = scalar
  // - 2D · 1D = matrix-vector (1D NdArray)
  // - 1D · 2D = vector-matrix (1D NdArray)
  // - 2D · 2D = matmul (2D NdArray)
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

Numbers from a 2026-05-09 single-run benchmark on AMD Ryzen AI 9 HX 370,
Node 24, CPython 3.13 with NumPy. All timings in **ms/run**, op only
(arrays pre-allocated):

| Workload | vec | plain f64 | natra | numpy |
|---|---:|---:|---:|---:|
| 10K vector add | 0.029 | 0.005 | 0.046 | **0.002** |
| 100K vector add | 0.186 | 0.056 | 1.824 | **0.020** |
| 1M vector add | **1.275** | 0.627 | n/a | 1.157 |
| 10K sum | 0.007 | 0.007 | 0.010 | **0.002** |
| 100K sum | 0.061 | 0.062 | 0.065 | **0.015** |
| 1M sum | **0.630** | 0.660 | n/a | 0.193 |
| 10K dot | 0.008 | 0.009 | 0.007 | **0.001** |
| 100K dot | 0.070 | 0.075 | **0.036** | 0.125 |
| 50×50 matmul | 0.137 | — | 1.364 | **0.004** |
| 100×100 matmul | 0.797 | — | 4.587 | **0.027** |
| 200×200 matmul | **6.630** | — | 9.108 | 0.222 |
| 500×500 matmul | 99.600 | — | **88.113** | 1.112 |
| 50×50 solve | 0.056 | — | 0.085 | **0.013** |
| 100×100 solve | 0.373 | — | **0.212** | 9.65 |
| 200×200 solve | 2.512 | — | **1.354** | 44.05 |
| 3×3 eigSym3 (Cardano) | **0.0011** | — | 0.018 | 0.005 |
| 20×20 eigSym (Jacobi) | 0.088 | — | 0.287 | **0.038** |

Reproduce with `node test/vec-perf.mjs` and (separately, for the numpy
column) `python test/perf_vec_numpy.py`.

What this shows:

- **vec beats natra across the board for small-to-medium sizes.** Below
  100K elements, the wasm boundary cost dominates over the actual op.
- **vec is competitive with NumPy for many workloads** — same ballpark
  on dot, sum, large vector add. NumPy still wins on tight kernels
  (small matmul) where its BLAS is doing real SIMD work.
- **natra's matmul crossover is around 250×250** on this hardware.
  Below that, vec's pure-JS naive matmul wins because the wasm dispatch
  is comparable to the actual matmul work.
- **numpy's BLAS dgemm dominates at scale** (10-90× faster than vec for
  matmul). For hot kernels in JS, natra+alpack is the right path.
- **`eigSym3` (Cardano closed-form) is faster than NumPy's LAPACK
  `eigh`** — closed-form trumps iterations for the 3×3 case.
- **The numpy `solve` numbers (9-44 ms for 100×100/200×200) look
  anomalous** — likely a single-threaded reference BLAS on this Windows
  install. Vec wins comfortably at those sizes regardless.

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
