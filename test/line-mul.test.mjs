// Matrix multiplication, transpose, det/inv tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NdArray,
  from, eye, zeros,
  matmul, transpose,
  det2, det3, det4,
  inv2, inv3, inv4,
} from '../ext/line/src/index.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-10) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// Naive textbook matmul as reference for fuzz comparison.
function refMatmul(A, B) {
  const M = A.shape[0], K = A.shape[1], N = B.shape[1];
  const out = new Float64Array(M * N);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let k = 0; k < K; k++) s += A.data[i * K + k] * B.data[k * N + j];
      out[i * N + j] = s;
    }
  }
  return new NdArray(out, [M, N]);
}

// ---------- matmul ----------

test('matmul 2×2', () => {
  const A = from([[1, 2], [3, 4]]);
  const B = from([[5, 6], [7, 8]]);
  // [[19, 22], [43, 50]]
  const C = matmul(A, B);
  assert.deepEqual(C.shape, [2, 2]);
  assert.deepEqual(Array.from(C.data), [19, 22, 43, 50]);
});

test('matmul rectangular (2×3) × (3×2)', () => {
  const A = from([[1, 2, 3], [4, 5, 6]]);     // 2×3
  const B = from([[7, 8], [9, 10], [11, 12]]); // 3×2
  // C[0,0] = 1*7+2*9+3*11 = 58
  // C[0,1] = 1*8+2*10+3*12 = 64
  // C[1,0] = 4*7+5*9+6*11 = 139
  // C[1,1] = 4*8+5*10+6*12 = 154
  const C = matmul(A, B);
  assert.deepEqual(C.shape, [2, 2]);
  assert.deepEqual(Array.from(C.data), [58, 64, 139, 154]);
});

test('matmul: identity is identity', () => {
  const A = from([[1, 2, 3], [4, 5, 6]]);
  const I3 = eye(3);
  const C = matmul(A, I3);
  assert.ok(arrClose(C.data, A.data));
});

test('matmul rejects shape mismatch', () => {
  const A = from([[1, 2], [3, 4]]);   // 2×2
  const B = from([[1, 2, 3]]);        // 1×3
  assert.throws(() => matmul(A, B), /inner dim mismatch/);
});

test('matmul fuzz vs reference', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646 - 0.5;
  };
  const makeRand = (m, n) => {
    const data = new Float64Array(m * n);
    for (let i = 0; i < m * n; i++) data[i] = rand();
    return new NdArray(data, [m, n]);
  };
  const cases = [[2, 3, 4], [5, 5, 5], [10, 7, 3], [1, 8, 1], [4, 1, 6]];
  for (const [m, k, n] of cases) {
    const A = makeRand(m, k);
    const B = makeRand(k, n);
    const got = matmul(A, B);
    const ref = refMatmul(A, B);
    assert.ok(arrClose(got.data, ref.data), `matmul ${m}×${k} × ${k}×${n} mismatch`);
  }
});

// ---------- transpose ----------

test('transpose 2×3 → 3×2', () => {
  const A = from([[1, 2, 3], [4, 5, 6]]);
  const T = transpose(A);
  assert.deepEqual(T.shape, [3, 2]);
  assert.deepEqual(Array.from(T.data), [1, 4, 2, 5, 3, 6]);
});

