// Symmetric eigendecomposition: closed-form 3×3 (Cardano) + general N×N (Jacobi).
//
// Both return { values: NdArray[n], vectors: NdArray[n,n] } where vectors[:,i]
// is the unit eigenvector corresponding to values[i]. Values are sorted in
// descending order. Vectors form an orthonormal basis (within numerical
// precision).

import { NdArray } from './ndarray.js';

function _checkSymSquare(A, name) {
  if (A.ndim !== 2 || A.shape[0] !== A.shape[1]) {
    throw new RangeError(`${name} requires a square 2D matrix, got [${A.shape.join(',')}]`);
  }
  return A.shape[0];
}

// ---------- eigSym3 (Cardano closed-form) ----------
// Specialized for the 3×3 symmetric case. Used for stress tensors, structural
// fabric, moment-of-inertia, etc. Returns eigenvalues sorted descending and
// orthonormal eigenvectors as columns.

export function eigSym3(A) {
  if (_checkSymSquare(A, 'eigSym3') !== 3) {
    throw new RangeError(`eigSym3 requires 3×3, got ${A.shape[0]}×${A.shape[1]}`);
  }
  const d = A.data;
  const a = d[0], b = d[1], c = d[2];
  const dd = d[4], e = d[5];
  const f = d[8];
  // (b == d[3], c == d[6], e == d[7] in a symmetric matrix; we ignore those.)

  // Smith (1961) closed-form eigenvalue algorithm.
  const p1 = b * b + c * c + e * e;
  let lam1, lam2, lam3;
  if (p1 === 0) {
    // Already diagonal.
    lam1 = a; lam2 = dd; lam3 = f;
  } else {
    const q = (a + dd + f) / 3;
    const p2 = (a - q) * (a - q) + (dd - q) * (dd - q) + (f - q) * (f - q) + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    // B = (A - q*I) / p
    const B00 = (a  - q) / p;
    const B11 = (dd - q) / p;
    const B22 = (f  - q) / p;
    const B01 = b / p, B02 = c / p, B12 = e / p;
    // det(B) / 2
    const detB = (
      B00 * (B11 * B22 - B12 * B12)
    - B01 * (B01 * B22 - B12 * B02)
    + B02 * (B01 * B12 - B11 * B02)
    );
    let r = detB / 2;
    if (r < -1) r = -1;
    if (r >  1) r =  1;
    const phi = Math.acos(r) / 3;
    lam1 = q + 2 * p * Math.cos(phi);
    lam3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
    lam2 = 3 * q - lam1 - lam3;
  }
  // Sort descending.
  let l1 = lam1, l2 = lam2, l3 = lam3;
  if (l1 < l2) { const t = l1; l1 = l2; l2 = t; }
  if (l2 < l3) { const t = l2; l2 = l3; l3 = t; }
  if (l1 < l2) { const t = l1; l1 = l2; l2 = t; }

  // Full-degeneracy short-circuit: when all three eigenvalues are equal,
  // every direction is an eigenvector. Identity is a valid orthonormal basis.
  const scale = Math.max(Math.abs(l1), Math.abs(l3), 1);
  if (Math.abs(l1 - l3) < 1e-12 * scale) {
    return {
      values: new NdArray(new Float64Array([l1, l2, l3]), [3]),
      vectors: new NdArray(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), [3, 3]),
    };
  }

  // Compute v3 first (smallest eigenvalue). For non-degenerate cases, this
  // is unambiguous (rank-2 null space → unique eigenvector).
  let v3 = _eigVec3(a, b, c, dd, e, f, l3);
  let v1 = _eigVec3(a, b, c, dd, e, f, l1);

  // Orthogonalize v1 against v3 (Gram-Schmidt). Resolves ambiguity in the
  // partially-degenerate case (λ1 == λ2): v1 is any vector in a 2D
  // eigenspace, and we pick the component orthogonal to v3.
  const dot13 = v1[0] * v3[0] + v1[1] * v3[1] + v1[2] * v3[2];
  v1[0] -= dot13 * v3[0];
  v1[1] -= dot13 * v3[1];
  v1[2] -= dot13 * v3[2];
  let n1 = Math.hypot(v1[0], v1[1], v1[2]);
  if (n1 < 1e-10) {
    // v1 collapsed onto v3 — pick any unit vector orthogonal to v3.
    const seed = (Math.abs(v3[0]) < Math.abs(v3[1]) && Math.abs(v3[0]) < Math.abs(v3[2]))
      ? [1, 0, 0]
      : (Math.abs(v3[1]) < Math.abs(v3[2]))
        ? [0, 1, 0]
        : [0, 0, 1];
    v1 = _cross(v3, seed);
    n1 = Math.hypot(v1[0], v1[1], v1[2]);
  }
  v1[0] /= n1; v1[1] /= n1; v1[2] /= n1;

  // v2 = v3 × v1 (right-handed orthonormal basis; v1, v3 are unit and
  // orthogonal, so the cross product is also unit-length).
  const v2 = _cross(v3, v1);

  // Pack vectors as columns of a 3×3 matrix.
  const V = new Float64Array(9);
  V[0] = v1[0]; V[1] = v2[0]; V[2] = v3[0];
  V[3] = v1[1]; V[4] = v2[1]; V[5] = v3[1];
  V[6] = v1[2]; V[7] = v2[2]; V[8] = v3[2];

  return {
    values: new NdArray(new Float64Array([l1, l2, l3]), [3]),
    vectors: new NdArray(V, [3, 3]),
  };
}

