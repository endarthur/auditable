// Tests for lstsq's three methods (normal, qr, svd).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { from, lstsq, matmul } from '../ext/line/index.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function maxAbs(xs) {
  let m = 0;
  for (const v of xs.data) if (Math.abs(v) > m) m = Math.abs(v);
  return m;
}

// Residual norm: ||Ax - b||
function residual(A, b, x) {
  const m = A.shape[0], n = A.shape[1];
  let r = 0;
  for (let i = 0; i < m; i++) {
    let row = 0;
    for (let j = 0; j < n; j++) row += A.data[i * n + j] * x.data[j];
    const d = row - b.data[i];
    r += d * d;
  }
  return Math.sqrt(r);
}

// ── all three methods agree on well-conditioned problems ─────────────

test('lstsq: qr matches normal on well-conditioned problem', () => {
  // Synthetic 5×2 with known least-squares solution
  const A = from([
    [1, 1],
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 5],
  ]);
  // Exact solution: x = [a, b], y = a + b*t. Use a=2, b=0.5.
  // Add small noise to ensure proper least-squares (not exact fit)
  const b = from([2.51, 3.0, 3.5, 4.0, 4.49]);
  const xN = lstsq(A, b, { method: 'normal' });
  const xQ = lstsq(A, b, { method: 'qr' });
  const xS = lstsq(A, b, { method: 'svd' });
  // All three should agree
  assert.ok(close(xN.data[0], xQ.data[0], 1e-9));
  assert.ok(close(xN.data[1], xQ.data[1], 1e-9));
  assert.ok(close(xN.data[0], xS.data[0], 1e-9));
  assert.ok(close(xN.data[1], xS.data[1], 1e-9));
  // And close to the true coefficients
  assert.ok(close(xQ.data[0], 2, 0.02));
  assert.ok(close(xQ.data[1], 0.5, 0.01));
});

test('lstsq: default method is qr', () => {
  const A = from([[1, 1], [1, 2], [1, 3]]);
  const b = from([1.1, 1.9, 3.05]);
  const xDefault = lstsq(A, b);
  const xQR = lstsq(A, b, { method: 'qr' });
  for (let i = 0; i < xDefault.size; i++) {
    assert.ok(close(xDefault.data[i], xQR.data[i], 1e-12));
  }
});

// ── QR is more accurate than normal for ill-conditioned A ────────────

test('lstsq: qr is more accurate than normal on ill-conditioned design', () => {
  // Hilbert-like design — notoriously ill-conditioned
  const m = 8, n = 5;
  const Adata = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      Adata[i * n + j] = 1 / (i + j + 1);  // Hilbert pattern
    }
  }
  const A = from(Adata, [m, n]);
  // True x = [1, 2, 3, 4, 5]
  const xTrue = from([1, 2, 3, 4, 5]);
  // b = A x
  const b = matmul(A, from([[1], [2], [3], [4], [5]]));
  // Flatten b
  const bVec = from(Array.from(b.data));

  const xN = lstsq(A, bVec, { method: 'normal' });
  const xQ = lstsq(A, bVec, { method: 'qr' });

  // Residual to true x
  let errN = 0, errQ = 0;
  for (let i = 0; i < n; i++) {
    errN += (xN.data[i] - xTrue.data[i]) ** 2;
    errQ += (xQ.data[i] - xTrue.data[i]) ** 2;
  }
  errN = Math.sqrt(errN);
  errQ = Math.sqrt(errQ);
  // QR should be at least as accurate (often dramatically more so)
  assert.ok(errQ <= errN + 1e-9,
    `QR not as accurate as normal: errQR=${errQ}, errN=${errN}`);
});

// ── SVD handles rank-deficient ──────────────────────────────────────

test('lstsq svd: handles rank-deficient A by returning minimum-norm solution', () => {
  // Rank-1 A — column 2 = 2 × column 1
  const A = from([
    [1, 2],
    [2, 4],
    [3, 6],
  ]);
  const b = from([1, 2, 3]);  // exactly in column space
  // Normal would fail with cholesky on the singular AᵀA.
  // SVD returns the minimum-norm solution.
  const xS = lstsq(A, b, { method: 'svd' });
  // Verify residual is ~0 (b is in col-space of A)
  const r = residual(A, b, xS);
  assert.ok(r < 1e-9, `expected zero residual, got ${r}`);
});

test('lstsq svd: rank-deficient gives smallest-norm x', () => {
  // For an underdetermined-in-effective-rank problem, SVD picks the
  // minimum-norm x. Verify by comparing to a particular solution.
  const A = from([
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  // True solution lies on x_0 + x_1 = const. Particular sol: x=[const, 0].
  // Min-norm sol: x_0 = x_1 = const/2.
  const b = from([2, 4, 6]);  // b = 2 (col1 + col2) → const = 2
  const xS = lstsq(A, b, { method: 'svd' });
  // Min norm: x = [1, 1]
  assert.ok(close(xS.data[0], 1, 1e-9));
  assert.ok(close(xS.data[1], 1, 1e-9));
});

// ── basic round-trip checks ─────────────────────────────────────────

test('lstsq qr: small residual for exact fit', () => {
  // Square system with exact solution
  const A = from([[3, 1], [1, 2]]);
  const b = from([9, 8]);
  // True x = [2, 3]
  const x = lstsq(A, b, { method: 'qr' });
  assert.ok(close(x.data[0], 2, 1e-12));
  assert.ok(close(x.data[1], 3, 1e-12));
});

test('lstsq svd: small residual for exact fit', () => {
  const A = from([[3, 1], [1, 2]]);
  const b = from([9, 8]);
  const x = lstsq(A, b, { method: 'svd' });
  assert.ok(close(x.data[0], 2, 1e-9));
  assert.ok(close(x.data[1], 3, 1e-9));
});

test('lstsq: rejects unknown method', () => {
  const A = from([[1, 2], [3, 4]]);
  const b = from([1, 2]);
  assert.throws(() => lstsq(A, b, { method: 'cholesky' }));
});
