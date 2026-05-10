// Singular Value Decomposition via one-sided Jacobi rotations.
//
// For an m×n matrix A, computes U (m×k), s (length k), V (n×k) with
// A = U @ diag(s) @ Vᵀ, where k = min(m, n). Singular values are
// returned in descending order.
//
// Algorithm: one-sided Jacobi (Hari-Veselić / de Rijk) — iteratively
// rotate column pairs (p, q) of A so that the resulting columns become
// orthogonal. After convergence, ||A[:, j]|| = σ_j and A[:, j] / σ_j =
// U[:, j]. The accumulated rotation matrix is V.
//
// Pros: simple, accurate, no bidiagonalization phase. Robust for
//       near-rank-deficient matrices.
// Cons: O(m n² × sweeps) where typical sweeps = 5-10. Slower than
//       LAPACK's dgesvd at large n but fine for n < ~500.
//
// References: Demmel & Veselić 1992 ("Jacobi's method is more accurate
// than QR"). LAPACK dgesvj for the canonical implementation.

import { NdArray } from './ndarray.js';

export function svd(A, opts = {}) {
  if (A.ndim !== 2) throw new RangeError(`svd requires 2D array, got ${A.ndim}D`);
  const m = A.shape[0], n = A.shape[1];

  if (m < n) {
    // Compute SVD of Aᵀ (n × m, tall), then swap U and V.
    // A = U Σ Vᵀ  ⇒  Aᵀ = V Σ Uᵀ.
    const Atdata = new Float64Array(n * m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) Atdata[j * m + i] = A.data[i * n + j];
    }
    const At = new NdArray(Atdata, [n, m]);
    const r = svd(At, opts);
    return { U: r.V, s: r.s, V: r.U };
  }

  // m ≥ n. Output shapes: U: m×n, s: n, V: n×n.
  const tol = opts.tol ?? 1e-14;
  const maxSweeps = opts.maxSweeps ?? 30;

  // Working copy of A's columns. At the end its columns are σ_j u_j.
  const W = new Float64Array(A.data);
  // V starts as identity n×n.
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let offDiag = 0;  // sum of |apq|² / (app·aqq) over pairs — convergence proxy
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        // Compute <a_p, a_p>, <a_q, a_q>, <a_p, a_q> using columns of W
        let app = 0, aqq = 0, apq = 0;
        for (let i = 0; i < m; i++) {
          const ap = W[i * n + p];
          const aq = W[i * n + q];
          app += ap * ap;
          aqq += aq * aq;
          apq += ap * aq;
        }
        // Skip if already (nearly) orthogonal, or one column is zero
        if (app === 0 || aqq === 0) continue;
        const offMeasure = apq * apq / (app * aqq);
        offDiag += offMeasure;
        if (offMeasure < tol * tol) continue;

        // Rotation that diagonalizes the 2x2 Gram sub-matrix [[app, apq], [apq, aqq]].
        // tan(2θ) = 2·apq / (app - aqq). We use the stable form.
        const tau = (aqq - app) / (2 * apq);
        let t;
        if (Math.abs(tau) > 1e15) {
          t = 0.5 / tau;  // very small rotation
        } else if (tau >= 0) {
          t = 1 / (tau + Math.sqrt(1 + tau * tau));
        } else {
          t = 1 / (tau - Math.sqrt(1 + tau * tau));
        }
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        // Apply rotation to columns p, q of W
        for (let i = 0; i < m; i++) {
          const wp = W[i * n + p];
          const wq = W[i * n + q];
          W[i * n + p] = c * wp - s * wq;
          W[i * n + q] = s * wp + c * wq;
        }
        // Apply same rotation to columns p, q of V
        for (let i = 0; i < n; i++) {
          const vp = V[i * n + p];
          const vq = V[i * n + q];
          V[i * n + p] = c * vp - s * vq;
          V[i * n + q] = s * vp + c * vq;
        }
      }
    }
    if (offDiag < tol * tol) break;
  }

  // Extract singular values and U columns
  const sigma = new Float64Array(n);
  const U = new Float64Array(m * n);
  for (let j = 0; j < n; j++) {
    let normSq = 0;
    for (let i = 0; i < m; i++) {
      const v = W[i * n + j];
      normSq += v * v;
    }
    const sj = Math.sqrt(normSq);
    sigma[j] = sj;
    if (sj > 0) {
      for (let i = 0; i < m; i++) U[i * n + j] = W[i * n + j] / sj;
    }
    // else: zero singular value — leave U column zero (rare; could fill
    // with an orthogonal vector for full rank, but thin SVD doesn't need it)
  }

  // Sort by descending singular value
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => sigma[b] - sigma[a]);
  const sSorted = new Float64Array(n);
  const USorted = new Float64Array(m * n);
  const VSorted = new Float64Array(n * n);
  for (let newJ = 0; newJ < n; newJ++) {
    const oldJ = order[newJ];
    sSorted[newJ] = sigma[oldJ];
    for (let i = 0; i < m; i++) USorted[i * n + newJ] = U[i * n + oldJ];
    for (let i = 0; i < n; i++) VSorted[i * n + newJ] = V[i * n + oldJ];
  }

  return {
    U: new NdArray(USorted, [m, n]),
    s: new NdArray(sSorted, [n]),
    V: new NdArray(VSorted, [n, n]),
  };
}

// Moore-Penrose pseudoinverse via SVD.
// A⁺ = V diag(1/σ_i, 0 if σ_i < threshold) Uᵀ
// `rcond` (relative condition cutoff) defaults to max(m,n) × machine eps.
export function pinv(A, opts = {}) {
  if (A.ndim !== 2) throw new RangeError('pinv requires 2D array');
  const m = A.shape[0], n = A.shape[1];
  const { U, s, V } = svd(A, opts);
  const k = s.shape[0];
  const sd = s.data;
  const ud = U.data;
  const vd = V.data;
  const rcond = opts.rcond ?? Math.max(m, n) * Number.EPSILON;
  const sMax = sd[0];  // sorted descending
  const cutoff = rcond * sMax;

  // Build V·diag(1/σ) as n×k.
  const VS = new Float64Array(n * k);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      const s_j = sd[j];
      VS[i * k + j] = s_j > cutoff ? vd[i * k + j] / s_j : 0;
    }
  }
  // result = VS @ Uᵀ → shape n × m
  const out = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let p = 0; p < k; p++) sum += VS[i * k + p] * ud[j * k + p];
      out[i * m + j] = sum;
    }
  }
  return new NdArray(out, [n, m]);
}

// Numerical rank — number of singular values above threshold.
export function matrix_rank(A, opts = {}) {
  const { s } = svd(A, opts);
  const m = A.shape[0], n = A.shape[1];
  const sMax = s.data[0];
  const tol = opts.tol ?? Math.max(m, n) * sMax * Number.EPSILON;
  let r = 0;
  for (let i = 0; i < s.data.length; i++) if (s.data[i] > tol) r++;
  return r;
}
