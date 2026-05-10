// SVD bench: line (one-sided Jacobi) vs numpy (LAPACK gesdd).
//
// Jacobi SVD is the most accurate algorithm for nearly-rank-deficient
// matrices (Demmel-Veselić 1992) but is generally 2-5× slower than
// Golub-Reinsch bidiagonalization (LAPACK dgesvd / dgesdd) for dense
// well-conditioned matrices. This bench quantifies the gap.

import { execSync } from 'node:child_process';
import * as line from '../ext/line/index.js';

function bench(fn, innerRepeats = 5, outerSamples = 15) {
  fn(); fn();
  const ts = [];
  for (let r = 0; r < outerSamples; r++) {
    const t0 = performance.now();
    for (let k = 0; k < innerRepeats; k++) fn();
    ts.push((performance.now() - t0) / innerRepeats);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

function runNumpy(sizes) {
  try {
    const out = execSync(`python test/perf_numpy_compare.py svd ${sizes.join(',')}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    console.log('  numpy svd unavailable:', e.message.slice(0, 100));
    return null;
  }
}

const sizes = [8, 16, 32, 64, 128, 256];

console.log('Running numpy reference SVD (single-thread OpenBLAS)…');
const np = runNumpy(sizes);
if (np) console.log('  numpy svd ready\n');

console.log('## svd (square N×N) — μs/call, median\n');
console.log('| N    | line (Jacobi) | numpy (gesdd) | line/numpy |');
console.log('|------|---------------|---------------|------------|');

let sink = 0;
for (const N of sizes) {
  const A = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) A[i] = Math.sin(i * 0.123);
  const And = line.from(A, [N, N]);

  const inner = N <= 32 ? 20 : N <= 64 ? 10 : N <= 128 ? 3 : 1;
  const tLine = bench(() => {
    const r = line.svd(And);
    sink += r.s.data[0];
  }, inner) * 1000;
  const tNp = np ? np[`${N}_f64`] : null;
  const ratio = tNp ? (tLine / tNp).toFixed(2) : '   ';
  const f = (v) => v === null ? '     n/a    ' : v.toFixed(2).padStart(12);
  console.log(`| ${String(N).padStart(4)} | ${f(tLine)}  | ${f(tNp)}  | ${ratio}×    |`);
}

console.log('\nsink:', sink.toFixed(2));
