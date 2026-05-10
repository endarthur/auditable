// Verify the new f32 alpack routines compute correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { all as alpackAllSrc } from '../ext/alpack/src.js';
import { atra } from '../ext/atra/index.js';

const memory = new WebAssembly.Memory({ initial: 64 });
const mod = atra({ __memory: memory })`${alpackAllSrc}`;
const f32 = new Float32Array(memory.buffer);
const f64 = new Float64Array(memory.buffer);
const i32 = new Int32Array(memory.buffer);

const close = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-5) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

test('saxpy: y := alpha * x + y', () => {
  const xPtr = 0, yPtr = 64;
  for (let i = 0; i < 8; i++) f32[(xPtr >> 2) + i] = i + 1;
  for (let i = 0; i < 8; i++) f32[(yPtr >> 2) + i] = 100;
  mod.alas.saxpy(xPtr, yPtr, 8, 2.0);
  // y[i] = 2*(i+1) + 100
  for (let i = 0; i < 8; i++) {
    assert.ok(close(f32[(yPtr >> 2) + i], 2 * (i + 1) + 100));
  }
});

test('sdot: x^T y', () => {
  const xPtr = 0, yPtr = 64;
  for (let i = 0; i < 7; i++) {
    f32[(xPtr >> 2) + i] = i + 1;        // [1,2,3,4,5,6,7]
    f32[(yPtr >> 2) + i] = (i + 1) * 10;  // [10,20,30,40,50,60,70]
  }
  // sum = 10 + 40 + 90 + 160 + 250 + 360 + 490 = 1400
  const r = mod.alas.sdot(xPtr, yPtr, 7);
  assert.ok(close(r, 1400));
});

test('snrm2: sqrt(sum x^2)', () => {
  const xPtr = 0;
  // [3, 4]: norm = 5
  f32[xPtr >> 2] = 3;
  f32[(xPtr >> 2) + 1] = 4;
  assert.ok(close(mod.alas.snrm2(xPtr, 2), 5));
});

test('sgemv: y := A * x (alpha=1, beta=0)', () => {
  const aPtr = 0, xPtr = 64, yPtr = 128;
  // A = [[1,2,3],[4,5,6]] (2x3)
  const A = [1, 2, 3, 4, 5, 6];
  for (let i = 0; i < 6; i++) f32[(aPtr >> 2) + i] = A[i];
  // x = [10, 20, 30]
  for (let i = 0; i < 3; i++) f32[(xPtr >> 2) + i] = (i + 1) * 10;
  // expect y = [1*10+2*20+3*30, 4*10+5*20+6*30] = [140, 320]
  mod.alas.sgemv(aPtr, xPtr, yPtr, 2, 3, 1.0, 0.0);
  assert.ok(close(f32[yPtr >> 2], 140));
  assert.ok(close(f32[(yPtr >> 2) + 1], 320));
});

test('sgemm: C := A * B', () => {
  const N = 4;
  const aPtr = 0, bPtr = N * N * 4, cPtr = N * N * 8;
  // A = identity, B = [[1..16]]; C = B
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    f32[(aPtr >> 2) + i * N + j] = (i === j) ? 1 : 0;
    f32[(bPtr >> 2) + i * N + j] = i * N + j + 1;
  }
  mod.alas.sgemm(aPtr, bPtr, cPtr, N, N, N, 1.0, 0.0);
  // C should equal B
  for (let i = 0; i < N * N; i++) {
    assert.ok(close(f32[(cPtr >> 2) + i], i + 1), `C[${i}] = ${f32[(cPtr >> 2) + i]}`);
  }
});

test('sgesv: solve A x = b', () => {
  const N = 4;
  const aPtr = 0, bPtr = N * N * 4, ipivPtr = bPtr + N * 4, infoPtr = ipivPtr + N * 4;
  // Diagonally dominant A
  const A = [
    4, 1, 0, 0,
    1, 4, 1, 0,
    0, 1, 4, 1,
    0, 0, 1, 4,
  ];
  for (let i = 0; i < 16; i++) f32[(aPtr >> 2) + i] = A[i];
  const b = [1, 2, 3, 4];
  for (let i = 0; i < 4; i++) f32[(bPtr >> 2) + i] = b[i];
  i32[ipivPtr >> 2] = 0;
  i32[infoPtr >> 2] = 0;
  mod.alpack.sgesv(aPtr, bPtr, N, 1, ipivPtr, infoPtr);
  assert.equal(i32[infoPtr >> 2], 0);
  // Verify A_orig · x = b
  const x = Array.from(f32.subarray(bPtr >> 2, (bPtr >> 2) + N));
  // Compute A_orig·x using fresh A:
  for (let i = 0; i < 4; i++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += A[i * 4 + j] * x[j];
    assert.ok(close(s, b[i], 1e-4), `row ${i}: A·x = ${s}, expected ${b[i]}`);
  }
});

test('sger: A := A + alpha * x * y^T', () => {
  const aPtr = 0, xPtr = 64, yPtr = 128;
  // A = zeros (2x3), x = [1, 2], y = [10, 20, 30]; alpha=1
  for (let i = 0; i < 6; i++) f32[(aPtr >> 2) + i] = 0;
  f32[(xPtr >> 2) + 0] = 1;
  f32[(xPtr >> 2) + 1] = 2;
  f32[(yPtr >> 2) + 0] = 10;
  f32[(yPtr >> 2) + 1] = 20;
  f32[(yPtr >> 2) + 2] = 30;
  mod.alas.sger(aPtr, xPtr, yPtr, 2, 3, 1.0);
  // expect A = [[10,20,30],[20,40,60]]
  const expected = [10, 20, 30, 20, 40, 60];
  for (let i = 0; i < 6; i++) {
    assert.ok(close(f32[(aPtr >> 2) + i], expected[i]));
  }
});
