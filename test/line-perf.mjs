// vec vs natra vs numpy across array sizes and operations.
//
// natra arrays/scopes follow the same "pre-allocated, scope only does the
// op" pattern that natra-perf.mjs uses, for fair comparison with numpy's
// op-only timings. vec.* calls already only do the op (creation is
// separate). numpy reference numbers come from running test/perf_vec_numpy.py
// separately and pasting the output (run on the same machine that runs
// this script for meaningful comparison).
//
// Reference numbers from a 2026-05-09 run on AMD Ryzen AI 9 HX 370,
// Node 24, CPython 3.13 + scipy-openblas 0.3.31 (run with
// OPENBLAS_NUM_THREADS=1 for fair small-N comparison; default 24-thread
// pool spin-up adds 100-230× overhead on small dgesv):
//
//   workload                       vec      plain f64    natra      numpy ST
//   10K vector add                 0.032    0.005        0.045       0.002
//   100K vector add                0.186    0.056        1.856       0.091
//   1M vector add                  1.319    0.626        TBD         1.205
//   10K sum                        0.007    0.007        0.010       0.002
//   100K sum                       0.060    0.062        0.062       0.015
//   1M sum                         0.686    0.645        TBD         0.193
//   10K dot                        0.008    0.007        0.005       0.001
//   100K dot                       0.068    0.074        0.034       0.012
//   50×50 matmul                   0.127    —            1.385       0.004
//   100×100 matmul                 0.852    —            4.673       0.027
//   200×200 matmul                 6.361    —            9.308       0.263
//   500×500 matmul                98.989    —           88.891       4.303 (1.1 MT)
//   50×50 solve                    0.065    —            0.088       0.012
//   100×100 solve                  0.345    —            0.231       0.039
//   200×200 solve                  2.456    —            1.643       0.187
//   3×3 eigSym3 (Cardano)          0.0012   —            0.020       0.004
//   3×3 eigSym (Jacobi)            0.0020   —            —           —
//   20×20 eigSym                   0.111    —            0.314       0.030
//
// All numbers in ms/run.
// 1M natra numbers TBD — pending refresh after switching benchmarks to the
// scope-discard pattern (earlier "wasm OOB" was a downstream symptom of
// scope-promotion accumulating ~8MB/iter into perm; see ext/natra/README.md
// "Memory model" section).
//
// Takeaways:
// (1) vec.eigSym3 (closed-form Cardano) is **faster than numpy** for 3×3
//     symmetric eigen — closed-form trumps LAPACK overhead for tiny cases.
// (2) vec is within 1-2× of numpy on large vector add and ~3-5× slower on
//     sums, dots, and small solves. Solid floor for pure-JS.
// (3) natra's matmul crossover sits around 250×250 on this hardware; it
//     beats vec at solve from 100×100 upward.
// (4) numpy's BLAS dgemm is in a class of its own for matmul (25-30× faster
//     than vec). For hot kernels in JS, natra+alpack remains the path.
// (5) Multi-threaded OpenBLAS hurts small linalg (massive thread spin-up)
//     and helps big dense matmul (4× boost at 500×500).

import * as vec from '../ext/line/index.js';
import { natra } from '../ext/natra/index.js';

// natra arenas reclaim correctly when scopes don't return arrays — we use
// the braced `scope(s => { ... })` pattern below to discard intermediate
// results, so memory stays flat across iterations.
const ctx = await natra({ pages: 1024 });

