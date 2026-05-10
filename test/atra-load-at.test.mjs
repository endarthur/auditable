// Verify v128.load_at / v128.store_at byte-offset addressing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { atra } from '../ext/atra/index.js';

test('v128.load_at / store_at — basic round-trip on 16-byte boundary', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const mod = atra({ __memory: memory })`
    subroutine copy_4_f64(src: array f64; dst: array f64)
    var
      v0, v1: f64x2
    begin
      v0 := v128.load_at(src, 0)
      v1 := v128.load_at(src, 16)
      call v128.store_at(dst, 0, v0)
      call v128.store_at(dst, 16, v1)
    end
  `;
  const f64 = new Float64Array(memory.buffer);
  for (let i = 0; i < 4; i++) f64[i] = i + 1;            // src = [1,2,3,4]
  for (let i = 0; i < 4; i++) f64[8 + i] = -1;
  mod.copy_4_f64(0, 64);                                  // src ptr=0, dst ptr=64
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(f64[8 + i], i + 1, `dst[${i}]`);
  }
});

test('v128.load_at — non-16-byte-aligned byte offset (multiple of 8)', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const mod = atra({ __memory: memory })`
    subroutine copy_offset(src: array f64; dst: array f64)
    var
      v0, v1: f64x2
    begin
      v0 := v128.load_at(src, 8)
      v1 := v128.load_at(src, 24)
      call v128.store_at(dst, 0, v0)
      call v128.store_at(dst, 16, v1)
    end
  `;
  const f64 = new Float64Array(memory.buffer);
  for (let i = 0; i < 5; i++) f64[i] = (i + 1) * 10;       // src = [10,20,30,40,50]
  for (let i = 0; i < 4; i++) f64[8 + i] = 0;
  mod.copy_offset(0, 64);
  // dst should be src[1..4] = [20, 30, 40, 50]
  assert.deepStrictEqual(
    Array.from(f64.subarray(8, 12)),
    [20, 30, 40, 50],
  );
});

test('SIMD daxpy on misaligned 2D row — proves load_at fixes the parity issue', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const mod = atra({ __memory: memory })`
    subroutine daxpy_at(
      x: array f64; y: array f64;
      x_off, y_off: i32; n: i32; alpha: f64
    )
    var
      i, n2: i32
      va, vx, vy: f64x2
    begin
      va := f64x2.splat(alpha)
      n2 := n / 2
      for i := 0, n2
        vx := v128.load_at(x, x_off + i * 16)
        vy := v128.load_at(y, y_off + i * 16)
        vy := f64x2.relaxed_madd(va, vx, vy)
        call v128.store_at(y, y_off + i * 16, vy)
      end for
    end
  `;
  const f64 = new Float64Array(memory.buffer);

  // 2D matrix with 7 columns (odd) → rows aren't 16-byte aligned.
  const N = 7;
  // Two rows of x, two rows of y. Lay them out manually.
  for (let p = 0; p < 2; p++) {
    for (let j = 0; j < N; j++) {
      f64[p * N + j] = p * 100 + j;
      f64[16 + p * N + j] = 1000 + p * 100 + j;
    }
  }
  // Update row 1 of y with 2.0 * row 1 of x. Row 1 of x is at f64-index 7,
  // byte offset 56 — multiple of 8 but NOT 16 (the "odd row" case).
  const xOff = 7 * 8;
  const yOff = 16 * 8 + 7 * 8;
  const n = 6;     // 6 elements (3 f64x2 chunks)
  mod.daxpy_at(0, 0, xOff, yOff, n, 2.0);

  // y[1, j] = (1000 + 100 + j) + 2.0 * (100 + j) = 1300 + 3j
  for (let j = 0; j < n; j++) {
    const got = f64[16 + 7 + j];
    const want = 1300 + 3 * j;
    assert.strictEqual(got, want, `y[1, ${j}] = ${got}, expected ${want}`);
  }
});
