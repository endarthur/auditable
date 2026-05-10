// Linear algebra tests: solve, cholesky, lstsq, eigSym3, eigSym.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NdArray,
  from, eye, zeros,
  matmul, transpose,
  det2, det3, det4,
  inv2, inv3, inv4,
  solve, det, inv, cholesky, solveCholesky,
  lstsq,
  eigSym3, eigSym,
} from '../ext/vec/src/index.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-9) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

function isClose2D(A, B, tol = 1e-9) {
  if (A.shape[0] !== B.shape[0] || A.shape[1] !== B.shape[1]) return false;
  return arrClose(A.data, B.data, tol);
}

function isIdentity(M, n, tol = 1e-9) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const expected = i === j ? 1 : 0;
      if (!close(M.data[i * n + j], expected, tol)) return false;
    }
  }
  return true;
}

// ---------- solve ----------

test('solve: A x = b on a small system', () => {
  // A = [[2, 1], [5, 7]], b = [11, 13]
  // Hand-solve: x = [2, 7/5*2 - ... ] let me just do via inverse:
  // det = 14 - 5 = 9; inv = (1/9) [[7, -1], [-5, 2]]
  // x = inv * b = (1/9) [7*11 - 13, -5*11 + 2*13] = (1/9) [64, -29]
  const A = from([[2, 1], [5, 7]]);
  const b = from([11, 13]);
  const x = solve(A, b);
  assert.deepEqual(x.shape, [2]);
  assert.ok(arrClose(x.data, [64 / 9, -29 / 9]));
  // Verify Ax = b.
  const Ax = matmul(A, from(x.data, [2, 1]));
  assert.ok(arrClose(Ax.data, [11, 13]));
});

test('solve: requires partial pivoting (zero pivot in row 0)', () => {
  // A = [[0, 1], [1, 0]] needs row swap. b = [3, 5].
  // Expected: x = [5, 3].
  const A = from([[0, 1], [1, 0]]);
  const b = from([3, 5]);
  const x = solve(A, b);
  assert.ok(arrClose(x.data, [5, 3]));
});

test('solve: 4×4 well-conditioned', () => {
  const A = from([
    [4, 1, 0, 0],
    [1, 4, 1, 0],
    [0, 1, 4, 1],
    [0, 0, 1, 4],
  ]);
  const b = from([1, 2, 3, 4]);
  const x = solve(A, b);
  // Verify A x = b.
  const out = new Float64Array(4);
  for (let i = 0; i < 4; i++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += A.data[i * 4 + j] * x.data[j];
    out[i] = s;
  }
  assert.ok(arrClose(out, b.data));
});

test('solve: multi-rhs (2D b)', () => {
  // Solving A X = B with B = [[1, 2], [3, 4]] is solving against two columns.
  const A = from([[2, 1], [1, 3]]);
  const B = from([[1, 2], [3, 4]]);
  const X = solve(A, B);
  assert.deepEqual(X.shape, [2, 2]);
  // Verify A X = B.
  const AX = matmul(A, X);
  assert.ok(isClose2D(AX, B));
});

test('solve: throws on singular', () => {
  const A = from([[1, 2], [2, 4]]);  // rank 1
  const b = from([1, 2]);
  assert.throws(() => solve(A, b), /singular/);
});

// ---------- det / inv (general LU-based) ----------

test('det: agrees with closed-form on 2/3/4', () => {
  const A2 = from([[1, 2], [3, 4]]);
  assert.ok(close(det(A2), det2(A2)));
  const A3 = from([[1, 2, 3], [4, 5, 6], [7, 8, 10]]);
  assert.ok(close(det(A3), det3(A3)));
  const A4 = from([
    [1, 0, 2, -1],
    [3, 0, 0,  5],
    [2, 1, 4, -3],
    [1, 0, 5,  0],
  ]);
  assert.ok(close(det(A4), det4(A4)));
});

