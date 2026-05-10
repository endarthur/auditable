// Experiment: does a 2x2 register-blocked microkernel close the gap to TF.js
// at 200x200 dgemm?
//
// The hypothesis: V8 will keep the 4 f64x2 accumulators in xmm registers
// across the inner p-loop, eliminating ~k store+load pairs per tile.
// At 200x200, that's 200 fewer L1 accesses per (i, j) microkernel pair,
// ~5000 microkernel pairs = 1M fewer L1 ops.
//
// 2x2 microkernel layout:
//   Process 2 rows of A x 4 cols of B x all-K contraction at once.
//   4 f64x2 accumulators:  c00 = C[i, j..j+1]      c01 = C[i, j+2..j+3]
//                          c10 = C[i+1, j..j+1]    c11 = C[i+1, j+2..j+3]
//   Per p: 2 a-loads + 2 b-loads + 4 FMAs.
//   At end of p-loop: 4 stores back to C.
//
// Bench at 200x200 only (divisible by 2 and 4 — no edge cases).

import { atra } from '../ext/atra/index.js';

const memory = new WebAssembly.Memory({ initial: 1024, maximum: 16384 });
const mod = atra({ __memory: memory })`
  ! Plain SIMD dgemm (the baseline alas.dgemm — duplicated here so we can
  ! bench against the microkernel without going through alpack imports).
  subroutine dgemm_baseline(
    a: array f64; b: array f64; c: array f64;
    m, n, k: i32; alpha, beta: f64
  )
  var
    i, j, p, n2, c_row, b_row, joff: i32
    t: f64
    tv, vb, vc: f64x2
  begin
    if (beta == 0.0) then
      for i := 0, m
        for j := 0, n
          c[i, n, j] := 0.0
        end for
      end for
    end if
    n2 := n / 2
    for i := 0, m
      c_row := i * n * 8
      for p := 0, k
        t := alpha * a[i, k, p]
        tv := f64x2.splat(t)
        b_row := p * n * 8
        for j := 0, n2
          joff := j * 16
          vb := v128.load_at(b, b_row + joff)
          vc := v128.load_at(c, c_row + joff)
          vc := f64x2.relaxed_madd(tv, vb, vc)
          call v128.store_at(c, c_row + joff, vc)
        end for
      end for
    end for
  end

  ! 4x4 microkernel: 4 rows x 8 cols (4 col-pairs of f64x2). 16 accumulators.
  ! V8 has 16 xmm registers — should fit if scheduled well. Assumes m % 4 == 0
  ! and n % 8 == 0.
  subroutine dgemm_micro4x4(
    a: array f64; b: array f64; c: array f64;
    m, n, k: i32; alpha: f64
  )
  var
    i, j, p, ic_row0, ic_row1, ic_row2, ic_row3, b_row: i32
    a0, a1, a2, a3: f64
    av0, av1, av2, av3: f64x2
    vb0, vb1, vb2, vb3: f64x2
    c00, c01, c02, c03: f64x2
    c10, c11, c12, c13: f64x2
    c20, c21, c22, c23: f64x2
    c30, c31, c32, c33: f64x2
  begin
    for i := 0, m
      for j := 0, n
        c[i, n, j] := 0.0
      end for
    end for

    for i := 0, m, 4
      ic_row0 := i * n * 8
      ic_row1 := (i + 1) * n * 8
      ic_row2 := (i + 2) * n * 8
      ic_row3 := (i + 3) * n * 8
      for j := 0, n, 8
        c00 := f64x2.splat(0.0)
        c01 := f64x2.splat(0.0)
        c02 := f64x2.splat(0.0)
        c03 := f64x2.splat(0.0)
        c10 := f64x2.splat(0.0)
        c11 := f64x2.splat(0.0)
        c12 := f64x2.splat(0.0)
        c13 := f64x2.splat(0.0)
        c20 := f64x2.splat(0.0)
        c21 := f64x2.splat(0.0)
        c22 := f64x2.splat(0.0)
        c23 := f64x2.splat(0.0)
        c30 := f64x2.splat(0.0)
        c31 := f64x2.splat(0.0)
        c32 := f64x2.splat(0.0)
        c33 := f64x2.splat(0.0)

        for p := 0, k
          a0 := a[i, k, p]
          a1 := a[i + 1, k, p]
          a2 := a[i + 2, k, p]
          a3 := a[i + 3, k, p]
          av0 := f64x2.splat(a0)
          av1 := f64x2.splat(a1)
          av2 := f64x2.splat(a2)
          av3 := f64x2.splat(a3)
          b_row := p * n * 8
          vb0 := v128.load_at(b, b_row + j * 8)
          vb1 := v128.load_at(b, b_row + j * 8 + 16)
          vb2 := v128.load_at(b, b_row + j * 8 + 32)
          vb3 := v128.load_at(b, b_row + j * 8 + 48)
          c00 := f64x2.relaxed_madd(av0, vb0, c00)
          c01 := f64x2.relaxed_madd(av0, vb1, c01)
          c02 := f64x2.relaxed_madd(av0, vb2, c02)
          c03 := f64x2.relaxed_madd(av0, vb3, c03)
          c10 := f64x2.relaxed_madd(av1, vb0, c10)
          c11 := f64x2.relaxed_madd(av1, vb1, c11)
          c12 := f64x2.relaxed_madd(av1, vb2, c12)
          c13 := f64x2.relaxed_madd(av1, vb3, c13)
          c20 := f64x2.relaxed_madd(av2, vb0, c20)
          c21 := f64x2.relaxed_madd(av2, vb1, c21)
          c22 := f64x2.relaxed_madd(av2, vb2, c22)
          c23 := f64x2.relaxed_madd(av2, vb3, c23)
          c30 := f64x2.relaxed_madd(av3, vb0, c30)
          c31 := f64x2.relaxed_madd(av3, vb1, c31)
          c32 := f64x2.relaxed_madd(av3, vb2, c32)
          c33 := f64x2.relaxed_madd(av3, vb3, c33)
        end for

        call v128.store_at(c, ic_row0 + j * 8, c00)
        call v128.store_at(c, ic_row0 + j * 8 + 16, c01)
        call v128.store_at(c, ic_row0 + j * 8 + 32, c02)
        call v128.store_at(c, ic_row0 + j * 8 + 48, c03)
        call v128.store_at(c, ic_row1 + j * 8, c10)
        call v128.store_at(c, ic_row1 + j * 8 + 16, c11)
        call v128.store_at(c, ic_row1 + j * 8 + 32, c12)
        call v128.store_at(c, ic_row1 + j * 8 + 48, c13)
        call v128.store_at(c, ic_row2 + j * 8, c20)
        call v128.store_at(c, ic_row2 + j * 8 + 16, c21)
        call v128.store_at(c, ic_row2 + j * 8 + 32, c22)
        call v128.store_at(c, ic_row2 + j * 8 + 48, c23)
        call v128.store_at(c, ic_row3 + j * 8, c30)
        call v128.store_at(c, ic_row3 + j * 8 + 16, c31)
        call v128.store_at(c, ic_row3 + j * 8 + 32, c32)
        call v128.store_at(c, ic_row3 + j * 8 + 48, c33)
      end for
    end for
  end

  ! 2x2 microkernel dgemm. Assumes m divisible by 2, n divisible by 4.
  ! beta = 0 hardcoded (caller zeros C beforehand if needed).
  subroutine dgemm_micro2x2(
    a: array f64; b: array f64; c: array f64;
    m, n, k: i32; alpha: f64
  )
  var
    i, j, p, ic_row, ic_row2, b_row: i32
    a0, a1: f64
    av0, av1: f64x2
    vb0, vb1: f64x2
    c00, c01, c10, c11: f64x2
  begin
    ! Zero C first.
    for i := 0, m
      for j := 0, n
        c[i, n, j] := 0.0
      end for
    end for

    ! Process (i, j) microtiles of 2 rows x 4 cols.
    for i := 0, m, 2
      ic_row := i * n * 8
      ic_row2 := (i + 1) * n * 8
      for j := 0, n, 4
        ! Initialize accumulators to 0.
        c00 := f64x2.splat(0.0)
        c01 := f64x2.splat(0.0)
        c10 := f64x2.splat(0.0)
        c11 := f64x2.splat(0.0)
        ! Tight inner loop over k, accumulating into the 4 register-resident vectors.
        for p := 0, k
          a0 := a[i, k, p]
          a1 := a[i + 1, k, p]
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
        ! Scale by alpha and write back. (alpha = 1 fast path: just write.)
        if (alpha == 1.0) then
          call v128.store_at(c, ic_row + j * 8, c00)
          call v128.store_at(c, ic_row + j * 8 + 16, c01)
          call v128.store_at(c, ic_row2 + j * 8, c10)
          call v128.store_at(c, ic_row2 + j * 8 + 16, c11)
        else
          av0 := f64x2.splat(alpha)
          c00 := av0 * c00
          c01 := av0 * c01
          c10 := av0 * c10
          c11 := av0 * c11
          call v128.store_at(c, ic_row + j * 8, c00)
          call v128.store_at(c, ic_row + j * 8 + 16, c01)
          call v128.store_at(c, ic_row2 + j * 8, c10)
          call v128.store_at(c, ic_row2 + j * 8 + 16, c11)
        end if
      end for
    end for
  end
`;

