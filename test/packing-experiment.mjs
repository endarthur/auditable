// Experiment: does packing B into a microkernel-friendly layout help
// at large N? And does it hurt small N?
//
// Layout strategy:
//   - Pack B's column-panel [0:k, jj:jj+NC] into scratch with the SAME
//     row-major order, so b_packed[p*NC + j_local] = B[p, jj + j_local].
//   - 2x2 microkernel reads from b_packed instead of b. Same load pattern,
//     just from a smaller, denser memory region.
//
// Why might this help when naive packing (without microkernel) didn't?
// With the microkernel, each (i, j_tile) processes a fixed (j..j+3) col
// slice across all k rows of B. We re-read this slice for every i value
// (m times). With packing, those m reads come from a cache-resident
// 16 KB chunk instead of striding through 2 MB of B.

import { atra } from '../ext/atra/index.js';

const memory = new WebAssembly.Memory({ initial: 1024, maximum: 16384 });
const mod = atra({ __memory: memory })`
  ! Current production dgemm (2x2 microkernel, no packing).
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

  ! Same microkernel but reads B from packed scratch instead of original.
  ! Pack a 32-col panel of B at a time; iterate microkernel over 8 j-tiles
  ! within the panel, all reading from cache-hot pack buffer.
  subroutine dgemm_micro_packed(
    a: array f64; b: array f64; c: array f64;
    m, n, k: i32; alpha: f64;
    pack: array f64
  )
  var
    i, j, p, jj, m_main, n_main: i32
    c_row0, c_row1, jbound, nblock, jrel: i32
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

    ! Iterate over column panels of B (NC = 32 cols at a time).
    for jj := 0, n_main, 32
      jbound := jj + 32
      if (jbound > n_main) then
        jbound := n_main
      end if
      nblock := jbound - jj

      ! Pack B columns jj..jbound into pack at row-major p*32 + j.
      ! Total: k * 32 f64 = 16 KB at k=500. Stays hot in L1 for the
      ! entire microkernel pass below.
      for p := 0, k
        for j := 0, nblock
          pack[p * 32 + j] := b[p, n, jj + j]
        end for
      end for

      ! Microkernel pass: for each (i, j) tile in this panel, process
      ! the full k contraction reading B from pack.
      for i := 0, m_main, 2
        c_row0 := i * n * 8
        c_row1 := (i + 1) * n * 8
        for j := 0, nblock, 4
          jrel := j     ! offset into pack row, in f64
          c00 := v128.load_at(c, c_row0 + (jj + j) * 8)
          c01 := v128.load_at(c, c_row0 + (jj + j) * 8 + 16)
          c10 := v128.load_at(c, c_row1 + (jj + j) * 8)
          c11 := v128.load_at(c, c_row1 + (jj + j) * 8 + 16)
          for p := 0, k
            a0 := alpha * a[i, k, p]
            a1 := alpha * a[i + 1, k, p]
            av0 := f64x2.splat(a0)
            av1 := f64x2.splat(a1)
            ! pack row p = pack[p*32 .. p*32 + 31], byte offset p*256
            vb0 := v128.load_at(pack, p * 256 + jrel * 8)
            vb1 := v128.load_at(pack, p * 256 + jrel * 8 + 16)
            c00 := f64x2.relaxed_madd(av0, vb0, c00)
            c01 := f64x2.relaxed_madd(av0, vb1, c01)
            c10 := f64x2.relaxed_madd(av1, vb0, c10)
            c11 := f64x2.relaxed_madd(av1, vb1, c11)
          end for
          call v128.store_at(c, c_row0 + (jj + j) * 8, c00)
          call v128.store_at(c, c_row0 + (jj + j) * 8 + 16, c01)
          call v128.store_at(c, c_row1 + (jj + j) * 8, c10)
          call v128.store_at(c, c_row1 + (jj + j) * 8 + 16, c11)
        end for
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
  const packPtr = N * N * 32;

  let s = 1;
  for (let i = 0; i < N * N; i++) {
    s = (s * 16807) % 2147483647;
    f64[(aPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
    s = (s * 16807) % 2147483647;
    f64[(bPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
  }

  // Correctness check
  mod.dgemm_micro(aPtr, bPtr, c1Ptr, N, N, N, 1.0);
  mod.dgemm_micro_packed(aPtr, bPtr, c2Ptr, N, N, N, 1.0, packPtr);
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

  const t1 = time('microkernel (no packing)', () =>
    mod.dgemm_micro(aPtr, bPtr, c1Ptr, N, N, N, 1.0));
  const t2 = time('microkernel + packed B (NC=32)', () =>
    mod.dgemm_micro_packed(aPtr, bPtr, c2Ptr, N, N, N, 1.0, packPtr));

  const ratio = t1 / t2;
  if (ratio > 1.05) {
    console.log(`  → packed wins by ${ratio.toFixed(2)}×`);
  } else if (ratio < 0.95) {
    console.log(`  → packed LOSES by ${(1/ratio).toFixed(2)}× (overhead exceeds benefit)`);
  } else {
    console.log(`  → essentially tied (${ratio.toFixed(2)}×)`);
  }
}

bench(50, 1000);
bench(100, 500);
bench(200, 100);
bench(500, 30);

console.log('\nReference at 500×500:');
console.log('  TF.js wasm f32 (where we want to land for f64): ~5 ms (×2 for f64) ≈ 10 ms');
console.log('  numpy ST f64 native:                              ~4.3 ms');