test('det: returns 0 on singular matrix', () => {
  const A = from([[1, 2], [2, 4]]);
  assert.equal(det(A), 0);
});

test('inv: agrees with closed-form on 2/3/4', () => {
  const A2 = from([[1, 2], [3, 4]]);
  assert.ok(isClose2D(inv(A2), inv2(A2)));
  const A3 = from([[2, 1, 0], [1, 3, 1], [0, 1, 4]]);
  assert.ok(isClose2D(inv(A3), inv3(A3)));
  const A4 = from([
    [4, 1, 0, 0],
    [1, 4, 1, 0],
    [0, 1, 4, 1],
    [0, 0, 1, 4],
  ]);
  assert.ok(isClose2D(inv(A4), inv4(A4)));
});

test('inv: round-trip on a 5×5 matrix', () => {
  // Diagonally dominant 5×5
  const A = from([
    [5, 1, 0, 1, 0],
    [1, 6, 1, 0, 1],
    [0, 1, 7, 2, 0],
    [1, 0, 2, 5, 1],
    [0, 1, 0, 1, 4],
  ]);
  const Ai = inv(A);
  const I = matmul(A, Ai);
  assert.ok(isIdentity(I, 5, 1e-9));
});

// ---------- Cholesky ----------

test('cholesky: L L^T = A on a 2×2 SPD', () => {
  // A = [[4, 2], [2, 3]] is SPD.
  // L = [[2, 0], [1, sqrt(2)]]
  // L L^T = [[4, 2], [2, 1+2]] = [[4,2],[2,3]] ✓
  const A = from([[4, 2], [2, 3]]);
  const L = cholesky(A);
  assert.deepEqual(L.shape, [2, 2]);
  // Verify lower triangular.
  assert.equal(L.data[1], 0); // upper-right is zero
  // Verify L L^T = A.
  const Lt = transpose(L);
  const recon = matmul(L, Lt);
  assert.ok(isClose2D(recon, A));
});

test('cholesky: 4×4 SPD reconstruction', () => {
  // A diagonally dominant SPD.
  const A = from([
    [4, 1, 0, 0],
    [1, 4, 1, 0],
    [0, 1, 4, 1],
    [0, 0, 1, 4],
  ]);
  const L = cholesky(A);
  const recon = matmul(L, transpose(L));
  assert.ok(isClose2D(recon, A));
});

test('cholesky: throws on non-SPD', () => {
  // Negative on diagonal → not SPD.
  assert.throws(() => cholesky(from([[1, 2], [2, 1]])), /positive definite/);
  // All-zero matrix → not SPD.
  assert.throws(() => cholesky(zeros([3, 3])), /positive definite/);
});

test('solveCholesky: matches solve()', () => {
  const A = from([[4, 1, 0], [1, 4, 1], [0, 1, 4]]);
  const b = from([1, 2, 3]);
  const L = cholesky(A);
  const x_chol = solveCholesky(L, b);
  const x_lu = solve(A, b);
  assert.ok(arrClose(x_chol.data, x_lu.data));
});

// ---------- lstsq ----------

test('lstsq: square system matches solve', () => {
  const A = from([[2, 1], [1, 3]]);
  const b = from([5, 8]);
  const x_lstsq = lstsq(A, b);
  const x_solve = solve(A, b);
  assert.ok(arrClose(x_lstsq.data, x_solve.data));
});

test('lstsq: linear regression on noiseless points', () => {
  // Fit y = 2x + 3 to 5 points. A is design matrix [[x, 1], ...], b = [y].
  const xs = [0, 1, 2, 3, 4];
  const ys = xs.map(x => 2 * x + 3);
  const A = from(xs.flatMap(x => [x, 1]), [5, 2]);
  const b = from(ys);
  const beta = lstsq(A, b);
  // Should recover [slope=2, intercept=3].
  assert.ok(close(beta.data[0], 2));
  assert.ok(close(beta.data[1], 3));
});

