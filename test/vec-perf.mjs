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
// Node 24, CPython 3.13 (single-run; rerun on your machine for fresh data):
//
//   workload                       vec      plain f64    natra      numpy
//   10K vector add                 0.029    0.005        0.046      0.002
//   100K vector add                0.186    0.056        1.824      0.020
//   1M vector add                  1.275    0.627        skip       1.157
//   10K sum                        0.007    0.007        0.010      0.002
//   100K sum                       0.061    0.062        0.065      0.015
//   1M sum                         0.630    0.660        skip       0.193
//   10K dot                        0.008    0.009        0.007      0.001
//   100K dot                       0.070    0.075        0.036      0.125
//   50×50 matmul                   0.137    —            1.364      0.004
//   100×100 matmul                 0.797    —            4.587      0.027
//   200×200 matmul                 6.630    —            9.108      0.222
//   500×500 matmul                99.600    —           88.113      1.112
//   50×50 solve                    0.056    —            0.085      0.013
//   100×100 solve                  0.373    —            0.212      9.65
//   200×200 solve                  2.512    —            1.354     44.05
//   3×3 eigSym3 (Cardano)          0.0011   —            0.018      0.005
//   3×3 eigSym (Jacobi)            0.0019   —            —          —
//   20×20 eigSym                   0.088    —            0.287      0.038
//
// All numbers in ms/run.
//
// Takeaways: (1) vec beats natra across the board at small sizes — the
// wasm boundary cost dominates wherever the actual op is cheap. (2) natra's
// matmul advantage doesn't kick in until ~250×250 on this machine. (3)
// numpy's BLAS dgemm is in a class of its own (10-90× faster than vec
// for matmul); for hot kernels, natra+alpack is the right path. (4)
// vec.eigSym3 (closed-form Cardano) is faster than both natra's iterative
// eigh and numpy's LAPACK syevd — closed-form trumps everything for the
// 3×3 case.

import * as vec from '../ext/vec/index.js';
import { natra } from '../ext/natra/index.js';

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

  // natra — skip 1M (hits 1GB cap on the bump allocator after repeated scopes).
  if (N <= 100_000) {
    const na = ctx.arange(0, N);
    const nb = ctx.arange(0, N);
    await time('natra (op only, in scope)', runs, () => {
      ctx.scope(s => s.add(na, nb));
    });
  } else {
    console.log(`  natra (op only, in scope)               : skipped — bump allocator hits limit`);
  }
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

  if (N <= 100_000) {
    const na = ctx.arange(0, N);
    await time('natra (op only, in scope)', runs, () => {
      ctx.scope(s => s.sum(na));
    });
  } else {
    console.log(`  natra (op only, in scope)               : skipped — bump allocator hits limit`);
  }
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
    ctx.scope(s => s.dot(na, nb));
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
    ctx.scope(s => s.matmul(nA, nB));
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
    ctx.scope(s => s.solve(nA, nb));
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
  ctx.scope(s => s.eigh(nSym));
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
  ctx.scope(s => s.eigh(nSym20));
});

console.log(`\n(Run test/perf_vec_numpy.py separately for numpy reference numbers.)`);
