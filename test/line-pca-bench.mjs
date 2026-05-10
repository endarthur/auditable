// PCA bench: how fast is "PCA of P variables, N samples" in line?
//
// Two equivalent ways to compute the principal components:
//   A. Direct SVD: X = U Σ Vᵀ → V columns are principal directions.
//      Cost: SVD of N×P matrix.
//   B. Covariance + eigSym: C = X̃ᵀX̃/(N-1), eigSym(C) → principal dirs.
//      Cost: O(N P²) for cov + O(P³ × sweeps) for eigSym.
//
// When N >> P (the typical PCA case — many samples, few variables),
// (B) is dramatically cheaper.

import { execSync } from 'node:child_process';
import { from, zeros, sum, matmul, transpose, eigSym, svd } from '../ext/line/index.js';

function bench(fn, innerRepeats = 3, outerSamples = 10) {
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

function makeData(N, P, seed) {
  // Generate N×P data matrix with mild correlation structure
  let s = seed | 0 || 1;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const X = new Float64Array(N * P);
  for (let i = 0; i < N * P; i++) X[i] = rng() * 2 - 1;
  // Add correlation: each column = base + noise
  const base = new Float64Array(N);
  for (let i = 0; i < N; i++) base[i] = rng() * 2 - 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < P; j++) {
      X[i * P + j] += base[i] * (0.5 + 0.1 * (j % 5));
    }
  }
  return X;
}

// Method A: SVD of centered X
function pcaSVD(Xflat, N, P) {
  // Center: subtract column means
  const means = new Float64Array(P);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < P; j++) means[j] += Xflat[i * P + j];
  }
  for (let j = 0; j < P; j++) means[j] /= N;
  const Xc = new Float64Array(N * P);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < P; j++) Xc[i * P + j] = Xflat[i * P + j] - means[j];
  }
  const Xnd = from(Xc, [N, P]);
  // SVD: X = U Σ Vᵀ, principal directions are columns of V (P × k)
  const { U, s, V } = svd(Xnd);
  // Scores = U Σ (N × k)
  // Singular values directly relate to variance: var_i = σ_i² / (N-1)
  return { V, eigvals: s };  // V is P×k = principal directions
}

// Method B: covariance + eigSym
function pcaCov(Xflat, N, P) {
  // Center
  const means = new Float64Array(P);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < P; j++) means[j] += Xflat[i * P + j];
  }
  for (let j = 0; j < P; j++) means[j] /= N;
  const Xc = new Float64Array(N * P);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < P; j++) Xc[i * P + j] = Xflat[i * P + j] - means[j];
  }
  const Xnd = from(Xc, [N, P]);
  // Covariance C = XᵀX / (N-1) — P×P
  const Cov = matmul(transpose(Xnd), Xnd);
  for (let i = 0; i < P * P; i++) Cov.data[i] /= (N - 1);
  // Eigendecomp of symmetric covariance matrix
  const { values, vectors } = eigSym(Cov);
  return { vectors, eigvals: values };
}

function runNumpyPCA(cases) {
  try {
    const args = cases.map(([N, P]) => `${N}x${P}`).join(',');
    const out = execSync(`python test/perf_numpy_compare.py pca ${args}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    console.log('  numpy unavailable:', e.message.slice(0, 100));
    return null;
  }
}

const cases = [
  [100, 10],
  [1000, 10],
  [1000, 50],
  [1000, 100],
  [10000, 100],
];

console.log('Running numpy reference (single-thread OpenBLAS)…');
const np = runNumpyPCA(cases);
if (np) console.log('  numpy ready\n');

console.log('## PCA — ms per call, median\n');
console.log('| N × P       | line SVD   | line cov+eig | numpy SVD | numpy cov | best/numpy |');
console.log('|-------------|------------|--------------|-----------|-----------|------------|');

let sink = 0;
for (const [N, P] of cases) {
  const X = makeData(N, P, N + P);
  const lineSvdInner = N * P <= 10000 ? 5 : 1;
  const lineCovInner = N * P * P <= 1e7 ? 5 : 1;
  const tSvd = bench(() => {
    const r = pcaSVD(X, N, P);
    sink += r.eigvals.data[0];
  }, lineSvdInner);
  const tCov = bench(() => {
    const r = pcaCov(X, N, P);
    sink += r.eigvals.data[0];
  }, lineCovInner);

  const npSvd = np ? np[`${N}x${P}_svd`] : null;
  const npCov = np ? np[`${N}x${P}_cov`] : null;
  const lineBest = Math.min(tSvd, tCov);
  const npBest = np ? Math.min(npSvd, npCov) : null;
  const ratio = npBest ? (lineBest / npBest).toFixed(2) : '   ';

  const f = (v) => v === null ? '   n/a   ' : v.toFixed(2).padStart(9);
  console.log(`| ${String(N).padStart(5)} × ${String(P).padStart(3)} | ${f(tSvd)} | ${f(tCov)}    | ${f(npSvd)} | ${f(npCov)} | ${ratio}×      |`);
}

console.log('\nsink:', sink.toFixed(2));