test('lstsq: overdetermined 4×2 with redundant residual-free system', () => {
  // 4 equations, 2 unknowns. y = 1.5 x + 0.5 exactly.
  const xs = [1, 2, 3, 4];
  const ys = xs.map(x => 1.5 * x + 0.5);
  const A = from(xs.flatMap(x => [x, 1]), [4, 2]);
  const b = from(ys);
  const beta = lstsq(A, b);
  assert.ok(close(beta.data[0], 1.5));
  assert.ok(close(beta.data[1], 0.5));
});

// ---------- eigSym3 (Cardano) ----------

test('eigSym3: identity returns eigenvalues all 1', () => {
  const I = eye(3);
  const { values, vectors } = eigSym3(I);
  assert.ok(arrClose(values.data, [1, 1, 1]));
  // Eigenvectors form an orthonormal basis (any orthonormal triple works).
  const VVt = matmul(vectors, transpose(vectors));
  assert.ok(isIdentity(VVt, 3));
});

test('eigSym3: diagonal matrix recovers diagonal sorted descending', () => {
  const D = from([[2, 0, 0], [0, 5, 0], [0, 0, 1]]);
  const { values } = eigSym3(D);
  assert.ok(arrClose(values.data, [5, 2, 1]));
});

test('eigSym3: V diag(λ) V^T reconstructs A', () => {
  // Pick a non-trivial symmetric 3×3.
  const A = from([
    [4, 1, 2],
    [1, 5, 1],
    [2, 1, 3],
  ]);
  const { values, vectors } = eigSym3(A);
  // Build diag(λ).
  const D = zeros([3, 3]);
  D.set(0, 0, values.data[0]);
  D.set(1, 1, values.data[1]);
  D.set(2, 2, values.data[2]);
  const recon = matmul(matmul(vectors, D), transpose(vectors));
  assert.ok(isClose2D(recon, A, 1e-9), `eigSym3 reconstruction mismatch`);
});

test('eigSym3: A v = λ v for each eigenvector', () => {
  const A = from([
    [4, 1, 2],
    [1, 5, 1],
    [2, 1, 3],
  ]);
  const { values, vectors } = eigSym3(A);
  for (let k = 0; k < 3; k++) {
    const v = new Float64Array(3);
    for (let i = 0; i < 3; i++) v[i] = vectors.data[i * 3 + k];
    // A v
    const Av = new Float64Array(3);
    for (let i = 0; i < 3; i++) {
      let s = 0;
      for (let j = 0; j < 3; j++) s += A.data[i * 3 + j] * v[j];
      Av[i] = s;
    }
    const lam = values.data[k];
    for (let i = 0; i < 3; i++) {
      assert.ok(close(Av[i], lam * v[i], 1e-9), `eigSym3: A v != λ v at row ${i} for k=${k}`);
    }
  }
});

test('eigSym3: partial degeneracy (two equal eigenvalues, off-axis)', () => {
  // Build A = R diag(5, 5, 1) R^T for a non-trivial rotation R. Two
  // eigenvalues are 5 (eigenspace is a 2D plane), one is 1.
  const sq2 = Math.SQRT1_2;
  // Rotation by 45° about y-axis.
  const R = from([
    [ sq2, 0, sq2],
    [   0, 1,   0],
    [-sq2, 0, sq2],
  ]);
  const D = from([[5, 0, 0], [0, 5, 0], [0, 0, 1]]);
  const A = matmul(matmul(R, D), transpose(R));
  const { values, vectors } = eigSym3(A);
  // First two eigenvalues are 5; third is 1.
  assert.ok(close(values.data[0], 5, 1e-9));
  assert.ok(close(values.data[1], 5, 1e-9));
  assert.ok(close(values.data[2], 1, 1e-9));
  // Vectors must be orthonormal.
  const VVt = matmul(vectors, transpose(vectors));
  assert.ok(isIdentity(VVt, 3, 1e-9));
  // Reconstruction must hold even with degeneracy.
  const Drecon = zeros([3, 3]);
  Drecon.set(0, 0, values.data[0]);
  Drecon.set(1, 1, values.data[1]);
  Drecon.set(2, 2, values.data[2]);
  const recon = matmul(matmul(vectors, Drecon), transpose(vectors));
  assert.ok(isClose2D(recon, A, 1e-9));
});

