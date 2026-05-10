// Linear systems: LU + partial pivoting, Cholesky for SPD, det / inv via LU.
//
// Targets well-conditioned dense matrices up to ~200×200 in pure JS. For
// ill-conditioned or large systems, fall back to natra+alpack (pivoted QR/SVD).

import { NdArray } from './ndarray.js';

function _checkSquare2D(A, name) {
  if (A.ndim !== 2 || A.shape[0] !== A.shape[1]) {
    throw new RangeError(`${name} requires a square 2D matrix, got [${A.shape.join(',')}]`);
  }
  return A.shape[0];
}

// ---------- LU decomposition with partial pivoting ----------
// Returns { lu, perm, sign } where:
//   lu   — Float64Array (n×n) with U on/above diagonal and L below
//          (L's diagonal is implicitly 1).
//   perm — Int32Array of length n; row i of P*A is original row perm[i].
//   sign — +1 or -1 depending on parity of row swaps.

function _luDecompose(A) {
  const n = _checkSquare2D(A, 'lu');
  const lu = new Float64Array(A.data);
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  let sign = 1;

  for (let k = 0; k < n; k++) {
    // Find pivot row.
    let pivot = k;
    let pivotVal = Math.abs(lu[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(lu[i * n + k]);
      if (v > pivotVal) {
        pivotVal = v;
        pivot = i;
      }
    }
    if (pivotVal === 0) {
      throw new Error('lu: matrix is singular');
    }
    if (pivot !== k) {
      // Swap rows k and pivot.
      for (let j = 0; j < n; j++) {
        const tmp = lu[k * n + j];
        lu[k * n + j] = lu[pivot * n + j];
        lu[pivot * n + j] = tmp;
      }
      const tp = perm[k];
      perm[k] = perm[pivot];
      perm[pivot] = tp;
      sign = -sign;
    }
    // Eliminate below the pivot.
    const pivotElem = lu[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const m = lu[i * n + k] / pivotElem;
      lu[i * n + k] = m;
      for (let j = k + 1; j < n; j++) {
        lu[i * n + j] -= m * lu[k * n + j];
      }
    }
  }
  return { lu, perm, sign, n };
}

// Solve a system using a precomputed LU decomposition, against a single rhs vector.
function _luSolveVec(luData, n, perm, b) {
  // Apply permutation: y[i] = b[perm[i]].
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = b[perm[i]];
  // Forward solve L y = b' (L has unit diagonal).
  for (let i = 0; i < n; i++) {
    let s = x[i];
    for (let j = 0; j < i; j++) s -= luData[i * n + j] * x[j];
    x[i] = s;
  }
  // Back solve U x = y.
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= luData[i * n + j] * x[j];
    x[i] = s / luData[i * n + i];
  }
  return x;
}

// ---------- solve(A, b) ----------
// Returns x such that A x = b. b can be 1D (returns 1D) or 2D (multi-rhs, returns 2D).

export function solve(A, b) {
  const n = _checkSquare2D(A, 'solve');
  const { lu, perm } = _luDecompose(A);

  if (b.ndim === 1) {
    if (b.size !== n) {
      throw new RangeError(`solve: b length ${b.size} does not match A size ${n}`);
    }
    const x = _luSolveVec(lu, n, perm, b.data);
    return new NdArray(x, [n]);
  }
  if (b.ndim === 2) {
    if (b.shape[0] !== n) {
      throw new RangeError(`solve: b row count ${b.shape[0]} does not match A size ${n}`);
    }
    const m = b.shape[1];
    const out = new Float64Array(n * m);
    const col = new Float64Array(n);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) col[i] = b.data[i * m + j];
      const x = _luSolveVec(lu, n, perm, col);
      for (let i = 0; i < n; i++) out[i * m + j] = x[i];
    }
    return new NdArray(out, [n, m]);
  }
  throw new RangeError(`solve: b must be 1D or 2D, got ${b.ndim}D`);
}

// ---------- det(A) ----------

export function det(A) {
  const n = _checkSquare2D(A, 'det');
  let lu, sign;
  try {
    ({ lu, sign } = _luDecompose(A));
  } catch (e) {
    if (e.message.includes('singular')) return 0;
    throw e;
  }
  let p = sign;
  for (let i = 0; i < n; i++) p *= lu[i * n + i];
  return p;
}

// ---------- inv(A) ----------

export function inv(A) {
  const n = _checkSquare2D(A, 'inv');
  const { lu, perm } = _luDecompose(A);
  const out = new Float64Array(n * n);
  const col = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    col.fill(0);
    col[j] = 1;
    const x = _luSolveVec(lu, n, perm, col);
    for (let i = 0; i < n; i++) out[i * n + j] = x[i];
  }
  return new NdArray(out, [n, n]);
}

// ---------- Cholesky ----------
// A = L L^T for symmetric positive-definite A. Returns L (lower triangular).
// Throws if A is not SPD.

export function cholesky(A) {
  const n = _checkSquare2D(A, 'cholesky');
  const L = new Float64Array(n * n);
  const ad = A.data;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = ad[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 0) {
          throw new Error('cholesky: matrix is not positive definite');
        }
        L[i * n + j] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return new NdArray(L, [n, n]);
}

// ---------- solveCholesky(L, b) ----------
// Given L from cholesky(A), solve A x = b in two triangular solves:
//   forward:  L y = b
//   backward: L^T x = y

export function solveCholesky(L, b) {
  const n = _checkSquare2D(L, 'solveCholesky');
  if (b.ndim !== 1 || b.size !== n) {
    throw new RangeError(`solveCholesky: b must be 1D of length ${n}, got ${b.ndim}D shape [${b.shape.join(',')}]`);
  }
  const ld = L.data;
  const x = new Float64Array(n);
  // Forward L y = b.
  for (let i = 0; i < n; i++) {
    let s = b.data[i];
    for (let j = 0; j < i; j++) s -= ld[i * n + j] * x[j];
    x[i] = s / ld[i * n + i];
  }
  // Backward L^T x = y. L^T[i][j] = L[j][i].
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= ld[j * n + i] * x[j];
    x[i] = s / ld[i * n + i];
  }
  return new NdArray(x, [n]);
}
