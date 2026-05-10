// Matrix multiplication, transpose, and closed-form det/inv for 2×2, 3×3, 4×4.

import { NdArray } from './ndarray.js';

// ---------- matmul ----------
// 2D × 2D matrix multiplication. Loop-reordered (i, k, j) for cache locality:
// reads of A[i,k] are stride-1 in the k loop, B[k,:] is contiguous in the j loop,
// and writes to C[i,:] are also contiguous. ~2-3× faster than the textbook (i,j,k)
// form at the same LOC.

export function matmul(A, B) {
  if (A.ndim !== 2 || B.ndim !== 2) {
    throw new RangeError(`matmul requires 2D arrays, got ${A.ndim}D × ${B.ndim}D`);
  }
  const M = A.shape[0], K = A.shape[1];
  const Kb = B.shape[0], N = B.shape[1];
  if (K !== Kb) {
    throw new RangeError(`matmul inner dim mismatch: [${M},${K}] × [${Kb},${N}]`);
  }
  const out = new Float64Array(M * N);
  const ad = A.data, bd = B.data;
  for (let i = 0; i < M; i++) {
    const aRow = i * K;
    const oRow = i * N;
    for (let k = 0; k < K; k++) {
      const aik = ad[aRow + k];
      const bRow = k * N;
      for (let j = 0; j < N; j++) {
        out[oRow + j] += aik * bd[bRow + j];
      }
    }
  }
  return new NdArray(out, [M, N]);
}

// ---------- transpose ----------
// 2D only in v1. Returns a new contiguous array with axes swapped.

export function transpose(A) {
  if (A.ndim !== 2) {
    throw new RangeError(`transpose v1 requires 2D, got ${A.ndim}D`);
  }
  const m = A.shape[0], n = A.shape[1];
  const out = new Float64Array(m * n);
  const d = A.data;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      out[j * m + i] = d[i * n + j];
    }
  }
  return new NdArray(out, [n, m]);
}

// ---------- closed-form determinants ----------

function _checkSquare(A, size, name) {
  if (A.ndim !== 2 || A.shape[0] !== size || A.shape[1] !== size) {
    throw new RangeError(`${name} requires a ${size}×${size} matrix, got [${A.shape.join(',')}]`);
  }
}

export function det2(A) {
  _checkSquare(A, 2, 'det2');
  const d = A.data;
  return d[0] * d[3] - d[1] * d[2];
}

export function det3(A) {
  _checkSquare(A, 3, 'det3');
  const d = A.data;
  // Sarrus / Laplace along row 0.
  const a = d[0], b = d[1], c = d[2];
  const e = d[3], f = d[4], g = d[5];
  const h = d[6], i = d[7], j = d[8];
  return a * (f * j - g * i) - b * (e * j - g * h) + c * (e * i - f * h);
}

export function det4(A) {
  _checkSquare(A, 4, 'det4');
  const d = A.data;
  const a00 = d[0],  a01 = d[1],  a02 = d[2],  a03 = d[3];
  const a10 = d[4],  a11 = d[5],  a12 = d[6],  a13 = d[7];
  const a20 = d[8],  a21 = d[9],  a22 = d[10], a23 = d[11];
  const a30 = d[12], a31 = d[13], a32 = d[14], a33 = d[15];

  // 2×2 sub-determinants from rows 2,3 (reused).
  const s01 = a20 * a31 - a21 * a30;
  const s02 = a20 * a32 - a22 * a30;
  const s03 = a20 * a33 - a23 * a30;
  const s12 = a21 * a32 - a22 * a31;
  const s13 = a21 * a33 - a23 * a31;
  const s23 = a22 * a33 - a23 * a32;

  // det via expansion along row 0 grouped by 2×2 minors of (a1*, s_*).
  return (
      a00 * (a11 * s23 - a12 * s13 + a13 * s12)
    - a01 * (a10 * s23 - a12 * s03 + a13 * s02)
    + a02 * (a10 * s13 - a11 * s03 + a13 * s01)
    - a03 * (a10 * s12 - a11 * s02 + a12 * s01)
  );
}

