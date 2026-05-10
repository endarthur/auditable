// QR and SVD tests for @gcu/line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  from, zeros, eye,
  matmul, transpose,
  qr, svd, pinv, matrix_rank, norm,
} from '../ext/line/index.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function maxAbsDiff(A, B) {
  let m = 0;
  for (let i = 0; i < A.data.length; i++) {
    const d = Math.abs(A.data[i] - B.data[i]);
    if (d > m) m = d;
  }
  return m;
}

// ── QR ────────────────────────────────────────────────────────────

test('qr: 3×3 identity', () => {
  const A = eye(3);
  const { Q, R } = qr(A);
  // Q is identity, R is identity for I = I·I
  assert.equal(Q.shape[0], 3);
  assert.equal(Q.shape[1], 3);
  assert.equal(R.shape[0], 3);
  assert.equal(R.shape[1], 3);
  // QR should equal A
  const recon = matmul(Q, R);
  assert.ok(maxAbsDiff(recon, A) < 1e-12);
});

test('qr: 4×3 random — A = QR', () => {
  // Synthetic A
  const A = from([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 10],
    [2, 1, 4],
  ]);
  const { Q, R } = qr(A);
  // Q shape m × k = 4 × 3 (thin)
  assert.deepEqual([Q.shape[0], Q.shape[1]], [4, 3]);
  assert.deepEqual([R.shape[0], R.shape[1]], [3, 3]);
  // QR ≈ A
  const recon = matmul(Q, R);
  assert.ok(maxAbsDiff(recon, A) < 1e-10, `A != QR: ${maxAbsDiff(recon, A)}`);
});

test('qr: Q has orthonormal columns', () => {
  const A = from([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 10],
    [2, 1, 4],
  ]);
  const { Q } = qr(A);
  // QᵀQ ≈ I_k
  const QtQ = matmul(transpose(Q), Q);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const expected = i === j ? 1 : 0;
      assert.ok(Math.abs(QtQ.data[i * 3 + j] - expected) < 1e-10,
        `QᵀQ[${i},${j}] = ${QtQ.data[i * 3 + j]}`);
    }
  }
});

test('qr: R is upper triangular', () => {
  const A = from([[1, 2], [3, 4], [5, 6]]);
  const { R } = qr(A);
  // Below diagonal should be ~0
  for (let i = 1; i < R.shape[0]; i++) {
    for (let j = 0; j < i; j++) {
      assert.ok(Math.abs(R.data[i * R.shape[1] + j]) < 1e-10,
        `R[${i},${j}] = ${R.data[i * R.shape[1] + j]}`);
    }
  }
});

test('qr: full mode returns m×m Q', () => {
  const A = from([[1, 2], [3, 4], [5, 6]]);
  const { Q, R } = qr(A, { mode: 'full' });
  assert.deepEqual([Q.shape[0], Q.shape[1]], [3, 3]);
  assert.deepEqual([R.shape[0], R.shape[1]], [3, 2]);
  // Q orthogonal
  const QtQ = matmul(transpose(Q), Q);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const expected = i === j ? 1 : 0;
      assert.ok(Math.abs(QtQ.data[i * 3 + j] - expected) < 1e-10);
    }
  }
});

// ── SVD ────────────────────────────────────────────────────────────

test('svd: 3×3 identity', () => {
  const A = eye(3);
  const { U, s, V } = svd(A);
  // singular values are 1, 1, 1
  for (let i = 0; i < 3; i++) {
    assert.ok(close(s.data[i], 1, 1e-12), `s[${i}] = ${s.data[i]}`);
  }
});

test('svd: diagonal matrix yields its diagonal as singular values', () => {
  const A = from([
    [3, 0, 0],
    [0, 1, 0],
    [0, 0, 2],
  ]);
  const { s } = svd(A);
  // Sorted descending: 3, 2, 1
  assert.ok(close(s.data[0], 3, 1e-10));
  assert.ok(close(s.data[1], 2, 1e-10));
  assert.ok(close(s.data[2], 1, 1e-10));
});

test('svd: round-trip A = U·diag(s)·Vᵀ on 4×3', () => {
  const A = from([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 10],
    [2, 1, 4],
  ]);
  const { U, s, V } = svd(A);
  assert.deepEqual([U.shape[0], U.shape[1]], [4, 3]);
  assert.deepEqual([s.shape[0]], [3]);
  assert.deepEqual([V.shape[0], V.shape[1]], [3, 3]);
  // Build U @ diag(s) explicitly
  const us = zeros([4, 3]);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) us.data[i * 3 + j] = U.data[i * 3 + j] * s.data[j];
  }
  const recon = matmul(us, transpose(V));
  assert.ok(maxAbsDiff(recon, A) < 1e-10,
    `round-trip error = ${maxAbsDiff(recon, A)}`);
});

