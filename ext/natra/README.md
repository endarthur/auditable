# @gcu/natra

ndarray operations for JavaScript, backed by [atra](https://www.npmjs.com/package/@gcu/atra)-compiled Wasm kernels. NumPy-compatible element-wise ops, reductions (sum, min, max, prod, nan-variants), broadcasting, strided views. Designed to pair with [adder](https://www.npmjs.com/package/@gcu/adder) for numpy-style Python code; standalone JS API also available.

Part of [Auditable](https://github.com/endarthur/auditable). Architecture notes at [SPEC.md](./SPEC.md).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/natra @gcu/atra
```

## Usage

```js
import { natra } from '@gcu/natra';

const nx = await natra({ pages: 256 });
const a = nx.array([1, 2, 3, 4]);
const b = nx.array([10, 20, 30, 40]);
nx.add(a, b);          // [11, 22, 33, 44]
nx.sum(a);             // 10
nx.reshape(nx.arange(12), [3, 4]);
```

### f32 (single-precision) arrays

Pass `dtype: 'f32'` when creating arrays. f32 routes through alpack's
sgemm/sdot for ~2× speedup on large matmul + dot. f32 element-wise ops
are not yet routed (v0.2.0 partial dispatch); they throw a clear error.

```js
const A = nx.array([[1, 2], [3, 4]], { dtype: 'f32' });
const B = nx.array([[5, 6], [7, 8]], { dtype: 'f32' });
nx.scope(s => s.matmul(A, B));      // routes to alas.sgemm — 2× faster than dgemm
nx.scope(s => s.dot(a32, b32));     // routes to alas.sdot
```

Dtype mismatch throws (no auto-upcast). Convert manually if needed.

### Adder integration (numpy-style)

```js
import '@gcu/natra/adder';   // registers with adder's import hook
// Now in an adder cell: `import numpy as np` — resolves to natra.
```

## Performance

Underpinned by [`@gcu/alpack`](https://www.npmjs.com/package/@gcu/alpack)
— a hand-written wasm BLAS in atra. The Level 3 routines (`dgemm`,
`sgemm`) use 2×2 register-blocked microkernels with f64x2/f32x4 SIMD
and FMA. Level 2/1 routines and ALPACK factorizations (LU, Cholesky)
are similarly SIMD'd.

Benchmarks (AMD Ryzen AI 9 HX 370, single-threaded):

| Workload | natra f64 | TF.js wasm f32 | numpy ST f64 (native) |
|---|---:|---:|---:|
| 200×200 matmul | 0.85 ms | 0.34 ms | 0.26 ms |
| 500×500 matmul | 14 ms | 4.9 ms | 4.3 ms |
| 1000×1000 matmul | 156 ms | 38 ms | — |
| 100×100 solve (LU) | 0.08 ms | — | 0.04 ms |
| 200×200 solve | 0.69 ms | — | 0.19 ms |
| 100×100 cholesky | 0.12 ms | — | — |
| 100K vector add | 0.030 ms | — | 0.091 ms |

Notable:

- **At 100K vector add, natra is faster than NumPy** (the Python-C call
  overhead dominates over actual SIMD work at this size).
- **For solves and Cholesky at N ≤ 200, natra is within 2-3× of native
  numpy LAPACK.** Practical for daily-driver geological / regression
  workloads.
- **At 1000×1000 matmul, natra (f64) hits ~38 GFLOPS** — about 50% of
  f64 SIMD peak. The wasm-vs-native AVX-512 gap caps single-threaded
  f64 wasm at roughly 3× behind native.
- **f32 sgemm matches or beats TF.js wasm f32** at N ≤ 100. Within 1.4×
  at larger sizes — the practical wasm BLAS ceiling.

## Memory model — scope promotion and the discard pattern

natra runs each operation in a bump-allocated arena and reclaims everything
when the arena exits. **Returning an array from `scope()` promotes it** to
permanent memory so it survives past the scope. There is no public free
API (yet) — promoted arrays live for the lifetime of the natra context.

This matters in tight loops. If you call `scope` many times and don't
need the result of each iteration:

```js
// Leaks: each iteration promotes a fresh result to permanent memory.
for (let i = 0; i < 1000; i++) ctx.scope(s => s.add(big, big));

// Discards: braced arrow returns undefined, scope reclaims the result.
for (let i = 0; i < 1000; i++) ctx.scope(s => { s.add(big, big); });
```

For 1 M-element arrays the leak is 8 MB per call; ~125 iterations
exhaust the default 1 GB `maxPages` cap. For benchmark loops, side-effect
work, or anywhere you don't capture the result, prefer the braced form.

When you DO need the result, capture it once and reuse it across the
scope's lifetime, rather than re-allocating on each iteration.

## License

MIT.