// ---------- closed-form inverses ----------
// All throw on singular matrices (det == 0). Caller can wrap in try/catch.

function _singularError(name) {
  return new Error(`${name}: matrix is singular (determinant is zero)`);
}

export function inv2(A) {
  _checkSquare(A, 2, 'inv2');
  const d = A.data;
  const det = d[0] * d[3] - d[1] * d[2];
  if (det === 0) throw _singularError('inv2');
  const k = 1 / det;
  const out = new Float64Array(4);
  out[0] =  d[3] * k;
  out[1] = -d[1] * k;
  out[2] = -d[2] * k;
  out[3] =  d[0] * k;
  return new NdArray(out, [2, 2]);
}

export function inv3(A) {
  _checkSquare(A, 3, 'inv3');
  const d = A.data;
  const a = d[0], b = d[1], c = d[2];
  const e = d[3], f = d[4], g = d[5];
  const h = d[6], i = d[7], j = d[8];
  // Cofactors (signed minors).
  const c00 =  (f * j - g * i);
  const c01 = -(e * j - g * h);
  const c02 =  (e * i - f * h);
  const det = a * c00 + b * c01 + c * c02;
  if (det === 0) throw _singularError('inv3');
  const c10 = -(b * j - c * i);
  const c11 =  (a * j - c * h);
  const c12 = -(a * i - b * h);
  const c20 =  (b * g - c * f);
  const c21 = -(a * g - c * e);
  const c22 =  (a * f - b * e);
  const k = 1 / det;
  const out = new Float64Array(9);
  // adjugate = transpose of cofactor matrix; inverse = adjugate / det.
  out[0] = c00 * k; out[1] = c10 * k; out[2] = c20 * k;
  out[3] = c01 * k; out[4] = c11 * k; out[5] = c21 * k;
  out[6] = c02 * k; out[7] = c12 * k; out[8] = c22 * k;
  return new NdArray(out, [3, 3]);
}

// ---------- diag / outer / tril / triu ----------

// diag(a, k = 0):
//   1D input → 2D matrix with `a` placed on the k-th diagonal (k>0 above
//   the main diagonal, k<0 below). Off-diagonal entries are zero.
//   2D input → 1D vector of the k-th diagonal.

export function diag(a, k = 0) {
  if (a.ndim === 1) {
    const n = a.size + Math.abs(k);
    const out = new Float64Array(n * n);
    for (let i = 0; i < a.size; i++) {
      const row = k >= 0 ? i : i - k;
      const col = k >= 0 ? i + k : i;
      out[row * n + col] = a.data[i];
    }
    return new NdArray(out, [n, n]);
  }
  if (a.ndim === 2) {
    const m = a.shape[0], n = a.shape[1];
    const len = k >= 0 ? Math.min(m, n - k) : Math.min(m + k, n);
    if (len <= 0) return new NdArray(new Float64Array(0), [0]);
    const out = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const row = k >= 0 ? i : i - k;
      const col = k >= 0 ? i + k : i;
      out[i] = a.data[row * n + col];
    }
    return new NdArray(out, [len]);
  }
  throw new RangeError(`diag requires 1D or 2D, got ${a.ndim}D`);
}

// outer(a, b) — outer product of two 1D vectors. out[i, j] = a[i] * b[j].

export function outer(a, b) {
  if (a.ndim !== 1 || b.ndim !== 1) {
    throw new RangeError(`outer requires two 1D vectors, got ${a.ndim}D × ${b.ndim}D`);
  }
  const m = a.size, n = b.size;
  const out = new Float64Array(m * n);
  const ad = a.data, bd = b.data;
  for (let i = 0; i < m; i++) {
    const ai = ad[i];
    for (let j = 0; j < n; j++) out[i * n + j] = ai * bd[j];
  }
  return new NdArray(out, [m, n]);
}

// tril(A, k = 0) — keep entries on/below the k-th diagonal, zero the rest.
// k > 0 keeps additional bands above; k < 0 zeroes bands at and above main.

