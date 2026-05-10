// Tests for vector norms, matrix norms, cross, kron, matrix_power,
// solve_triangular.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  from, eye,
  vecNorm, matNorm, cross, kron, matrix_power, solve_triangular,
  matmul,
} from '../ext/line/index.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── vecNorm ─────────────────────────────────────────────────────────

test('vecNorm: default ord=2', () => {
  const x = from([3, 4]);
  assert.ok(close(vecNorm(x), 5));  // sqrt(9+16) = 5
});

test('vecNorm: ord=1', () => {
  const x = from([-3, 4, -5]);
  assert.ok(close(vecNorm(x, 1), 12));  // 3 + 4 + 5
});

test('vecNorm: ord=Infinity', () => {
  const x = from([1, -7, 3]);
  assert.ok(close(vecNorm(x, Infinity), 7));
});

test('vecNorm: ord=-Infinity', () => {
  const x = from([5, -2, 7]);
  assert.ok(close(vecNorm(x, -Infinity), 2));
});

test('vecNorm: p-norm (p=3)', () => {
  const x = from([1, 2, 2]);
  // (1+8+8)^(1/3) = 17^(1/3) ≈ 2.571
  assert.ok(close(vecNorm(x, 3), Math.pow(17, 1 / 3), 1e-10));
});

test('vecNorm: rejects 2D input', () => {
  const A = from([[1, 2], [3, 4]]);
  assert.throws(() => vecNorm(A));
});

// ── matNorm ─────────────────────────────────────────────────────────

test('matNorm: Frobenius (default)', () => {
  const A = from([[1, 2], [3, 4]]);
  // sqrt(1+4+9+16) = sqrt(30)
  assert.ok(close(matNorm(A), Math.sqrt(30)));
});

test('matNorm: induced 1-norm (max column sum)', () => {
  // Col sums of |a|: [1+3, 2+4] = [4, 6] → 6
  const A = from([[1, 2], [3, 4]]);
  assert.equal(matNorm(A, 1), 6);
});

test('matNorm: induced Infinity-norm (max row sum)', () => {
  const A = from([[1, 2], [3, 4]]);
  // Row sums: [3, 7] → 7
  assert.equal(matNorm(A, Infinity), 7);
});

test('matNorm: spectral (ord=2) — largest singular value', () => {
  // Diagonal matrix with values 1, 3, 2 → largest σ = 3
  const A = from([[1, 0, 0], [0, 3, 0], [0, 0, 2]]);
  assert.ok(close(matNorm(A, 2), 3, 1e-9));
});

test('matNorm: nuclear (sum of singular values)', () => {
  const A = from([[1, 0, 0], [0, 3, 0], [0, 0, 2]]);
  assert.ok(close(matNorm(A, 'nuc'), 6, 1e-9));
});

// ── cross ───────────────────────────────────────────────────────────

test('cross: orthogonal basis vectors', () => {
  const ex = from([1, 0, 0]);
  const ey = from([0, 1, 0]);
  const ez = cross(ex, ey);
  assert.equal(ez.data[0], 0);
  assert.equal(ez.data[1], 0);
  assert.equal(ez.data[2], 1);
});

test('cross: anti-commutative', () => {
  const a = from([1, 2, 3]);
  const b = from([4, 5, 6]);
  const ab = cross(a, b);
  const ba = cross(b, a);
  for (let i = 0; i < 3; i++) {
    assert.ok(close(ab.data[i], -ba.data[i], 1e-12));
  }
});

test('cross: orthogonal to both inputs', () => {
  const a = from([1, 2, 3]);
  const b = from([4, 5, 6]);
  const c = cross(a, b);
  // a · c should be 0
  let dotA = 0, dotB = 0;
  for (let i = 0; i < 3; i++) {
    dotA += a.data[i] * c.data[i];
    dotB += b.data[i] * c.data[i];
  }
  assert.ok(close(dotA, 0, 1e-12));
  assert.ok(close(dotB, 0, 1e-12));
});

test('cross: rejects non-3D vectors', () => {
  const a = from([1, 2]);
  const b = from([3, 4]);
  assert.throws(() => cross(a, b));
});

// ── kron ────────────────────────────────────────────────────────────

