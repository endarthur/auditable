# V8 winking — what we learned tuning numerical JS for TurboFan

A consolidated record of the experiments behind `@gcu/line`'s BLAS-1
reductions and 4×4 register-tiled matmul. "Winking" because the shapes
are small, surprising, and feel like signalling TurboFan rather than
fighting it.

**Audience.** Anyone tuning numerical hot loops in V8 — Node, Chrome,
Deno, Bun. Findings translate to any modern TurboFan; values cited are
from AMD Ryzen AI 9 HX 370 / Node 24 / 2026-05.

**TL;DR.** Hand-tuned `Float64Array` loops with 4 parallel accumulators
(unrolled-4) **beat Wasm SIMD** (alpack, TF.js) at all but the largest
sizes for BLAS-1. A 4×4 register-blocked matmul **ties Wasm SIMD** at
N≥1024 and beats it at N=4096+. The mechanism is: V8 auto-vectorizes
tight typed-array loops to AVX **f64x4**, Wasm SIMD spec ceilings at
**f64x2**. JS gets twice the lane width for free.

## Why this is even worth measuring

The conventional wisdom: "numerical work belongs in Wasm because JS is
slow." That made sense when V8 didn't autovectorize. In 2026 it does —
on AMD Zen 4 / Intel Alder Lake, on simple typed-array loops, on the
shapes below. The FFI cost of crossing into Wasm, plus Wasm's
spec-locked f64x2 ceiling, means JS often wins.

Two separate benches drove this:

- `test/line-v8-winking-bench.mjs` — naive vs unrolled-4 vs unrolled-8
  for sum / norm / dot / matvec across n=8..262144.
- `test/scitra-v8-vs-wasm-vs-tfjs.mjs` — JS vs alpack-wasm vs TF.js-wasm
  for ddot / nrm2 / axpy.

## The hand-tuned shapes

Five patterns survived the bench. All written explicitly in line's
source so V8 sees the structure literally instead of through a
callback or indirection.

### 1. Unrolled-4 reduction with parallel accumulators

```js
let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
const n4 = n - (n & 3);
let i = 0;
for (; i < n4; i += 4) {
  s0 += d[i  ];
  s1 += d[i+1];
  s2 += d[i+2];
  s3 += d[i+3];
}
let acc = (s0 + s1) + (s2 + s3);
for (; i < n; i++) acc += d[i];  // tail
```

Four independent accumulators give the CPU four independent dependency
chains, one per lane. V8's TurboFan recognizes this and emits an AVX
`vaddpd` over an f64x4 register. ~3.5× speedup vs a single accumulator
on n ≥ 512.

Applies to `sum`, `norm` (`s_i += d[i] * d[i]`), `dot` (`s_i += a[i] *
b[i]`), variance, mean. `ext/line/src/reduce.js` uses this verbatim.

### 2. Unrolled-4 matrix-vector

Same pattern, applied per row, with the unroll on the column axis. The
key is that the accumulators are scalars, not array slots — V8 keeps
them in registers.

```js
for (let i = 0; i < m; i++) {
  let s0=0, s1=0, s2=0, s3=0;
  const aRow = i * n;
  let j = 0;
  for (; j < n4; j += 4) {
    s0 += A[aRow + j  ] * x[j  ];
    s1 += A[aRow + j+1] * x[j+1];
    s2 += A[aRow + j+2] * x[j+2];
    s3 += A[aRow + j+3] * x[j+3];
  }
  let s = (s0+s1) + (s2+s3);
  for (; j < n; j++) s += A[aRow + j] * x[j];
  y[i] = s;
}
```

~1.5-2× over the naive form across n=64..4096. The 2-rows-at-a-time
variant (sharing `x[j]` reads) was tested and never won — the inner
loop already saturates the load ports without it.

### 3. 4×4 register-blocked matmul

The headline kernel. Sixteen scalar accumulators per output tile sit in
xmm registers across the entire k-loop:

```js
for (let i = 0; i < M4; i += 4) {
  for (let j = 0; j < N4; j += 4) {
    let c00=0, c01=0, c02=0, c03=0;
    let c10=0, c11=0, c12=0, c13=0;
    let c20=0, c21=0, c22=0, c23=0;
    let c30=0, c31=0, c32=0, c33=0;
    for (let k = 0; k < K; k++) {
      const a0 = ad[(i  )*K + k];
      const a1 = ad[(i+1)*K + k];
      const a2 = ad[(i+2)*K + k];
      const a3 = ad[(i+3)*K + k];
      const bRow = k * N;
      const b0 = bd[bRow + j  ];
      const b1 = bd[bRow + j+1];
      const b2 = bd[bRow + j+2];
      const b3 = bd[bRow + j+3];
      c00 += a0*b0; c01 += a0*b1; c02 += a0*b2; c03 += a0*b3;
      c10 += a1*b0; c11 += a1*b1; c12 += a1*b2; c13 += a1*b3;
      c20 += a2*b0; c21 += a2*b1; c22 += a2*b2; c23 += a2*b3;
      c30 += a3*b0; c31 += a3*b1; c32 += a3*b2; c33 += a3*b3;
    }
    // store the 4×4 tile into C
  }
  // tail columns (N % 4) — 4-row × 1-column scalar fallback
}
// tail rows (M % 4) — i,k,j scalar fallback
```

