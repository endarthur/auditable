// Least squares via normal equations.
//
// Solve x = argmin_x || A x - b ||_2 by reducing to A^T A x = A^T b
// and Cholesky-factoring A^T A (which is symmetric positive-definite when
// A has full column rank).
//
// CAVEAT: the condition number of A^T A is the SQUARE of A's condition
// number, so this method is numerically unstable for ill-conditioned A.
// For well-conditioned overdetermined systems (typical regression /
// plane-fitting / kriging-stencil work), it's fast and accurate. For
// ill-conditioned problems, prefer natra+alpack's pivoted QR or SVD-based
// least squares.

import { NdArray } from './ndarray.js';
import { matmul, transpose } from './linalg-mul.js';
import { cholesky, solveCholesky } from './linalg-solve.js';

export function lstsq(A, b) {
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
  const At = transpose(A);
  const AtA = matmul(At, A);
  // A^T b — manual mat-vec to avoid the 1D-vs-2D decision tree.
  const Atb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += At.data[i * m + j] * b.data[j];
    Atb[i] = s;
  }
  const L = cholesky(AtA);
  return solveCholesky(L, new NdArray(Atb, [n]));
}
