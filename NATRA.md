# natra — ndarray for the browser

Numeric arrays backed by atra/alas/alpack over shared WebAssembly.Memory. Thin strided ndarray metadata over wasm linear memory, bump allocator with scope/arena for automatic memory management, NumPy-compatible broadcasting.

## Architecture

### ndarray descriptor

```js
{ ptr, dtype, shape, strides, length, ndim, memory }
```

Frozen object. `ptr` is a byte offset into wasm linear memory. Strides are in bytes. Zero-copy transpose/slice/reshape via stride manipulation — no data is moved, only the descriptor changes.

### Memory layout

Bump allocator over `WebAssembly.Memory`:

```
[ permanent heap → ... free ... ← scratch heap ]
  heap_bot                                heap_ptr
```

- **Permanent** allocations (`ctx.array()`, `ctx.zeros()`, etc.) grow upward from `heap_bot`.
- **Scratch** allocations (scope temporaries) grow downward from `heap_ptr`.
- Scope exit promotes returned arrays to permanent and reclaims all scratch.

### Scopes

All computation happens inside `ctx.scope(s => ...)`. The scope object `s` provides fluent chaining (`a.add(b).mul(c)`) and automatic memory management. Arrays created during a scope are scratch-allocated; only the returned value is promoted to permanent storage.

```js
const result = ctx.scope(s => {
  const a = s.add(x, y);
  const b = s.mul(a, z);
  return b; // promoted to permanent
  // a is reclaimed
});
```

Permanent arrays accessed inside a scope are read-only for operations — calling `.add()` etc. on a permanent array outside a scope throws.

### Safety

**Bounds checking:** `get()` and `set()` validate indices against shape. Supports negative indices (Python-style: `get(a, -1)` reads the last element). Throws `RangeError` for out-of-bounds access.

**Dead-array detection:** Arrays that were not returned from their scope are marked dead via a `WeakSet`. Any subsequent access (`get`, `set`, `toArray`, `toTypedArray`, `copy`) throws with a descriptive error. This catches use-after-free bugs that would otherwise silently read stale or overwritten memory.

**Memory limits:** `natra({ maxPages: N })` caps WebAssembly memory growth. Default is 16384 pages (1 GB). Throws on allocation that would exceed the limit.

## Kernel tiers

### Tier 1: contiguous Wasm (SIMD f64x2)

For arrays with the same shape and contiguous (C-order) memory layout, elementwise operations dispatch to atra-compiled Wasm kernels that use `f64x2` SIMD instructions. This is the fast path for most freshly-allocated arrays.

### Tier 2: strided Wasm (1D/2D/3D)

For non-contiguous arrays (transposes, slices, broadcasts) up to 3 dimensions, dedicated strided Wasm kernels accept per-operand element strides and compute offsets manually. 33 kernels cover:

- Binary elementwise: add, sub, mul, div (3 ranks each = 12)
- Unary: neg (3 ranks = 3)
- Scalar ops: adds, muls (3 ranks each = 6)
- Reductions: sum, min, max, prod (3 ranks each = 12)

Kernels are generated programmatically (template atra source) to avoid duplication.

**Limitations:**
- **4D+ arrays** fall back to the JS strided path. Only 1D/2D/3D have Wasm strided kernels. This is a performance concern, not a correctness one — all operations produce correct results regardless of rank.
- **NaN-safe reductions** (`nansum`, `nanmean`, `nanmin`, `nanmax`, `nanprod`) always use the JS strided fallback for non-contiguous arrays. The strided Wasm kernels only cover the non-NaN variants. Contiguous NaN-safe reductions do use Wasm.

### Tier 3: linear algebra

Dispatches to atra-compiled BLAS/LAPACK routines:

- `matmul` → alas.dgemm
- `solve` → alpack.dgetrf + alpack.dgetrs
- `cholesky` → alpack.dpotrf
- `inv` → alpack.dgetrf + alpack.dgetrs (solve against identity)
- `eigh` → alpack.dsyev3v (analytical 3x3) or alpack.dsyevv (general Jacobi)
- `eig` → alpack.dsyev3 (3x3 eigenvalues only) or alpack.dsyev (general eigenvalues only)