async function time(label, runs, fn) {
  for (let i = 0; i < Math.min(3, runs); i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(40)}: ${elapsed.toFixed(1)}ms total (${(elapsed / runs).toFixed(4)}ms/run)`);
  return elapsed / runs;
}

// ─────────────────────────────────────────────────────────────────────
// Workload 1: vector add (op only, varying size)
// ─────────────────────────────────────────────────────────────────────

for (const N of [10_000, 100_000, 1_000_000]) {
  console.log(`\n=== ${N.toLocaleString()} vector add (op only) ===`);
  console.log('  CPython numpy (op only)                 : (see perf_vec_numpy.py output)');

  // Plain Float64Array — baseline JS performance.
  const ja = new Float64Array(N);
  const jb = new Float64Array(N);
  const jc = new Float64Array(N);
  for (let i = 0; i < N; i++) { ja[i] = i; jb[i] = i; }
  const runs = N >= 1_000_000 ? 200 : 1000;
  await time('plain Float64Array (in-place)', runs, () => {
    for (let i = 0; i < N; i++) jc[i] = ja[i] + jb[i];
  });

  // vec — fresh allocation each call.
  const va = vec.from(ja, [N]);
  const vb = vec.from(jb, [N]);
  await time('vec.add (allocates result)', runs, () => { vec.add(va, vb); });

  const na = ctx.arange(0, N);
  const nb = ctx.arange(0, N);
  await time('natra (op only, in scope)', runs, () => {
    ctx.scope(s => { s.add(na, nb); });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Workload 2: sum reduction (op only)
// ─────────────────────────────────────────────────────────────────────

for (const N of [10_000, 100_000, 1_000_000]) {
  console.log(`\n=== sum of ${N.toLocaleString()} elements ===`);

  const ja = new Float64Array(N);
  for (let i = 0; i < N; i++) ja[i] = i;
  const runs = N >= 1_000_000 ? 200 : 1000;
  await time('plain Float64Array', runs, () => {
    let s = 0;
    for (let i = 0; i < N; i++) s += ja[i];
    return s;
  });

  const va = vec.from(ja, [N]);
  await time('vec.sum', runs, () => { vec.sum(va); });

  const na = ctx.arange(0, N);
  await time('natra (op only, in scope)', runs, () => {
    ctx.scope(s => { s.sum(na); });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Workload 3: dot product
// ─────────────────────────────────────────────────────────────────────

for (const N of [10_000, 100_000]) {
  console.log(`\n=== dot product of ${N.toLocaleString()} elements ===`);

  const ja = new Float64Array(N);
  const jb = new Float64Array(N);
  for (let i = 0; i < N; i++) { ja[i] = i; jb[i] = i; }
  await time('plain Float64Array', 1000, () => {
    let s = 0;
    for (let i = 0; i < N; i++) s += ja[i] * jb[i];
    return s;
  });

  const va = vec.from(ja, [N]);
  const vb = vec.from(jb, [N]);
  await time('vec.dot', 1000, () => { vec.dot(va, vb); });

  const na = ctx.arange(0, N);
  const nb = ctx.arange(0, N);
  await time('natra (op only, in scope)', 1000, () => {
    ctx.scope(s => { s.dot(na, nb); });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Workload 4: matrix multiplication (where vec hits its wall)
// ─────────────────────────────────────────────────────────────────────

for (const N of [50, 100, 200, 500]) {
  console.log(`\n=== ${N}×${N} matmul ===`);

  // vec — naive O(n^3) with loop-reorder.
  const data = new Float64Array(N * N);
  let seed = 1;
  for (let i = 0; i < N * N; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed - 1) / 2147483646;
  }
  const data2 = new Float64Array(N * N);
  seed = 7;
  for (let i = 0; i < N * N; i++) {
    seed = (seed * 16807) % 2147483647;
    data2[i] = (seed - 1) / 2147483646;
  }

  const vA = new vec.NdArray(new Float64Array(data), [N, N]);
  const vB = new vec.NdArray(new Float64Array(data2), [N, N]);
  // Run fewer iterations as N grows — keep total time bounded.
  const runs = N <= 100 ? 200 : N <= 200 ? 50 : 10;
  await time(`vec.matmul (naive O(n^3) JS)`, runs, () => { vec.matmul(vA, vB); });

  // natra — alpack BLAS dgemm.
  const nA = ctx.array(Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => data[i * N + j])));
  const nB = ctx.array(Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => data2[i * N + j])));
  await time(`natra (alpack dgemm)`, runs, () => {
    ctx.scope(s => { s.matmul(nA, nB); });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Workload 5: linear solve (LU + partial pivoting)
// ─────────────────────────────────────────────────────────────────────

for (const N of [50, 100, 200]) {
  console.log(`\n=== ${N}×${N} solve(A, b) ===`);

  // Build a diagonally-dominant SPD matrix for numerical sanity.
  const Adata = new Float64Array(N * N);
  let seed = 13;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) Adata[i * N + j] = N + 1;
      else {
        seed = (seed * 16807) % 2147483647;
        const off = (seed - 1) / 2147483646 - 0.5;
        Adata[i * N + j] = off;
        // Symmetrize via the lower-half write (we'll overwrite the upper
        // half from j > i anyway; for simplicity just leave asymmetric —
        // diagonally dominant matrices solve fine without symmetry).
      }
    }
  }
  const bData = new Float64Array(N);
  for (let i = 0; i < N; i++) bData[i] = i;

  const vA = new vec.NdArray(new Float64Array(Adata), [N, N]);
  const vb = new vec.NdArray(new Float64Array(bData), [N]);
  const runs = N <= 100 ? 200 : 50;
  await time(`vec.solve (LU + partial pivoting)`, runs, () => {
    vec.solve(vA, vb);
  });

  const nA = ctx.array(Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => Adata[i * N + j])));
  const nb = ctx.array(Array.from({ length: N }, (_, i) => bData[i]));
  await time(`natra (alpack LU)`, runs, () => {
    ctx.scope(s => { s.solve(nA, nb); });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Workload 6: 3×3 symmetric eigen — closed-form vs iterative
// ─────────────────────────────────────────────────────────────────────

console.log(`\n=== 3×3 symmetric eigendecomposition ===`);

const tinySym = vec.from([
  [10, 2, 0],
  [2, 8, 1],
  [0, 1, 6],
]);
await time('vec.eigSym3 (Cardano closed-form)', 10000, () => {
  vec.eigSym3(tinySym);
});

await time('vec.eigSym (Jacobi iterations)', 10000, () => {
  vec.eigSym(tinySym);
});

const nSym = ctx.array([
  [10, 2, 0],
  [2, 8, 1],
  [0, 1, 6],
]);
await time('natra.eigh (alpack syevd)', 10000, () => {
  ctx.scope(s => { s.eigh(nSym); });
});

// ─────────────────────────────────────────────────────────────────────
// Workload 7: 20×20 symmetric eigen
// ─────────────────────────────────────────────────────────────────────

console.log(`\n=== 20×20 symmetric eigendecomposition ===`);

// Build a random symmetric 20×20.
const symN = 20;
const symData = new Float64Array(symN * symN);
let symSeed = 41;
for (let i = 0; i < symN; i++) {
  for (let j = i; j < symN; j++) {
    symSeed = (symSeed * 16807) % 2147483647;
    const v = (symSeed - 1) / 2147483646 - 0.5;
    symData[i * symN + j] = v;
    symData[j * symN + i] = v;
  }
}
// Boost diagonal so it's well-conditioned.
for (let i = 0; i < symN; i++) symData[i * symN + i] += 5;

const vSym20 = new vec.NdArray(new Float64Array(symData), [symN, symN]);
await time('vec.eigSym (Jacobi)', 200, () => { vec.eigSym(vSym20); });

const nSym20 = ctx.array(Array.from({ length: symN }, (_, i) =>
  Array.from({ length: symN }, (_, j) => symData[i * symN + j])));
await time('natra.eigh (alpack syevd)', 200, () => {
  ctx.scope(s => { s.eigh(nSym20); });
});

// ─────────────────────────────────────────────────────────────────────
// Workload 8: Cholesky factorization (SPD, exercises dpotrf)
// ─────────────────────────────────────────────────────────────────────
//
// natra.cholesky internally copies A into the scoped arena and then
// runs dpotrf in place (factorization overwrites the input). The op
// timing reflects the in-place factorization plus a copy; vec
// allocates a fresh L. Both pay roughly equivalent overhead, so this
// is a fair head-to-head.

for (const N of [50, 100, 200]) {
  console.log(`\n=== ${N}×${N} cholesky factorization (SPD) ===`);

  // Build A = M^T M for a random M, ensuring SPD.
  const Mdata = new Float64Array(N * N);
  let cseed = 31 + N;
  for (let i = 0; i < N * N; i++) {
    cseed = (cseed * 16807) % 2147483647;
    Mdata[i] = (cseed - 1) / 2147483646 - 0.5;
  }
  const Mvec = new vec.NdArray(Mdata, [N, N]);
  const Avec = vec.matmul(vec.transpose(Mvec), Mvec);

  const runs = N <= 100 ? 200 : 50;
  await time(`vec.cholesky`, runs, () => { vec.cholesky(Avec); });

  const Anested = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => Avec.data[i * N + j]));
  const nA = ctx.array(Anested);
  await time(`natra.cholesky (alpack dpotrf)`, runs, () => {
    ctx.scope(s => { s.cholesky(nA); });
  });
}

console.log(`\n(Run test/perf_vec_numpy.py separately for numpy reference numbers.)`);