export function tril(A, k = 0) {
  if (A.ndim !== 2) throw new RangeError(`tril requires 2D, got ${A.ndim}D`);
  const m = A.shape[0], n = A.shape[1];
  const out = new Float64Array(m * n);
  const d = A.data;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (j - i <= k) out[i * n + j] = d[i * n + j];
    }
  }
  return new NdArray(out, [m, n]);
}

// triu(A, k = 0) — keep entries on/above the k-th diagonal, zero the rest.

export function triu(A, k = 0) {
  if (A.ndim !== 2) throw new RangeError(`triu requires 2D, got ${A.ndim}D`);
  const m = A.shape[0], n = A.shape[1];
  const out = new Float64Array(m * n);
  const d = A.data;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (j - i >= k) out[i * n + j] = d[i * n + j];
    }
  }
  return new NdArray(out, [m, n]);
}

export function inv4(A) {
  _checkSquare(A, 4, 'inv4');
  const d = A.data;
  const a00 = d[0],  a01 = d[1],  a02 = d[2],  a03 = d[3];
  const a10 = d[4],  a11 = d[5],  a12 = d[6],  a13 = d[7];
  const a20 = d[8],  a21 = d[9],  a22 = d[10], a23 = d[11];
  const a30 = d[12], a31 = d[13], a32 = d[14], a33 = d[15];

  // 2×2 sub-dets from rows 0,1.
  const t01 = a00 * a11 - a01 * a10;
  const t02 = a00 * a12 - a02 * a10;
  const t03 = a00 * a13 - a03 * a10;
  const t12 = a01 * a12 - a02 * a11;
  const t13 = a01 * a13 - a03 * a11;
  const t23 = a02 * a13 - a03 * a12;

  // 2×2 sub-dets from rows 2,3.
  const s01 = a20 * a31 - a21 * a30;
  const s02 = a20 * a32 - a22 * a30;
  const s03 = a20 * a33 - a23 * a30;
  const s12 = a21 * a32 - a22 * a31;
  const s13 = a21 * a33 - a23 * a31;
  const s23 = a22 * a33 - a23 * a32;

  const det = t01 * s23 - t02 * s13 + t03 * s12 + t12 * s03 - t13 * s02 + t23 * s01;
  if (det === 0) throw _singularError('inv4');
  const k = 1 / det;

  // Adjugate via the standard 4×4 inverse formula expressed in t_ij / s_ij.
  const out = new Float64Array(16);
  out[0]  = ( a11 * s23 - a12 * s13 + a13 * s12) * k;
  out[1]  = (-a01 * s23 + a02 * s13 - a03 * s12) * k;
  out[2]  = ( a31 * t23 - a32 * t13 + a33 * t12) * k;
  out[3]  = (-a21 * t23 + a22 * t13 - a23 * t12) * k;

  out[4]  = (-a10 * s23 + a12 * s03 - a13 * s02) * k;
  out[5]  = ( a00 * s23 - a02 * s03 + a03 * s02) * k;
  out[6]  = (-a30 * t23 + a32 * t03 - a33 * t02) * k;
  out[7]  = ( a20 * t23 - a22 * t03 + a23 * t02) * k;

  out[8]  = ( a10 * s13 - a11 * s03 + a13 * s01) * k;
  out[9]  = (-a00 * s13 + a01 * s03 - a03 * s01) * k;
  out[10] = ( a30 * t13 - a31 * t03 + a33 * t01) * k;
  out[11] = (-a20 * t13 + a21 * t03 - a23 * t01) * k;

  out[12] = (-a10 * s12 + a11 * s02 - a12 * s01) * k;
  out[13] = ( a00 * s12 - a01 * s02 + a02 * s01) * k;
  out[14] = (-a30 * t12 + a31 * t02 - a32 * t01) * k;
  out[15] = ( a20 * t12 - a21 * t02 + a22 * t01) * k;

  return new NdArray(out, [4, 4]);
}