function _eigVec3(a, b, c, dd, e, f, lam) {
  // (A - λI) rows.
  const r0 = [a - lam, b, c];
  const r1 = [b, dd - lam, e];
  const r2 = [c, e, f - lam];
  // Rank-2 case: cross product of any two non-parallel rows lies in the null
  // space. Try all three pairs, pick the largest-magnitude (most numerically
  // stable) one.
  const c01 = _cross(r0, r1);
  const c02 = _cross(r0, r2);
  const c12 = _cross(r1, r2);
  const m01 = c01[0]*c01[0] + c01[1]*c01[1] + c01[2]*c01[2];
  const m02 = c02[0]*c02[0] + c02[1]*c02[1] + c02[2]*c02[2];
  const m12 = c12[0]*c12[0] + c12[1]*c12[1] + c12[2]*c12[2];
  let best = c01, bestM = m01;
  if (m02 > bestM) { best = c02; bestM = m02; }
  if (m12 > bestM) { best = c12; bestM = m12; }
  if (bestM > 1e-20) {
    const n = Math.sqrt(bestM);
    return [best[0] / n, best[1] / n, best[2] / n];
  }
  // Rank ≤ 1 case (eigenvalue has multiplicity ≥ 2). Find the row with
  // largest magnitude — it spans the row space. Return any vector orthogonal
  // to it; the caller will Gram-Schmidt against other eigenvectors to
  // disambiguate within the multi-dimensional eigenspace.
  const m_r0 = r0[0]*r0[0] + r0[1]*r0[1] + r0[2]*r0[2];
  const m_r1 = r1[0]*r1[0] + r1[1]*r1[1] + r1[2]*r1[2];
  const m_r2 = r2[0]*r2[0] + r2[1]*r2[1] + r2[2]*r2[2];
  let nz, mNz;
  if (m_r0 >= m_r1 && m_r0 >= m_r2) { nz = r0; mNz = m_r0; }
  else if (m_r1 >= m_r2) { nz = r1; mNz = m_r1; }
  else { nz = r2; mNz = m_r2; }
  if (mNz < 1e-20) {
    // Rank 0: (A - λI) is zero — eigenspace is all of R^3.
    return [1, 0, 0];
  }
  // Pick a canonical basis vector with smallest |nz| component (most
  // perpendicular to nz), so the cross product is well-conditioned.
  const ax = Math.abs(nz[0]), ay = Math.abs(nz[1]), az = Math.abs(nz[2]);
  const seed = (ax <= ay && ax <= az) ? [1, 0, 0]
            : (ay <= az)               ? [0, 1, 0]
            :                            [0, 0, 1];
  const ortho = _cross(nz, seed);
  const oN = Math.hypot(ortho[0], ortho[1], ortho[2]);
  return [ortho[0] / oN, ortho[1] / oN, ortho[2] / oN];
}

function _cross(u, v) {
  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
}

// ---------- eigSym (Jacobi rotations) ----------
// Iteratively applies Givens rotations to zero out off-diagonal elements.
// Quadratic convergence — typically 5-10 sweeps for matrices up to ~100×100.
// Caller can pass { maxSweeps, tol } in opts.

export function eigSym(A, opts) {
  const n = _checkSymSquare(A, 'eigSym');
  const maxSweeps = (opts && opts.maxSweeps) || 50;
  const tol = (opts && opts.tol) || 1e-12;

  // Working copy of A (will diagonalize in place).
  const D = new Float64Array(A.data);
  // Eigenvector accumulator V starts as identity.
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    // Sum of squares of off-diagonal elements.
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        off += D[p * n + q] * D[p * n + q];
      }
    }
    if (off < tol * tol) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = D[p * n + q];
        if (Math.abs(apq) < 1e-15) continue;
        const app = D[p * n + p];
        const aqq = D[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = (theta >= 0)
          ? 1 / (theta + Math.sqrt(theta * theta + 1))
          : 1 / (theta - Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        // Update diagonal entries.
        D[p * n + p] = app - t * apq;
        D[q * n + q] = aqq + t * apq;
        D[p * n + q] = 0;
        D[q * n + p] = 0;

        // Update other rows/cols. For i != p, q:
        //   new D[i,p] = c * D[i,p] - s * D[i,q]
        //   new D[i,q] = s * D[i,p_old] + c * D[i,q]
        for (let i = 0; i < n; i++) {
          if (i === p || i === q) continue;
          const ip = D[i * n + p];
          const iq = D[i * n + q];
          D[i * n + p] = c * ip - s * iq;
          D[i * n + q] = s * ip + c * iq;
          D[p * n + i] = D[i * n + p];
          D[q * n + i] = D[i * n + q];
        }

        // Update eigenvector accumulator V.
        for (let i = 0; i < n; i++) {
          const ip = V[i * n + p];
          const iq = V[i * n + q];
          V[i * n + p] = c * ip - s * iq;
          V[i * n + q] = s * ip + c * iq;
        }
      }
    }
  }

  // Extract eigenvalues from D's diagonal, sort descending, permute V's columns.
  const indexed = new Array(n);
  for (let i = 0; i < n; i++) indexed[i] = { val: D[i * n + i], idx: i };
  indexed.sort((a, b) => b.val - a.val);

  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    values[j] = indexed[j].val;
    const srcCol = indexed[j].idx;
    for (let i = 0; i < n; i++) vectors[i * n + j] = V[i * n + srcCol];
  }

  return {
    values: new NdArray(values, [n]),
    vectors: new NdArray(vectors, [n, n]),
  };
}
