// Vector and matrix norms, plus utility products (cross, kron) and
// matrix_power. Small additions that round out the numpy.linalg surface.

import { NdArray } from './ndarray.js';
import { svd } from './linalg-svd.js';
import { matmul } from './linalg-mul.js';

// ── vector norms ────────────────────────────────────────────────────
//
// vecNorm(x, ord) for 1D arrays. Supported orders:
//   2 (default) — Euclidean (L2). Matches reduce.js's `norm`.
//   1           — sum of absolute values (L1, "Manhattan")
//   Infinity    — max absolute value (L∞, "Chebyshev")
//  -Infinity    — min absolute value (rare but in numpy.linalg)
//   p > 0       — (Σ|x_i|^p)^(1/p)

export function vecNorm(x, ord = 2) {
  if (x.ndim !== 1) {
    throw new RangeError(`vecNorm requires 1D array, got ${x.ndim}D`);
  }
  const d = x.data;
  const n = x.size;
  if (ord === 2) {
    // Unrolled-4 like reduce.js's norm
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    const n4 = n - (n & 3);
    let i = 0;
    for (; i < n4; i += 4) {
      s0 += d[i  ] * d[i  ];
      s1 += d[i+1] * d[i+1];
      s2 += d[i+2] * d[i+2];
      s3 += d[i+3] * d[i+3];
    }
    let s = (s0 + s1) + (s2 + s3);
    for (; i < n; i++) s += d[i] * d[i];
    return Math.sqrt(s);
  }
  if (ord === 1) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(d[i]);
    return s;
  }
  if (ord === Infinity) {
    let m = 0;
    for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v > m) m = v; }
    return m;
  }
  if (ord === -Infinity) {
    if (n === 0) return Infinity;
    let m = Infinity;
    for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v < m) m = v; }
    return m;
  }
  if (typeof ord === 'number' && ord > 0) {
    // General p-norm
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.pow(Math.abs(d[i]), ord);
    return Math.pow(s, 1 / ord);
  }
  throw new RangeError(`vecNorm: unsupported ord ${ord}`);
}

// ── matrix norms ────────────────────────────────────────────────────
//
// matNorm(A, ord) for 2D arrays. Supported orders:
//   'fro' (default) — Frobenius: sqrt(Σ a_ij²)
//   1               — max column sum of abs values (induced 1-norm)
//   Infinity        — max row sum of abs values (induced ∞-norm)
//   2               — largest singular value (spectral norm)
//  -1, -Infinity, -2 — corresponding minima (numpy supports these)
//   'nuc'           — nuclear norm = sum of singular values

export function matNorm(A, ord = 'fro') {
  if (A.ndim !== 2) {
    throw new RangeError(`matNorm requires 2D array, got ${A.ndim}D`);
  }
  const m = A.shape[0], n = A.shape[1];
  const d = A.data;

  if (ord === 'fro') {
    let s = 0;
    for (let i = 0; i < m * n; i++) s += d[i] * d[i];
    return Math.sqrt(s);
  }
  if (ord === 1) {
    // max over j of Σ_i |a_ij|
    let best = 0;
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += Math.abs(d[i * n + j]);
      if (s > best) best = s;
    }
    return best;
  }
  if (ord === -1) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += Math.abs(d[i * n + j]);
      if (s < best) best = s;
    }
    return best;
  }
  if (ord === Infinity) {
    let best = 0;
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += Math.abs(d[i * n + j]);
      if (s > best) best = s;
    }
    return best;
  }
  if (ord === -Infinity) {
    let best = Infinity;
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += Math.abs(d[i * n + j]);
      if (s < best) best = s;
    }
    return best;
  }
  if (ord === 2) {
    // Largest singular value
    const { s } = svd(A);
    return s.data[0];
  }
  if (ord === -2) {
    const { s } = svd(A);
    return s.data[s.shape[0] - 1];
  }
  if (ord === 'nuc') {
    const { s } = svd(A);
    let sum = 0;
    for (let i = 0; i < s.size; i++) sum += s.data[i];
    return sum;
  }
  throw new RangeError(`matNorm: unsupported ord ${ord}`);
}

// ── cross product (3D vectors only) ─────────────────────────────────

export function cross(a, b) {
  if (a.ndim !== 1 || b.ndim !== 1) {
    throw new RangeError('cross: both args must be 1D');
  }
  if (a.size !== 3 || b.size !== 3) {
    throw new RangeError(`cross: only 3D vectors supported (got ${a.size}, ${b.size})`);
  }
  const ad = a.data, bd = b.data;
  const out = new Float64Array(3);
  out[0] = ad[1] * bd[2] - ad[2] * bd[1];
  out[1] = ad[2] * bd[0] - ad[0] * bd[2];
  out[2] = ad[0] * bd[1] - ad[1] * bd[0];
  return new NdArray(out, [3]);
}

// ── Kronecker product ───────────────────────────────────────────────
//
// For A (m × n) and B (p × q), returns kron(A, B) of shape (m·p × n·q).
// (kron(A, B))[i·p + k, j·q + l] = A[i, j] * B[k, l]