test('eigSym3: stress-tensor case (geological)', () => {
  // Symmetric 3×3 modeling a stress tensor; principal stresses should be
  // sorted, eigenvectors orthonormal.
  const sigma = from([
    [10, 2, 0],
    [2, 8, 1],
    [0, 1, 6],
  ]);
  const { values, vectors } = eigSym3(sigma);
  // Eigenvalues should be sorted descending.
  assert.ok(values.data[0] >= values.data[1]);
  assert.ok(values.data[1] >= values.data[2]);
  // Vectors orthonormal.
  const VVt = matmul(vectors, transpose(vectors));
  assert.ok(isIdentity(VVt, 3, 1e-9));
});

// ---------- eigSym (Jacobi) ----------

test('eigSym: identity is identity', () => {
  const { values, vectors } = eigSym(eye(4));
  assert.ok(arrClose(values.data, [1, 1, 1, 1]));
  const VVt = matmul(vectors, transpose(vectors));
  assert.ok(isIdentity(VVt, 4));
});

test('eigSym: diagonal matrix', () => {
  const D = from([[3, 0, 0, 0], [0, 7, 0, 0], [0, 0, 2, 0], [0, 0, 0, 5]]);
  const { values } = eigSym(D);
  // sorted descending
  assert.ok(arrClose(values.data, [7, 5, 3, 2]));
});

test('eigSym: 4×4 symmetric reconstruction', () => {
  const A = from([
    [4, 1, 0, 1],
    [1, 5, 1, 0],
    [0, 1, 6, 2],
    [1, 0, 2, 7],
  ]);
  const { values, vectors } = eigSym(A);
  // sorted descending
  for (let i = 1; i < values.size; i++) {
    assert.ok(values.data[i - 1] >= values.data[i]);
  }
  // V V^T = I
  const VVt = matmul(vectors, transpose(vectors));
  assert.ok(isIdentity(VVt, 4, 1e-9));
  // Reconstruction
  const D = zeros([4, 4]);
  for (let i = 0; i < 4; i++) D.set(i, i, values.data[i]);
  const recon = matmul(matmul(vectors, D), transpose(vectors));
  assert.ok(isClose2D(recon, A, 1e-9));
});

test('eigSym: agrees with eigSym3 on a 3×3', () => {
  const A = from([
    [4, 1, 2],
    [1, 5, 1],
    [2, 1, 3],
  ]);
  const e3 = eigSym3(A);
  const e = eigSym(A);
  // Eigenvalues should match (both sorted descending).
  assert.ok(arrClose(e3.values.data, e.values.data, 1e-9));
});

test('eigSym: 6×6 SPD matrix', () => {
  // Build A = M^T M for a random 6×6 — guaranteed SPD with positive eigenvalues.
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646 - 0.5;
  };
  const M = new Float64Array(36);
  for (let i = 0; i < 36; i++) M[i] = rand();
  const Mnd = new NdArray(M, [6, 6]);
  const A = matmul(transpose(Mnd), Mnd);

  const { values, vectors } = eigSym(A);
  // All eigenvalues positive (well, non-negative; SPD).
  for (let i = 0; i < 6; i++) {
    assert.ok(values.data[i] >= -1e-10, `negative eigenvalue ${values.data[i]}`);
  }
  // Reconstruction.
  const D = zeros([6, 6]);
  for (let i = 0; i < 6; i++) D.set(i, i, values.data[i]);
  const recon = matmul(matmul(vectors, D), transpose(vectors));
  assert.ok(isClose2D(recon, A, 1e-8));
});