Performance (`ext/line/src/linalg-mul.js`):

| N    | line.matmul (4×4) | line.matmul (i,k,j) | alpack wasm SIMD | numpy BLAS (1 thread) |
|------|------------------:|--------------------:|-----------------:|----------------------:|
| 64   | 83 μs             | 178 μs (2.1× slower) | ~50 μs           | ~25 μs                |
| 256  | 4.5 ms            | 12.3 ms (2.8×)       | ~2 ms            | ~0.3 ms               |
| 512  | 39.6 ms           | —                    | 42.4 ms          | ~3 ms                 |
| 1024 | 330 ms            | 769 ms (2.3×)        | 335 ms           | ~30 ms                |

At N=512+, **JS ties or beats Wasm**. At smaller N, alpack's
hand-coded f64x2 SIMD with 2×2 microkernel still wins by 1.8-2.5×
(less FFI ratio, fewer load misses). NumPy/OpenBLAS is in a class of
its own — cache-blocked SIMD plus decades of tuning — and remains
~20× ahead absolutely.

The win comes from V8 auto-vectorizing across the j-axis of the tile.
Effectively the JS form runs a **wider SIMD** than Wasm's spec ceiling.

### 4. Three-arm dispatch instead of a callback

Element-wise binary ops (`add`, `sub`, `mul`, `div`, `pow`) are written
out explicitly — no shared `_binary(a, b, (x,y) => x+y)` helper. V8
inlines the callback for monomorphic call sites, but the structure is
fragile: if any caller uses a different callback the site becomes
polymorphic and deoptimizes. Just write the loops out — five copies of
"loop with `op` substituted" cost ~30 lines and lock the optimizations
in place.

### 5. Init types matter

The accumulator-init type is load-bearing:

```js
let s = 0;           // integer init — V8 picks Smi, then transitions on first +=
let s = 0.0;         // float init — V8 picks Double from the start
let s = Math.fround(0);  // f32 init — keeps f32 representation
```

Starting with the wrong representation forces a hidden-class
transition on first assignment, which resets JIT compilation for the
function. For numerical code the rule is: **always start float
accumulators with `0.0`** (or for f32, `Math.fround(0)`).

The AIR emitter (`spec_inbox/shipped/AIR.md`, "Hinted JS emission")
codifies this — generated code uses `0.0` for f64 accumulators and
`Math.fround(0)` for f32.

## The four surprises

### A. `Math.fround` blocks vectorization

Counter-intuitive, but measured: hot loops using `Math.fround` for f32
math are **2-3× slower** than the same loop in f64. The `fround`
intrinsic prevents V8 from auto-vectorizing — each call is treated as
a coercion barrier.

Implication: the theoretical "f32 is 2× wider SIMD than f64" win
**doesn't materialize in JS**. The only way to recover it is
explicit `Float32Array` storage *without* `fround` in the inner
arithmetic — and even then, gains are inconsistent across V8 versions.

For BLAS-1 in scitra/natra, the routing rule is: dispatch to JS f64
first; only reach for Wasm f32 when n is large enough that **memory
bandwidth** (half the bytes) outweighs the FFI cost (~n ≥ 8k).

This drove the AIR f32 emission strategy: it still emits `Math.fround`
because it's the only way to preserve f32 semantics, but we accept
that f32 cells will not be faster than f64 cells in current V8.

### B. TF.js wasm is wildly slow for BLAS-1

5-30× slower than the winners (JS unrolled-4 or alpack). TF.js is
optimized for BLAS-3 / ML workloads (matmul, convolutions); per-call
infrastructure overhead (tensor wrappers, dispatch tables, async
boundaries) kills tiny ops.

**Use TF.js for the matmul reference, not for vector ops.**

### C. alpack-f64 BLAS-1 is net-negative

`alpack.dnrm2` and `alpack.ddot` are slower than well-tuned JS at
*every* size we tested (n=8 to 131k). Wasm SIMD f64x2 + FFI overhead
cannot beat V8 AVX f64x4 with zero FFI. alpack-f64 BLAS-1 routines
exist for completeness, not performance.

**Where alpack wins:** large-n f32 (n ≥ 8k — bandwidth), and BLAS-3
matmul up to N≈512 (the 2×2 SIMD microkernel beats line's 4×4 below
that crossover).

### D. Bandwidth ceiling at large n

At n=131k both JS and Wasm hit ~53 GB/s — DDR4-3200 dual-channel
saturation. Past this point, **the algorithm doesn't matter, only the
bytes moved**. The way to win at large n is to reduce data volume
(f32 vs f64), not to vectorize harder.

This is also why register-tiled matmul ties Wasm at N=1024+: both
become memory-bound rather than compute-bound, and the wider AVX
register set helps amortize the loads.

## Methodology

How a JS-vs-Wasm bench should look:

1. **Pre-allocate everything outside the timed region.** Allocation
   noise dominates the actual op cost at small n.