test('transpose involution: T(T(A)) = A', () => {
  const A = from([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
  const TT = transpose(transpose(A));
  assert.deepEqual(TT.shape, A.shape);
  assert.deepEqual(Array.from(TT.data), Array.from(A.data));
});

test('transpose square', () => {
  const A = from([[1, 2], [3, 4]]);
  const T = transpose(A);
  assert.deepEqual(Array.from(T.data), [1, 3, 2, 4]);
});

// ---------- determinants ----------

test('det2', () => {
  // |1 2| = 1*4 - 2*3 = -2
  // |3 4|
  assert.equal(det2(from([[1, 2], [3, 4]])), -2);
  // |2 0| = 6
  // |0 3|
  assert.equal(det2(from([[2, 0], [0, 3]])), 6);
  // singular
  assert.equal(det2(from([[1, 2], [2, 4]])), 0);
});

test('det3 vs cofactor expansion of known matrix', () => {
  // |6 1 1|
  // |4 -2 5|  → det = 6*(-2*-2 - 5*8) - 1*(4*-2 - 5*0) + 1*(4*8 - -2*0) = 6*(4-40) - 1*(-8) + 1*(32) = -216 + 8 + 32 = -176
  // |2 8 7|... wait, let me make a clearer example.
  // I'll just use a known result: det of identity = 1.
  assert.equal(det3(eye(3)), 1);
  // Diagonal 2,3,4 → det = 24
  const D = from([[2, 0, 0], [0, 3, 0], [0, 0, 4]]);
  assert.equal(det3(D), 24);
  // Upper triangular:
  // |1 2 3|
  // |0 4 5| → det = 1*4*6 = 24
  // |0 0 6|
  const U = from([[1, 2, 3], [0, 4, 5], [0, 0, 6]]);
  assert.ok(close(det3(U), 24));
});

test('det4: identity, diagonal, upper-triangular', () => {
  assert.ok(close(det4(eye(4)), 1));
  // Diagonal 1,2,3,4 → det = 24
  const D = from([[1, 0, 0, 0], [0, 2, 0, 0], [0, 0, 3, 0], [0, 0, 0, 4]]);
  assert.ok(close(det4(D), 24));
  // Upper triangular: det = product of diagonal
  const U = from([
    [2, 1, 1, 1],
    [0, 3, 1, 1],
    [0, 0, 4, 1],
    [0, 0, 0, 5],
  ]);
  assert.ok(close(det4(U), 2 * 3 * 4 * 5));
});

test('det4: known result vs hand calc', () => {
  // A 4×4 matrix with known determinant 24.
  // | 1 0 2 -1 |
  // | 3 0 0  5 |
  // | 2 1 4 -3 |
  // | 1 0 5  0 |
  // (Verified via Wolfram: det = 30)
  const A = from([
    [1, 0, 2, -1],
    [3, 0, 0,  5],
    [2, 1, 4, -3],
    [1, 0, 5,  0],
  ]);
  assert.ok(close(det4(A), 30), `det4 = ${det4(A)}, expected 30`);
});

test('det rejects non-square or wrong-size', () => {
  assert.throws(() => det2(from([[1, 2, 3], [4, 5, 6]])), /det2 requires/);
  assert.throws(() => det3(from([[1, 2], [3, 4]])), /det3 requires/);
});

// ---------- inverses ----------

function isIdentity(M, n, tol = 1e-9) {
  if (M.shape[0] !== n || M.shape[1] !== n) return false;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const expected = i === j ? 1 : 0;
      if (!close(M.data[i * n + j], expected, tol)) return false;
    }
  }
  return true;
}

test('inv2: round-trip A · inv(A) = I', () => {
  const A = from([[4, 7], [2, 6]]);
  const Ai = inv2(A);
  const I = matmul(A, Ai);
  assert.ok(isIdentity(I, 2));
});

test('inv2: known result', () => {
  // inv([[1,2],[3,4]]) = (1/-2) * [[4,-2],[-3,1]] = [[-2,1],[1.5,-0.5]]
  const A = from([[1, 2], [3, 4]]);
  const Ai = inv2(A);
  assert.ok(arrClose(Ai.data, [-2, 1, 1.5, -0.5]));
});

test('inv2 throws on singular', () => {
  assert.throws(() => inv2(from([[1, 2], [2, 4]])), /singular/);
});

test('inv3: round-trip on random invertible matrix', () => {
  // Construct A as eye(3) plus small perturbation
  const A = from([[2, 1, 0], [1, 3, 1], [0, 1, 4]]);
  const Ai = inv3(A);
  const I = matmul(A, Ai);
  assert.ok(isIdentity(I, 3, 1e-10));
});

test('inv3: identity is identity', () => {
  const I = eye(3);
  const Ii = inv3(I);
  assert.ok(arrClose(Ii.data, I.data, 1e-12));
});

test('inv3 throws on singular', () => {
  // Last row is sum of first two → singular.
  assert.throws(() => inv3(from([[1, 2, 3], [4, 5, 6], [5, 7, 9]])), /singular/);
});

test('inv4: identity is identity', () => {
  const I = eye(4);
  const Ii = inv4(I);
  assert.ok(arrClose(Ii.data, I.data, 1e-12));
});

test('inv4: round-trip on a non-trivial matrix', () => {
  // Diagonally dominant — well-conditioned.
  const A = from([
    [4, 1, 0, 0],
    [1, 4, 1, 0],
    [0, 1, 4, 1],
    [0, 0, 1, 4],
  ]);
  const Ai = inv4(A);
  const I = matmul(A, Ai);
  assert.ok(isIdentity(I, 4, 1e-10));
});

test('inv4: round-trip on a random-looking matrix', () => {
  const A = from([
    [1,  2, -1,  3],
    [0, -2,  1,  4],
    [3,  1,  0, -1],
    [2, -3,  1,  2],
  ]);
  const Ai = inv4(A);
  const I = matmul(A, Ai);
  assert.ok(isIdentity(I, 4, 1e-9));
  const I2 = matmul(Ai, A);
  assert.ok(isIdentity(I2, 4, 1e-9));
});

test('inv4 throws on singular', () => {
  // Row 3 = row 0 + row 1 → singular
  const S = from([
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [1, 1, 1, 1],
    [6, 8, 10, 12],
  ]);
  assert.throws(() => inv4(S), /singular/);
});