test('svd: U has orthonormal columns', () => {
  const A = from([[1, 2, 3], [4, 5, 6], [7, 8, 10], [2, 1, 4]]);
  const { U } = svd(A);
  const UtU = matmul(transpose(U), U);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const expected = i === j ? 1 : 0;
      assert.ok(Math.abs(UtU.data[i * 3 + j] - expected) < 1e-10);
    }
  }
});

test('svd: V is orthogonal', () => {
  const A = from([[1, 2, 3], [4, 5, 6], [7, 8, 10], [2, 1, 4]]);
  const { V } = svd(A);
  const VtV = matmul(transpose(V), V);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const expected = i === j ? 1 : 0;
      assert.ok(Math.abs(VtV.data[i * 3 + j] - expected) < 1e-10);
    }
  }
});

test('svd: singular values sorted descending', () => {
  const A = from([[3, 1, 4, 1], [5, 9, 2, 6], [5, 3, 5, 8]]);
  const { s } = svd(A);
  for (let i = 1; i < s.shape[0]; i++) {
    assert.ok(s.data[i] <= s.data[i - 1] + 1e-12,
      `s[${i}]=${s.data[i]} > s[${i-1}]=${s.data[i - 1]}`);
  }
});

test('svd: handles m < n via transpose', () => {
  // 2×4 matrix
  const A = from([
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  const { U, s, V } = svd(A);
  assert.deepEqual([U.shape[0], U.shape[1]], [2, 2]);
  assert.deepEqual([s.shape[0]], [2]);
  assert.deepEqual([V.shape[0], V.shape[1]], [4, 2]);
  // Round-trip
  const us = zeros([2, 2]);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) us.data[i * 2 + j] = U.data[i * 2 + j] * s.data[j];
  }
  const recon = matmul(us, transpose(V));
  assert.ok(maxAbsDiff(recon, A) < 1e-10);
});

test('svd: rank-deficient matrix has correct number of zero singular values', () => {
  // Rank-2 matrix (third column = 2× first + second)
  const A = from([
    [1, 2, 4],
    [3, 4, 10],
    [5, 6, 16],
  ]);
  const { s } = svd(A);
  // Two non-zero σ, one near-zero
  assert.ok(s.data[2] < 1e-9, `expected near-zero σ_2, got ${s.data[2]}`);
  assert.ok(s.data[1] > 0.1);
});

// ── pinv ────────────────────────────────────────────────────────────

test('pinv: square invertible matrix matches inv', () => {
  const A = from([[4, 3], [6, 3]]);
  const Ai = pinv(A);
  // A @ A⁺ ≈ I
  const I = matmul(A, Ai);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const expected = i === j ? 1 : 0;
      assert.ok(Math.abs(I.data[i * 2 + j] - expected) < 1e-10);
    }
  }
});

test('pinv: tall matrix gives least-squares left-inverse', () => {
  // A is 4×2; A⁺ @ A ≈ I_2
  const A = from([[1, 2], [3, 4], [5, 6], [7, 8]]);
  const Ap = pinv(A);
  assert.deepEqual([Ap.shape[0], Ap.shape[1]], [2, 4]);
  const I = matmul(Ap, A);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const expected = i === j ? 1 : 0;
      assert.ok(Math.abs(I.data[i * 2 + j] - expected) < 1e-10);
    }
  }
});

// ── matrix_rank ─────────────────────────────────────────────────────

test('matrix_rank: full-rank 3×3', () => {
  // Use a matrix with non-zero determinant (the previous example had
  // det = 0 — row3 = row1 + 2*row2 had been pretending to be full-rank)
  const A = from([[1, 2, 3], [0, 1, 4], [5, 6, 0]]);
  assert.equal(matrix_rank(A), 3);
});

test('matrix_rank: rank-2 3×3', () => {
  const A = from([[1, 2, 4], [3, 4, 10], [5, 6, 16]]);
  assert.equal(matrix_rank(A), 2);
});

test('matrix_rank: rank-1 3×2', () => {
  const A = from([[1, 2], [2, 4], [3, 6]]);
  assert.equal(matrix_rank(A), 1);
});