export function kron(A, B) {
  // Support 1D inputs by promoting to row vectors
  let Ah, Aw, Ad;
  if (A.ndim === 1) { Ah = 1; Aw = A.size; Ad = A.data; }
  else if (A.ndim === 2) { Ah = A.shape[0]; Aw = A.shape[1]; Ad = A.data; }
  else throw new RangeError(`kron: arrays must be 1D or 2D, got ${A.ndim}D`);
  let Bh, Bw, Bd;
  if (B.ndim === 1) { Bh = 1; Bw = B.size; Bd = B.data; }
  else if (B.ndim === 2) { Bh = B.shape[0]; Bw = B.shape[1]; Bd = B.data; }
  else throw new RangeError(`kron: arrays must be 1D or 2D, got ${B.ndim}D`);

  const Oh = Ah * Bh, Ow = Aw * Bw;
  const out = new Float64Array(Oh * Ow);
  for (let i = 0; i < Ah; i++) {
    for (let j = 0; j < Aw; j++) {
      const aij = Ad[i * Aw + j];
      const rowBase = i * Bh;
      const colBase = j * Bw;
      for (let k = 0; k < Bh; k++) {
        for (let l = 0; l < Bw; l++) {
          out[(rowBase + k) * Ow + (colBase + l)] = aij * Bd[k * Bw + l];
        }
      }
    }
  }
  // Promote both 1D inputs to result of same dimensionality as inputs:
  // numpy.kron returns 1D if both inputs are 1D, 2D otherwise.
  if (A.ndim === 1 && B.ndim === 1) {
    return new NdArray(out, [Ow]);
  }
  return new NdArray(out, [Oh, Ow]);
}

// ── matrix_power ────────────────────────────────────────────────────
//
// For a square matrix A and integer k, returns A^k. Uses
// exponentiation-by-squaring. k = 0 returns identity; k < 0 uses inv(A).

export function matrix_power(A, k) {
  if (A.ndim !== 2 || A.shape[0] !== A.shape[1]) {
    throw new RangeError('matrix_power requires a square 2D matrix');
  }
  if (!Number.isInteger(k)) {
    throw new RangeError(`matrix_power: exponent must be an integer, got ${k}`);
  }
  const n = A.shape[0];

  if (k === 0) {
    const I = new Float64Array(n * n);
    for (let i = 0; i < n; i++) I[i * n + i] = 1;
    return new NdArray(I, [n, n]);
  }
  if (k < 0) {
    // Need inv() — lazy import to avoid circular deps
    // (linalg-solve imports linalg-mul, which we're using here too)
    return matrix_power(_inv(A), -k);
  }
  if (k === 1) {
    return new NdArray(new Float64Array(A.data), [n, n]);
  }

  // Exponentiation by squaring
  let base = new NdArray(new Float64Array(A.data), [n, n]);
  // Start result = I
  const Idata = new Float64Array(n * n);
  for (let i = 0; i < n; i++) Idata[i * n + i] = 1;
  let result = new NdArray(Idata, [n, n]);
  let exp = k;
  while (exp > 0) {
    if (exp & 1) result = matmul(result, base);
    exp >>= 1;
    if (exp > 0) base = matmul(base, base);
  }
  return result;
}

// Local copy of inv to avoid circular import. Only invoked for negative
// powers (rare path); we'd rather inline a tiny version than restructure.
function _inv(A) {
  const n = A.shape[0];
  // Augment [A | I] and Gauss-Jordan
  const aug = new Float64Array(n * 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i * 2 * n + j] = A.data[i * n + j];
    aug[i * 2 * n + (n + i)] = 1;
  }
  for (let i = 0; i < n; i++) {
    // pivot — find max abs in column i below row i
    let piv = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(aug[r * 2 * n + i]) > Math.abs(aug[piv * 2 * n + i])) piv = r;
    }
    if (piv !== i) {
      for (let c = 0; c < 2 * n; c++) {
        const t = aug[i * 2 * n + c];
        aug[i * 2 * n + c] = aug[piv * 2 * n + c];
        aug[piv * 2 * n + c] = t;
      }
    }
    const pivot = aug[i * 2 * n + i];
    if (pivot === 0) throw new Error('matrix_power: singular matrix, no inverse');
    const invPivot = 1 / pivot;
    for (let c = 0; c < 2 * n; c++) aug[i * 2 * n + c] *= invPivot;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = aug[r * 2 * n + i];
      if (factor !== 0) {
        for (let c = 0; c < 2 * n; c++) aug[r * 2 * n + c] -= factor * aug[i * 2 * n + c];
      }
    }
  }
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out[i * n + j] = aug[i * 2 * n + (n + j)];
  }
  return new NdArray(out, [n, n]);
}

// ── triangular solve ────────────────────────────────────────────────
//
// solve_triangular(L, b, { lower: true }) — solves Lx = b for lower-triangular L
// solve_triangular(U, b, { lower: false }) — solves Ux = b for upper-triangular U
// Used internally by QR-based lstsq, Cholesky-based solve, etc.

export function solve_triangular(T, b, opts = {}) {
  if (T.ndim !== 2 || T.shape[0] !== T.shape[1]) {
    throw new RangeError('solve_triangular requires a square 2D matrix');
  }
  if (b.ndim !== 1 || b.size !== T.shape[0]) {
    throw new RangeError(`solve_triangular: RHS size mismatch`);
  }
  const n = T.shape[0];
  const td = T.data;
  const x = new Float64Array(b.data);
  const lower = opts.lower !== false;  // default true
  if (lower) {
    // Forward substitution
    for (let i = 0; i < n; i++) {
      let sum = x[i];
      for (let j = 0; j < i; j++) sum -= td[i * n + j] * x[j];
      const diag = td[i * n + i];
      if (diag === 0) throw new Error('solve_triangular: zero on diagonal');
      x[i] = sum / diag;
    }
  } else {
    // Back substitution
    for (let i = n - 1; i >= 0; i--) {
      let sum = x[i];
      for (let j = i + 1; j < n; j++) sum -= td[i * n + j] * x[j];
      const diag = td[i * n + i];
      if (diag === 0) throw new Error('solve_triangular: zero on diagonal');
      x[i] = sum / diag;
    }
  }
  return new NdArray(x, [n]);
}