test('kron: 2×2 with 2×2', () => {
  const A = from([[1, 2], [3, 4]]);
  const B = from([[0, 5], [6, 7]]);
  const C = kron(A, B);
  // Expected 4×4:
  // [[1*0, 1*5, 2*0, 2*5],
  //  [1*6, 1*7, 2*6, 2*7],
  //  [3*0, 3*5, 4*0, 4*5],
  //  [3*6, 3*7, 4*6, 4*7]]
  // = [[0,5,0,10], [6,7,12,14], [0,15,0,20], [18,21,24,28]]
  assert.deepEqual([C.shape[0], C.shape[1]], [4, 4]);
  const expected = [0, 5, 0, 10, 6, 7, 12, 14, 0, 15, 0, 20, 18, 21, 24, 28];
  for (let i = 0; i < 16; i++) assert.equal(C.data[i], expected[i]);
});

test('kron: identity × A = block-diagonal A', () => {
  const I = eye(2);
  const A = from([[1, 2], [3, 4]]);
  const C = kron(I, A);
  // Expected: [[A, 0], [0, A]]
  assert.deepEqual([C.shape[0], C.shape[1]], [4, 4]);
  // Top-left A
  assert.equal(C.data[0], 1); assert.equal(C.data[1], 2);
  assert.equal(C.data[4], 3); assert.equal(C.data[5], 4);
  // Bottom-right A
  assert.equal(C.data[10], 1); assert.equal(C.data[11], 2);
  assert.equal(C.data[14], 3); assert.equal(C.data[15], 4);
  // Off-diagonal zero
  assert.equal(C.data[2], 0); assert.equal(C.data[3], 0);
});

test('kron: 1D × 1D yields 1D', () => {
  const a = from([1, 2]);
  const b = from([3, 4]);
  const c = kron(a, b);
  assert.equal(c.ndim, 1);
  assert.equal(c.size, 4);
  // [1*3, 1*4, 2*3, 2*4] = [3, 4, 6, 8]
  assert.deepEqual(Array.from(c.data), [3, 4, 6, 8]);
});

// ── matrix_power ────────────────────────────────────────────────────

test('matrix_power: A^0 = I', () => {
  const A = from([[2, 1], [1, 3]]);
  const I = matrix_power(A, 0);
  assert.equal(I.data[0], 1); assert.equal(I.data[1], 0);
  assert.equal(I.data[2], 0); assert.equal(I.data[3], 1);
});

test('matrix_power: A^1 = A', () => {
  const A = from([[2, 1], [1, 3]]);
  const A1 = matrix_power(A, 1);
  for (let i = 0; i < 4; i++) assert.equal(A1.data[i], A.data[i]);
});

test('matrix_power: A^2 = A·A', () => {
  const A = from([[2, 1], [1, 3]]);
  const A2 = matrix_power(A, 2);
  const A2_ref = matmul(A, A);
  for (let i = 0; i < 4; i++) {
    assert.ok(close(A2.data[i], A2_ref.data[i], 1e-10));
  }
});

test('matrix_power: A^5 via exponentiation-by-squaring', () => {
  const A = from([[1, 1], [0, 1]]);  // Pascal-style — A^k = [[1,k],[0,1]]
  const A5 = matrix_power(A, 5);
  assert.equal(A5.data[0], 1);
  assert.equal(A5.data[1], 5);
  assert.equal(A5.data[2], 0);
  assert.equal(A5.data[3], 1);
});

test('matrix_power: A^-1 equals inverse', () => {
  const A = from([[4, 0], [0, 2]]);
  const Ainv = matrix_power(A, -1);
  // diag(1/4, 1/2)
  assert.ok(close(Ainv.data[0], 0.25));
  assert.ok(close(Ainv.data[3], 0.5));
});

// ── solve_triangular ────────────────────────────────────────────────

test('solve_triangular: lower triangular forward substitution', () => {
  // L x = b where L = [[2,0],[3,4]], b = [4, 17]
  // First eq: 2x0 = 4 → x0 = 2
  // Second eq: 3·2 + 4x1 = 17 → 4x1 = 11 → x1 = 11/4
  const L = from([[2, 0], [3, 4]]);
  const b = from([4, 17]);
  const x = solve_triangular(L, b, { lower: true });
  assert.ok(close(x.data[0], 2));
  assert.ok(close(x.data[1], 11 / 4));
});

test('solve_triangular: upper triangular back substitution', () => {
  // U x = b where U = [[1,2],[0,3]], b = [5, 9]
  // x1 = 9/3 = 3; x0 + 2·3 = 5 → x0 = -1
  const U = from([[1, 2], [0, 3]]);
  const b = from([5, 9]);
  const x = solve_triangular(U, b, { lower: false });
  assert.ok(close(x.data[0], -1));
  assert.ok(close(x.data[1], 3));
});

test('solve_triangular: throws on zero diagonal', () => {
  const L = from([[0, 0], [1, 1]]);
  const b = from([1, 2]);
  assert.throws(() => solve_triangular(L, b, { lower: true }));
});