### JS fallback

Any operation that doesn't match a Wasm kernel falls through to a generic JS implementation using stride-walking loops. Correct for all ranks and layouts, but slower.

## API

### Factory

```js
const ctx = await natra({ pages: 256, maxPages: 16384, memory: existingMemory });
```

### Array creation

```js
ctx.array([1, 2, 3])              // 1D from flat array
ctx.array([[1, 2], [3, 4]])       // 2D from nested array
ctx.zeros([3, 4])                 // 3x4 zeros
ctx.ones([2, 2])                  // 2x2 ones
ctx.eye(3)                        // 3x3 identity
ctx.linspace(0, 1, 100)           // 100 points from 0 to 1
ctx.arange(0, 10, 0.5)            // [0, 0.5, 1, ..., 9.5]
ctx.full([2, 3], 7)               // 2x3 filled with 7
```

### Views (zero-copy)

```js
a.T                               // transpose
a.slice([1, 3], [0, 2])           // subarray view
a.reshape([2, 6])                 // reshape (contiguous only)
```

### Elementwise operations (inside scope)

```js
ctx.scope(s => {
  s.add(a, b)    s.sub(a, b)    s.mul(a, b)    s.div(a, b)
  s.pow(a, b)    s.neg(a)       s.abs(a)       s.sqrt(a)
  s.exp(a)       s.log(a)       s.sin(a)       s.cos(a)
  // fluent: a.add(b).mul(c).neg()
});
```

### Reductions

```js
ctx.scope(s => {
  s.sum(a)                  // full reduction → scalar
  s.sum(a, 0)               // reduce axis 0
  s.sum(a, [0, 1])          // reduce multiple axes
  s.mean(a)    s.min(a)    s.max(a)    s.prod(a)
  s.nansum(a)  s.nanmean(a) s.nanmin(a) s.nanmax(a)
});
```

**Multi-axis reductions** reduce sequentially (highest axis first to preserve dimension indices). For `mean` and `nanmean`, the multi-axis path uses sum-then-divide with the total reduced element count, since sequential `mean(mean(a, 1), 0)` would give incorrect results when axis sizes differ.

### Linear algebra

```js
ctx.scope(s => {
  s.matmul(a, b)            // matrix multiply
  s.solve(A, b)             // solve Ax = b
  s.cholesky(A)             // lower Cholesky factor
  s.inv(A)                  // matrix inverse
  const [w, V] = s.eigh(A)  // eigenvalues + eigenvectors
  const w2 = s.eig(A)       // eigenvalues only
  s.det(A)                  // determinant
  s.trace(A)                // trace
});
```

### Comparison and indexing

```js
ctx.scope(s => {
  s.eq(a, b)    s.lt(a, b)    s.gt(a, b)    s.le(a, b)    s.ge(a, b)
  s.where(mask, a, b)         // conditional select
  s.take(a, indices, axis)    // fancy indexing
  s.compress(mask, a, axis)   // boolean indexing
  s.argsort(a)                // indirect sort
  s.searchsorted(a, v)        // binary search
});
```

### Data access

```js
ctx.get(a, i, j)              // read element (bounds-checked)
ctx.set(a, i, j, value)       // write element (bounds-checked)
a.toArray()                   // nested JS array
a.toTypedArray()              // Float64Array (copy)
```

### RNG

```js
ctx.seed(42);                   // seed xoshiro256**
ctx.scope(s => {
  s.rand([3, 3])                // uniform [0, 1)
  s.randn([3, 3])              // standard normal (Box-Muller)
});
```

## Dependencies

- **atra** — compiler (compiles kernel source to Wasm at runtime)
- **alas** — BLAS routines (dgemm) as atra source
- **alpack** — LAPACK routines (dgetrf, dgetrs, dpotrf, dsyev, dsyev3, dsyev3v, dsyevv) as atra source

All three are compiled together into a single Wasm module at `natra()` init time.