2. **Two-level timing.** Outer loop: ~30 samples. Inner loop: ~100
   repeats. Take the median of the outer samples to reject GC pauses
   and JIT recompilation outliers.
3. **Two warm-up iterations** before timing — gives TurboFan time to
   tier up.
4. **Read the result.** Use a `sink += result` pattern so the optimizer
   can't eliminate the call as dead code.
5. **Scale sweep.** n = 8, 64, 512, 4096, 32768, 262144. The
   crossovers are the interesting points: small-n is FFI-dominated,
   medium-n is compute-dominated, large-n is bandwidth-dominated.
6. **Run with `--allow-natives-syntax`** in Node for more stable JIT
   behaviour. `node --allow-natives-syntax test/script.mjs`.
7. **Compare like-shaped baselines.** Naive JS, unrolled-4 JS,
   unrolled-8 JS, hand-coded Wasm SIMD. Don't compare unrolled JS
   against scalar Wasm — that's not a fair test.

## Where this shows up in the line source

- `ext/line/src/reduce.js` — `sum`, `norm`, `dot`, `variance` use
  unrolled-4 parallel accumulators (~lines 51-205).
- `ext/line/src/linalg-mul.js` — `matmul` uses the 4×4 register-blocked
  microkernel (~lines 29-106).
- `ext/line/src/ops.js` — element-wise binaries are written out
  explicitly with three-arm dispatch (scalar / shape-equal / broadcast),
  no callback indirection (~lines 8-253).

## Reproducing

```bash
# Hand-tuned shape sweep (sum, norm, dot, matvec; line vs naive vs u4 vs u8)
node test/line-v8-winking-bench.mjs

# JS vs alpack-wasm head-to-head (ddot, nrm2, axpy)
node test/scitra-v8-vs-wasm.mjs

# JS vs alpack vs TF.js (3-way)
node test/scitra-v8-vs-wasm-vs-tfjs.mjs

# Full line vs natra vs numpy comparison
node test/line-perf.mjs
OPENBLAS_NUM_THREADS=1 python test/perf_line_numpy.py
```

## Implications for AIR (and future code generators)

AIR — the compiler in `ext/air/` that lowers JS / Python / Soft AST to
SSA IR and emits hinted JS — should learn from these findings:

1. **Loop bodies that look like a reduction should be lowered to
   unrolled-4 with parallel accumulators**, not naive single-accumulator
   form. Every adder / Soft user benefits without writing special-case
   code. *(Planned, see `project_air_unroll_planned` memory; not yet
   shipped.)*
2. **Don't emit `Math.fround` unless f32 storage is requested.** The
   default should be f64 for any computed value, even ones the user
   declared as `: f32` — until the V8/Wasm crossover shifts, fround is
   a deopt cost not a precision win.
3. **Three-arm element-wise emission.** When AIR sees an elementwise
   loop over a typed array, emit the scalar / shape-equal / broadcast
   arms separately rather than a unified callback. Line's hot ops do
   this manually; AIR should do it as a pass.
4. **Init accumulators with the right literal.** `let s = 0.0` for f64,
   `let s = Math.fround(0)` for f32 (still required for f32 even if
   we're told it might cost). AIR already does this for declared
   types; should extend to inferred types via dataflow.

## What didn't work

Things we tried that lost:

- **Unrolled-8.** Median time matches unrolled-4 across all sizes — V8
  already saturates the issue width at u4. Doubles code size, no win.
- **2-row matvec sharing x reads.** Same logic — already
  load-port-saturated. No measurable speedup.
- **Math.fround on the inner products.** ~2-3× slowdown. See surprise A.
- **TF.js as the BLAS-1 reference.** It's not a BLAS-1 library; using
  it as one led us to wrong conclusions for the first hour of the bench
  session. Use natra/alpack as the wasm reference instead.
- **Callback-driven element-wise via `_binary(a, b, fn)`.** V8 inlines
  it most of the time, but polymorphism creeps in across the codebase
  and a single non-numeric caller can deopt every site. Hand-write the
  five hot ops.

## Open questions

- **Does Firefox SpiderMonkey behave the same?** Initial spot checks
  say yes (both engines have AVX autovec), but not systematically
  benched. The findings should be V8-specific until proven otherwise.
- **What about ARM (Apple Silicon, mobile)?** NEON is 128-bit (f64x2,
  same as Wasm SIMD spec). The JS wide-lane advantage probably narrows
  or disappears. Untested.
- **Will Wasm GC + flexible-vectors fix the lane-width gap?** The Wasm
  flexible-vectors proposal would give Wasm SIMD parity with native
  AVX. Status: experimental; not shipping in V8 yet.

## See also

- `ext/line/README.md` — full line library docs + perf section
- `spec_inbox/shipped/AIR.md` (§ "Hinted JS emission", ~line 700-770)
  — the emitter side: which patterns AIR generates and why
- `spec_inbox/alpack-simd-roadmap.md` — the Wasm side: what alpack's
  current SIMD coverage is and where it can grow
- Memory: `project_v8_blas1_finding`, `project_vec_shipped`,
  `project_air_unroll_planned` — running narrative across sessions
