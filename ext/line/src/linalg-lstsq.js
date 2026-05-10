// Least squares — solves x = argmin_x ||Ax - b||_2 for overdetermined
// systems (m ≥ n).
//
// Three methods, selected via opts.method:
//
//   'qr'     (default) — A = Q R, solve R x = Qᵀ b via back substitution.
//                        Condition number κ(A). Numerically stable.
//   'normal'           — Solve AᵀA x = Aᵀb via Cholesky. Faster (~2× for
//                        well-conditioned problems) but condition number
//                        is κ(A)² — unstable for ill-conditioned A.
//   'svd'              — A = U Σ Vᵀ, x = V (Σ⁻¹ Uᵀ b). Most robust;
//                        handles rank-deficient A (uses pinv with rcond).
//                        Slower than QR by ~2×.
//
// Returns x (1D NdArray of length n). Cost summary (m×n, m ≥ n):
//   normal: O(m n² + n³) — Cholesky + matmul AᵀA
//   qr:     O(m n²)       — Householder QR + triangular solve
//   svd:    O(m n² + n³ · sweeps) — Jacobi SVD

import { NdArray } from './ndarray.js';
import { matmul, transpose } from './linalg-mul.js';
import { cholesky, solveCholesky } from './linalg-solve.js';
import { qr } from './linalg-qr.js';
import { svd } from './linalg-svd.js';
import { solve_triangular } from './linalg-norms.js';

export function lstsq(A, b, opts = {}) {
  if (A.ndim !== 2) {
    throw new RangeError(`lstsq: A must be 2D, got ${A.ndim}D`);
  }
  if (b.ndim !== 1) {
    throw new RangeError(`lstsq: b must be 1D in v1, got ${b.ndim}D`);
  }
  const m = A.shape[0], n = A.shape[1];
  if (b.size !== m) {
    throw new RangeError(`lstsq: b length ${b.size} does not match A row count ${m}`);
  }
  if (m < n) {
    throw new RangeError(`lstsq: underdetermined (m=${m} < n=${n}); v1 only handles m >= n`);
  }
  const method = opts.method ?? 'qr';

  if (method === 'normal') {
    return _lstsqNormal(A, b, m, n);
  }
  if (method === 'qr') {
    return _lstsqQR(A, b, m, n);
  }
  if (method === 'svd') {
    return _lstsqSVD(A, b, m, n, opts);
  }
  throw new RangeError(`lstsq: unknown method "${method}" (expected 'qr', 'normal', or 'svd')`);
}

// Normal equations: A^T A x = A^T b → Cholesky factor and back-solve.
// Condition number κ(A)² — unstable for ill-conditioned A but fastest path.
function _lstsqNormal(A, b, m, n) {
  const At = transpose(A);
  const AtA = matmul(At, A);
  const Atb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += At.data[i * m + j] * b.data[j];
    Atb[i] = s;
  }
  const L = cholesky(AtA);
  return solveCholesky(L, new NdArray(Atb, [n]));
}

// QR-based: A = Q R (thin, m×n × n×n). Solve R x = Qᵀ b.
// Condition number κ(A) — much more stable than normal equations.
function _lstsqQR(A, b, m, n) {
  const { Q, R } = qr(A);  // thin: Q is m×n, R is n×n upper triangular
  // Qᵀ b — manual mat-vec
  const Qtb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += Q.data[j * n + i] * b.data[j];
    Qtb[i] = s;
  }
  return solve_triangular(R, new NdArray(Qtb, [n]), { lower: false });
}

// SVD-based: A = U Σ Vᵀ, x = V Σ⁻¹ Uᵀ b. Skips singular values below
// rcond × σ_max so rank-deficient A still yields the minimum-norm
// least-squares solution.
function _lstsqSVD(A, b, m, n, opts) {
  const { U, s, V } = svd(A);
  const rcond = opts.rcond ?? Math.max(m, n) * Number.EPSILON;
  const sMax = s.data[0];
  const cutoff = rcond * sMax;
  // Uᵀ b
  const Utb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < m; j++) acc += U.data[j * n + i] * b.data[j];
    Utb[i] = acc;
  }
  // Σ⁻¹ Uᵀ b (truncated)
  for (let i = 0; i < n; i++) {
    Utb[i] = s.data[i] > cutoff ? Utb[i] / s.data[i] : 0;
  }
  // V · (Σ⁻¹ Uᵀ b)
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += V.data[i * n + j] * Utb[j];
    x[i] = acc;
  }
  return new NdArray(x, [n]);
}
