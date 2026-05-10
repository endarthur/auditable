// QR decomposition via Householder reflections.
//
// For an m×n matrix A, computes Q (orthogonal) and R (upper triangular)
// such that A = QR. Two modes:
//   'thin'    (default) — Q: m×k, R: k×n where k = min(m,n)
//   'full'    — Q: m×m, R: m×n
//
// Used by:
//   - lstsq (alternative to normal-equations for ill-conditioned A^T A)
//   - downstream stats fits where conditioning matters

import { NdArray } from './ndarray.js';

export function qr(A, opts = {}) {
  if (A.ndim !== 2) throw new RangeError(`qr requires 2D array, got ${A.ndim}D`);
  const m = A.shape[0], n = A.shape[1];
  const mode = opts.mode || 'thin';
  const k = Math.min(m, n);

  // Work in a mutable copy of A — becomes R at the end (upper part).
  const R = new Float64Array(A.data);
  // Q starts as identity. Accumulates Householder reflectors.
  const Q = new Float64Array(m * m);
  for (let i = 0; i < m; i++) Q[i * m + i] = 1;

  // Reusable Householder vector buffer.
  const v = new Float64Array(m);

  for (let j = 0; j < k; j++) {
    // Compute Householder vector that zeros R[j+1:, j].
    // First, norm of R[j:, j].
    let normSq = 0;
    for (let i = j; i < m; i++) {
      const x = R[i * n + j];
      normSq += x * x;
    }
    if (normSq === 0) continue;  // already zero column
    const norm = Math.sqrt(normSq);
    // Choose sign(alpha) opposite to R[j,j] to avoid cancellation.
    const r_jj = R[j * n + j];
    const alpha = r_jj >= 0 ? -norm : norm;
    // v = R[j:, j]; v[0] -= alpha
    for (let i = j; i < m; i++) v[i - j] = R[i * n + j];
    v[0] -= alpha;
    let vNormSq = 0;
    for (let i = 0; i < m - j; i++) vNormSq += v[i] * v[i];
    if (vNormSq === 0) continue;
    const invHalfVNorm = 2 / vNormSq;

    // Apply reflector to R: R[j:, j:] = (I - β v vᵀ) R[j:, j:]
    // For each column c ≥ j: scale = β (vᵀ R[j:, c]); R[j:, c] -= scale * v
    for (let c = j; c < n; c++) {
      let dot = 0;
      for (let i = 0; i < m - j; i++) dot += v[i] * R[(j + i) * n + c];
      const scale = invHalfVNorm * dot;
      for (let i = 0; i < m - j; i++) R[(j + i) * n + c] -= scale * v[i];
    }
    // Apply reflector to Q from the right: Q[:, j:] = Q[:, j:] (I - β v vᵀ)
    // For each row r of Q: scale = β (Q[r, j:] · v); Q[r, j+i] -= scale * v[i]
    for (let r = 0; r < m; r++) {
      let dot = 0;
      for (let i = 0; i < m - j; i++) dot += Q[r * m + (j + i)] * v[i];
      const scale = invHalfVNorm * dot;
      for (let i = 0; i < m - j; i++) Q[r * m + (j + i)] -= scale * v[i];
    }
  }

  if (mode === 'full') {
    return { Q: new NdArray(Q, [m, m]), R: new NdArray(R, [m, n]) };
  }
  // Thin: return Q[:, :k] and R[:k, :].
  const Qt = new Float64Array(m * k);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < k; j++) Qt[i * k + j] = Q[i * m + j];
  }
  const Rt = new Float64Array(k * n);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < n; j++) Rt[i * n + j] = R[i * n + j];
  }
  return { Q: new NdArray(Qt, [m, k]), R: new NdArray(Rt, [k, n]) };
}
