// Experiment: K-loop unrolling on top of the 2x2 microkernel.
// Hypothesis: 4x unroll lets independent FMA chains overlap, hiding
// FMA latency and reducing loop overhead. Should win at large N where
// the inner k-loop runs many times.

import { atra } from '../ext/atra/index.js';

const memory = new WebAssembly.Memory({ initial: 1024, maximum: 16384 });
const mod = atra({ __memory: memory })`
  ! Baseline: current production microkernel (no unroll).
  subroutine dgemm_micro(
    a: array f64; b: array f64; c: array f64;
    m, n, k: i32; alpha: f64
  )
  var
    i, j, p, m_main, n_main: i32
    c_row0, c_row1, b_row: i32
    a0, a1: f64
    av0, av1, vb0, vb1, c00, c01, c10, c11: f64x2
  begin
    for i := 0, m
      for j := 0, n
        c[i, n, j] := 0.0
      end for
    end for
    m_main := (m / 2) * 2
    n_main := (n / 4) * 4
    for i := 0, m_main, 2
      c_row0 := i * n * 8
      c_row1 := (i + 1) * n * 8
      for j := 0, n_main, 4
        c00 := f64x2.splat(0.0)
        c01 := f64x2.splat(0.0)
        c10 := f64x2.splat(0.0)
        c11 := f64x2.splat(0.0)
        for p := 0, k
          a0 := alpha * a[i, k, p]
          a1 := alpha * a[i + 1, k, p]
          av0 := f64x2.splat(a0)
          av1 := f64x2.splat(a1)
          b_row := p * n * 8
          vb0 := v128.load_at(b, b_row + j * 8)
          vb1 := v128.load_at(b, b_row + j * 8 + 16)
          c00 := f64x2.relaxed_madd(av0, vb0, c00)
          c01 := f64x2.relaxed_madd(av0, vb1, c01)
          c10 := f64x2.relaxed_madd(av1, vb0, c10)
          c11 := f64x2.relaxed_madd(av1, vb1, c11)
        end for
        call v128.store_at(c, c_row0 + j * 8, c00)
        call v128.store_at(c, c_row0 + j * 8 + 16, c01)
        call v128.store_at(c, c_row1 + j * 8, c10)
        call v128.store_at(c, c_row1 + j * 8 + 16, c11)
      end for
    end for
  end

  ! Same microkernel but k-loop unrolled 4x. Each unrolled block does
  ! 4 successive p iterations, increasing in-flight FMAs from 4 to 16.
  ! Requires k % 4 == 0; scalar tail for non-multiples.
  subroutine dgemm_micro_u4(
    a: array f64; b: array f64; c: array f64;
    m, n, k: i32; alpha: f64
  )
  var
    i, j, p, m_main, n_main, k_main: i32
    c_row0, c_row1, b_row0, b_row1, b_row2, b_row3: i32
    a0_0, a1_0, a0_1, a1_1, a0_2, a1_2, a0_3, a1_3: f64
    av0_0, av1_0, av0_1, av1_1, av0_2, av1_2, av0_3, av1_3: f64x2
    vb0_0, vb1_0, vb0_1, vb1_1, vb0_2, vb1_2, vb0_3, vb1_3: f64x2
    c00, c01, c10, c11: f64x2
  begin
    for i := 0, m
      for j := 0, n
        c[i, n, j] := 0.0
      end for
    end for
    m_main := (m / 2) * 2
    n_main := (n / 4) * 4
    k_main := (k / 4) * 4
    for i := 0, m_main, 2
      c_row0 := i * n * 8
      c_row1 := (i + 1) * n * 8
      for j := 0, n_main, 4
        c00 := f64x2.splat(0.0)
        c01 := f64x2.splat(0.0)
        c10 := f64x2.splat(0.0)
        c11 := f64x2.splat(0.0)
        ! Unrolled main loop
        for p := 0, k_main, 4
          a0_0 := alpha * a[i, k, p + 0]
          a1_0 := alpha * a[i + 1, k, p + 0]
          a0_1 := alpha * a[i, k, p + 1]
          a1_1 := alpha * a[i + 1, k, p + 1]
          a0_2 := alpha * a[i, k, p + 2]
          a1_2 := alpha * a[i + 1, k, p + 2]
          a0_3 := alpha * a[i, k, p + 3]
          a1_3 := alpha * a[i + 1, k, p + 3]
          av0_0 := f64x2.splat(a0_0)
          av1_0 := f64x2.splat(a1_0)
          av0_1 := f64x2.splat(a0_1)
          av1_1 := f64x2.splat(a1_1)
          av0_2 := f64x2.splat(a0_2)
          av1_2 := f64x2.splat(a1_2)
          av0_3 := f64x2.splat(a0_3)
          av1_3 := f64x2.splat(a1_3)
          b_row0 := (p + 0) * n * 8
          b_row1 := (p + 1) * n * 8
          b_row2 := (p + 2) * n * 8
          b_row3 := (p + 3) * n * 8
          vb0_0 := v128.load_at(b, b_row0 + j * 8)
          vb1_0 := v128.load_at(b, b_row0 + j * 8 + 16)
          vb0_1 := v128.load_at(b, b_row1 + j * 8)
          vb1_1 := v128.load_at(b, b_row1 + j * 8 + 16)
          vb0_2 := v128.load_at(b, b_row2 + j * 8)
          vb1_2 := v128.load_at(b, b_row2 + j * 8 + 16)
          vb0_3 := v128.load_at(b, b_row3 + j * 8)
          vb1_3 := v128.load_at(b, b_row3 + j * 8 + 16)
          c00 := f64x2.relaxed_madd(av0_0, vb0_0, c00)
          c01 := f64x2.relaxed_madd(av0_0, vb1_0, c01)
          c10 := f64x2.relaxed_madd(av1_0, vb0_0, c10)
          c11 := f64x2.relaxed_madd(av1_0, vb1_0, c11)
          c00 := f64x2.relaxed_madd(av0_1, vb0_1, c00)
          c01 := f64x2.relaxed_madd(av0_1, vb1_1, c01)
          c10 := f64x2.relaxed_madd(av1_1, vb0_1, c10)
          c11 := f64x2.relaxed_madd(av1_1, vb1_1, c11)
          c00 := f64x2.relaxed_madd(av0_2, vb0_2, c00)
          c01 := f64x2.relaxed_madd(av0_2, vb1_2, c01)
          c10 := f64x2.relaxed_madd(av1_2, vb0_2, c10)
          c11 := f64x2.relaxed_madd(av1_2, vb1_2, c11)
          c00 := f64x2.relaxed_madd(av0_3, vb0_3, c00)
          c01 := f64x2.relaxed_madd(av0_3, vb1_3, c01)
          c10 := f64x2.relaxed_madd(av1_3, vb0_3, c10)
          c11 := f64x2.relaxed_madd(av1_3, vb1_3, c11)
        end for
        ! Scalar tail for remaining k (k_main..k)
        for p := k_main, k
          a0_0 := alpha * a[i, k, p]
          a1_0 := alpha * a[i + 1, k, p]
          av0_0 := f64x2.splat(a0_0)
          av1_0 := f64x2.splat(a1_0)
          b_row0 := p * n * 8
          vb0_0 := v128.load_at(b, b_row0 + j * 8)
          vb1_0 := v128.load_at(b, b_row0 + j * 8 + 16)
          c00 := f64x2.relaxed_madd(av0_0, vb0_0, c00)
          c01 := f64x2.relaxed_madd(av0_0, vb1_0, c01)
          c10 := f64x2.relaxed_madd(av1_0, vb0_0, c10)
          c11 := f64x2.relaxed_madd(av1_0, vb1_0, c11)
        end for
        call v128.store_at(c, c_row0 + j * 8, c00)
        call v128.store_at(c, c_row0 + j * 8 + 16, c01)
        call v128.store_at(c, c_row1 + j * 8, c10)
        call v128.store_at(c, c_row1 + j * 8 + 16, c11)
      end for
    end for
  end
`;

