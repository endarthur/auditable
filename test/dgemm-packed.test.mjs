// Verify alas.dgemm_packed produces correct results and bench it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { all as alpackAllSrc } from '../ext/alpack/src.js';
import { atra } from '../ext/atra/index.js';

const memory = new WebAssembly.Memory({ initial: 1024, maximum: 16384 });
const mod = atra({ __memory: memory })`${alpackAllSrc}`;
const f64 = new Float64Array(memory.buffer);

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('dgemm_packed: identity * B = B', () => {
  const N = 8;
  const aPtr = 0, bPtr = N * N * 8, cPtr = N * N * 16, packPtr = N * N * 24;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    f64[(aPtr >> 3) + i * N + j] = (i === j) ? 1 : 0;
    f64[(bPtr >> 3) + i * N + j] = i * N + j + 1;
  }
  mod.alas.dgemm_packed(aPtr, bPtr, cPtr, N, N, N, 1.0, 0.0, packPtr);
  for (let i = 0; i < N * N; i++) {
    assert.ok(close(f64[(cPtr >> 3) + i], i + 1), `C[${i}] = ${f64[(cPtr >> 3) + i]}`);
  }
});

test('dgemm_packed: matches dgemm output on random matrices', () => {
  const N = 17;  // odd N to exercise scalar tails
  const aPtr = 0, bPtr = N * N * 8, c1Ptr = N * N * 16, c2Ptr = N * N * 24, packPtr = N * N * 32;
  let s = 7;
  for (let i = 0; i < N * N; i++) {
    s = (s * 16807) % 2147483647;
    f64[(aPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
    s = (s * 16807) % 2147483647;
    f64[(bPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
  }
  mod.alas.dgemm(aPtr, bPtr, c1Ptr, N, N, N, 1.0, 0.0);
  mod.alas.dgemm_packed(aPtr, bPtr, c2Ptr, N, N, N, 1.0, 0.0, packPtr);
  for (let i = 0; i < N * N; i++) {
    assert.ok(
      close(f64[(c1Ptr >> 3) + i], f64[(c2Ptr >> 3) + i], 1e-10),
      `C[${i}]: dgemm=${f64[(c1Ptr >> 3) + i]} vs dgemm_packed=${f64[(c2Ptr >> 3) + i]}`,
    );
  }
});

test('dgemm_packed: matches dgemm on rectangular case', () => {
  // m=10, n=23, k=15
  const m = 10, n = 23, k = 15;
  const aPtr = 0;
  const bPtr = m * k * 8;
  const c1Ptr = bPtr + k * n * 8;
  const c2Ptr = c1Ptr + m * n * 8;
  const packPtr = c2Ptr + m * n * 8;
  let s = 11;
  for (let i = 0; i < m * k; i++) {
    s = (s * 16807) % 2147483647;
    f64[(aPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
  }
  for (let i = 0; i < k * n; i++) {
    s = (s * 16807) % 2147483647;
    f64[(bPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
  }
  mod.alas.dgemm(aPtr, bPtr, c1Ptr, m, n, k, 1.0, 0.0);
  mod.alas.dgemm_packed(aPtr, bPtr, c2Ptr, m, n, k, 1.0, 0.0, packPtr);
  for (let i = 0; i < m * n; i++) {
    assert.ok(
      close(f64[(c1Ptr >> 3) + i], f64[(c2Ptr >> 3) + i], 1e-10),
      `C[${i}]: dgemm=${f64[(c1Ptr >> 3) + i]} vs dgemm_packed=${f64[(c2Ptr >> 3) + i]}`,
    );
  }
});