const f64 = new Float64Array(memory.buffer);

const N = 200;
const aPtr = 0;
const bPtr = N * N * 8;
const c1Ptr = N * N * 16;
const c2Ptr = N * N * 24;

// Initialize A and B with random data.
let s = 1;
for (let i = 0; i < N * N; i++) {
  s = (s * 16807) % 2147483647;
  f64[(aPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
  s = (s * 16807) % 2147483647;
  f64[(bPtr >> 3) + i] = (s - 1) / 2147483646 - 0.5;
}

// Correctness check: baseline vs microkernels.
mod.dgemm_baseline(aPtr, bPtr, c1Ptr, N, N, N, 1.0, 0.0);
mod.dgemm_micro2x2(aPtr, bPtr, c2Ptr, N, N, N, 1.0);
const c3Ptr = N * N * 32;
mod.dgemm_micro4x4(aPtr, bPtr, c3Ptr, N, N, N, 1.0);
let maxDiff2 = 0, maxDiff4 = 0;
for (let i = 0; i < N * N; i++) {
  const d2 = Math.abs(f64[(c1Ptr >> 3) + i] - f64[(c2Ptr >> 3) + i]);
  const d4 = Math.abs(f64[(c1Ptr >> 3) + i] - f64[(c3Ptr >> 3) + i]);
  if (d2 > maxDiff2) maxDiff2 = d2;
  if (d4 > maxDiff4) maxDiff4 = d4;
}
console.log(`max diff baseline vs 2x2 microkernel: ${maxDiff2.toExponential(3)}`);
console.log(`max diff baseline vs 4x4 microkernel: ${maxDiff4.toExponential(3)}`);
if (maxDiff2 > 1e-9 || maxDiff4 > 1e-9) {
  console.error('CORRECTNESS FAIL');
  process.exit(1);
}
console.log('correctness: ✓');
console.log();

// Bench.
function time(label, runs, fn) {
  for (let i = 0; i < 3; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(40)}: ${(elapsed / runs).toFixed(4)} ms/run`);
  return elapsed / runs;
}

console.log('=== 200×200 dgemm ===');
const t1 = time('baseline (current alas.dgemm shape)', 100, () => {
  mod.dgemm_baseline(aPtr, bPtr, c1Ptr, N, N, N, 1.0, 0.0);
});
const t2 = time('2x2 microkernel (4 accumulators)', 100, () => {
  mod.dgemm_micro2x2(aPtr, bPtr, c2Ptr, N, N, N, 1.0);
});
const t4 = time('4x4 microkernel (16 accumulators)', 100, () => {
  mod.dgemm_micro4x4(aPtr, bPtr, c3Ptr, N, N, N, 1.0);
});

console.log();
console.log(`2x2 speedup vs baseline: ${(t1 / t2).toFixed(2)}×`);
console.log(`4x4 speedup vs baseline: ${(t1 / t4).toFixed(2)}×`);
console.log(`4x4 speedup vs 2x2:      ${(t2 / t4).toFixed(2)}×`);
console.log();
console.log('Reference targets at 200×200:');
console.log('  natra alpack dgemm:  ~1.65 ms');
console.log('  TF.js wasm f32:      ~0.34 ms (f32 — 2× lane density)');
console.log('  numpy ST f64:        ~0.26 ms');