const f64 = new Float64Array(memory.buffer);

function bench(N, runs) {
  console.log(`\n=== ${N}×${N} dgemm ===`);
  const aPtr = 0;
  const bPtr = N * N * 8;
  const c1Ptr = N * N * 16;
  const c2Ptr = N * N * 24;

  let s = 1;
  for (let i = 0; i < N * N; i++) {
    s = (s * 16807) % 2147483647;
    f64[(aPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
    s = (s * 16807) % 2147483647;
    f64[(bPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
  }

  // Correctness
  mod.dgemm_micro(aPtr, bPtr, c1Ptr, N, N, N, 1.0);
  mod.dgemm_micro_u4(aPtr, bPtr, c2Ptr, N, N, N, 1.0);
  let maxDiff = 0;
  for (let i = 0; i < N * N; i++) {
    const d = Math.abs(f64[(c1Ptr >> 3) + i] - f64[(c2Ptr >> 3) + i]);
    if (d > maxDiff) maxDiff = d;
  }
  if (maxDiff > 1e-9) {
    console.error(`  CORRECTNESS FAIL at N=${N}: max diff ${maxDiff}`);
    return;
  }

  function time(label, fn) {
    for (let i = 0; i < 3; i++) fn();
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) fn();
    const elapsed = performance.now() - t0;
    console.log(`  ${label.padEnd(40)}: ${(elapsed / runs).toFixed(4)} ms/run`);
    return elapsed / runs;
  }

  const t1 = time('microkernel (no unroll)', () =>
    mod.dgemm_micro(aPtr, bPtr, c1Ptr, N, N, N, 1.0));
  const t2 = time('microkernel + 4x k-unroll', () =>
    mod.dgemm_micro_u4(aPtr, bPtr, c2Ptr, N, N, N, 1.0));

  const ratio = t1 / t2;
  if (ratio > 1.05) {
    console.log(`  → unrolled wins by ${ratio.toFixed(2)}×`);
  } else if (ratio < 0.95) {
    console.log(`  → unrolled LOSES by ${(1/ratio).toFixed(2)}×`);
  } else {
    console.log(`  → essentially tied (${ratio.toFixed(2)}×)`);
  }
}

bench(50, 1000);
bench(100, 500);
bench(200, 100);
bench(500, 30);
