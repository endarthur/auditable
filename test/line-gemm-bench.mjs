// Can JS-tiled gemm close the gap to wasm SIMD?
//
// Strategy: register-blocked microkernel — process 4×4 (or 2×2, 4×8)
// output tiles at once, keep all accumulators in V8 registers across
// the k-loop. Hoping V8's register allocator (16 xmm regs on x64) can
// keep:
//   - 16 scalar f64 c[i][j] accumulators in xmm regs (or fewer pairs if
//     V8 auto-vectorizes 4-wide AVX across columns)
//   - a few A[i,k] loads
//   - a few B[k,j] loads
// all without spilling to memory. If V8 does, we get 16 fma per k step
// out of ~16 register operands — same shape as alpack's hand-coded
// 2x2-with-f64x2 microkernel, but at AVX (4-wide) instead of SSE2/wasm
// (2-wide).

import { natra } from '../ext/natra/index.js';
import * as line from '../ext/line/index.js';

const nat = await natra({ pages: 4096 });

// ─── matmul variants ───────────────────────────────────────────────

// 0: vec's current — i,k,j loop, no register tiling
function gemm_ikj(A, B, M, K, N) {
  const C = new Float64Array(M * N);
  for (let i = 0; i < M; i++) {
    const aRow = i * K;
    const cRow = i * N;
    for (let k = 0; k < K; k++) {
      const aik = A[aRow + k];
      const bRow = k * N;
      for (let j = 0; j < N; j++) {
        C[cRow + j] += aik * B[bRow + j];
      }
    }
  }
  return C;
}

// 1: 2×2 register-tiled. 4 accumulators per output tile.
function gemm_2x2(A, B, M, K, N) {
  const C = new Float64Array(M * N);
  const M2 = M - (M & 1);
  const N2 = N - (N & 1);
  for (let i = 0; i < M2; i += 2) {
    for (let j = 0; j < N2; j += 2) {
      let c00 = 0, c01 = 0;
      let c10 = 0, c11 = 0;
      for (let k = 0; k < K; k++) {
        const a0 = A[i      * K + k];
        const a1 = A[(i+1)  * K + k];
        const b0 = B[k * N + j  ];
        const b1 = B[k * N + j+1];
        c00 += a0 * b0;
        c01 += a0 * b1;
        c10 += a1 * b0;
        c11 += a1 * b1;
      }
      C[ i    * N + j  ] = c00;
      C[ i    * N + j+1] = c01;
      C[(i+1) * N + j  ] = c10;
      C[(i+1) * N + j+1] = c11;
    }
    // tail column
    for (let j = N2; j < N; j++) {
      let c0 = 0, c1 = 0;
      for (let k = 0; k < K; k++) {
        c0 += A[ i    * K + k] * B[k * N + j];
        c1 += A[(i+1) * K + k] * B[k * N + j];
      }
      C[ i    * N + j] = c0;
      C[(i+1) * N + j] = c1;
    }
  }
  // tail row
  for (let i = M2; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let c = 0;
      for (let k = 0; k < K; k++) c += A[i * K + k] * B[k * N + j];
      C[i * N + j] = c;
    }
  }
  return C;
}

// 2: 4×4 register-tiled. 16 accumulators — right at V8's xmm reg limit
// if it can't vectorize. If V8 can auto-vec 4-wide, it could use 4
// vector regs for accumulators (one per output row) and 8 more for
// A/B loads.
function gemm_4x4(A, B, M, K, N) {
  const C = new Float64Array(M * N);
  const M4 = M - (M & 3);
  const N4 = N - (N & 3);
  for (let i = 0; i < M4; i += 4) {
    for (let j = 0; j < N4; j += 4) {
      let c00=0, c01=0, c02=0, c03=0;
      let c10=0, c11=0, c12=0, c13=0;
      let c20=0, c21=0, c22=0, c23=0;
      let c30=0, c31=0, c32=0, c33=0;
      const a0Row = i      * K;
      const a1Row = (i+1)  * K;
      const a2Row = (i+2)  * K;
      const a3Row = (i+3)  * K;
      for (let k = 0; k < K; k++) {
        const a0 = A[a0Row + k];
        const a1 = A[a1Row + k];
        const a2 = A[a2Row + k];
        const a3 = A[a3Row + k];
        const bRow = k * N;
        const b0 = B[bRow + j  ];
        const b1 = B[bRow + j+1];
        const b2 = B[bRow + j+2];
        const b3 = B[bRow + j+3];
        c00 += a0 * b0; c01 += a0 * b1; c02 += a0 * b2; c03 += a0 * b3;
        c10 += a1 * b0; c11 += a1 * b1; c12 += a1 * b2; c13 += a1 * b3;
        c20 += a2 * b0; c21 += a2 * b1; c22 += a2 * b2; c23 += a2 * b3;
        c30 += a3 * b0; c31 += a3 * b1; c32 += a3 * b2; c33 += a3 * b3;
      }
      const cRow0 = i      * N + j;
      const cRow1 = (i+1)  * N + j;
      const cRow2 = (i+2)  * N + j;
      const cRow3 = (i+3)  * N + j;
      C[cRow0  ] = c00; C[cRow0+1] = c01; C[cRow0+2] = c02; C[cRow0+3] = c03;
      C[cRow1  ] = c10; C[cRow1+1] = c11; C[cRow1+2] = c12; C[cRow1+3] = c13;
      C[cRow2  ] = c20; C[cRow2+1] = c21; C[cRow2+2] = c22; C[cRow2+3] = c23;
      C[cRow3  ] = c30; C[cRow3+1] = c31; C[cRow3+2] = c32; C[cRow3+3] = c33;
    }
    // Tail columns — scalar
    for (let j = N4; j < N; j++) {
      let c0=0, c1=0, c2=0, c3=0;
      for (let k = 0; k < K; k++) {
        const bv = B[k * N + j];
        c0 += A[ i    * K + k] * bv;
        c1 += A[(i+1) * K + k] * bv;
        c2 += A[(i+2) * K + k] * bv;
        c3 += A[(i+3) * K + k] * bv;
      }
      C[ i    * N + j] = c0;
      C[(i+1) * N + j] = c1;
      C[(i+2) * N + j] = c2;
      C[(i+3) * N + j] = c3;
    }
  }
  // Tail rows — scalar
  for (let i = M4; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let c = 0;
      for (let k = 0; k < K; k++) c += A[i * K + k] * B[k * N + j];
      C[i * N + j] = c;
    }
  }
  return C;
}

// 3: 2×4 tile (compromise — fewer accumulators, may avoid spill)
function gemm_2x4(A, B, M, K, N) {
  const C = new Float64Array(M * N);
  const M2 = M - (M & 1);
  const N4 = N - (N & 3);
  for (let i = 0; i < M2; i += 2) {
    for (let j = 0; j < N4; j += 4) {
      let c00=0, c01=0, c02=0, c03=0;
      let c10=0, c11=0, c12=0, c13=0;
      for (let k = 0; k < K; k++) {
        const a0 = A[i     * K + k];
        const a1 = A[(i+1) * K + k];
        const bRow = k * N;
        const b0 = B[bRow + j  ];
        const b1 = B[bRow + j+1];
        const b2 = B[bRow + j+2];
        const b3 = B[bRow + j+3];
        c00 += a0 * b0; c01 += a0 * b1; c02 += a0 * b2; c03 += a0 * b3;
        c10 += a1 * b0; c11 += a1 * b1; c12 += a1 * b2; c13 += a1 * b3;
      }
      C[ i    * N + j  ] = c00; C[ i    * N + j+1] = c01;
      C[ i    * N + j+2] = c02; C[ i    * N + j+3] = c03;
      C[(i+1) * N + j  ] = c10; C[(i+1) * N + j+1] = c11;
      C[(i+1) * N + j+2] = c12; C[(i+1) * N + j+3] = c13;
    }
    // Tail columns
    for (let j = N4; j < N; j++) {
      let c0=0, c1=0;
      for (let k = 0; k < K; k++) {
        const bv = B[k * N + j];
        c0 += A[ i    * K + k] * bv;
        c1 += A[(i+1) * K + k] * bv;
      }
      C[ i    * N + j] = c0;
      C[(i+1) * N + j] = c1;
    }
  }
  // Tail row
  for (let i = M2; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let c = 0;
      for (let k = 0; k < K; k++) c += A[i * K + k] * B[k * N + j];
      C[i * N + j] = c;
    }
  }
  return C;
}

// ─── bench harness ──────────────────────────────────────────────────

function bench(fn, innerRepeats = 5, outerSamples = 20) {
  fn(); fn();
  const ts = [];
  for (let r = 0; r < outerSamples; r++) {
    const t0 = performance.now();
    for (let k = 0; k < innerRepeats; k++) fn();
    ts.push((performance.now() - t0) / innerRepeats);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

// Verify correctness on a small matrix
function verify(N) {
  const A = new Float64Array(N * N);
  const B = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    A[i] = Math.sin(i * 0.123);
    B[i] = Math.cos(i * 0.456);
  }
  const ref = gemm_ikj(A, B, N, N, N);
  const variants = [
    ['2x2', gemm_2x2(A, B, N, N, N)],
    ['2x4', gemm_2x4(A, B, N, N, N)],
    ['4x4', gemm_4x4(A, B, N, N, N)],
  ];
  for (const [name, C] of variants) {
    let maxErr = 0;
    for (let i = 0; i < ref.length; i++) {
      const e = Math.abs(C[i] - ref[i]);
      if (e > maxErr) maxErr = e;
    }
    if (maxErr > 1e-10) {
      throw new Error(`${name} mismatch: ${maxErr}`);
    }
  }
}

verify(13);  // non-multiple-of-4 to test tails
verify(64);
console.log('correctness verified\n');

const sizes = [16, 32, 64, 128, 256, 512, 1024];

console.log('## dgemm (f64) — square matrices\n');
console.log('| N    | ikj     | 2x2     | 2x4     | 4x4     | line    | alpack  | best js | js/alpack |');
console.log('|------|---------|---------|---------|---------|---------|---------|---------|-----------|');

let sink = 0;
for (const N of sizes) {
  const M = N, K = N;
  const A = new Float64Array(M * K);
  const B = new Float64Array(K * N);
  for (let i = 0; i < M * K; i++) A[i] = Math.sin(i * 0.01);
  for (let i = 0; i < K * N; i++) B[i] = Math.cos(i * 0.01);
  const Anda = line.from(A, [M, K]);
  const Bnda = line.from(B, [K, N]);

  const Ant = nat.array(A, { shape: [M, K], dtype: 'f64' });
  const Bnt = nat.array(B, { shape: [K, N], dtype: 'f64' });

  const tIkj  = bench(() => { sink += gemm_ikj(A, B, M, K, N)[0]; }) * 1000;
  const t2x2  = bench(() => { sink += gemm_2x2(A, B, M, K, N)[0]; }) * 1000;
  const t2x4  = bench(() => { sink += gemm_2x4(A, B, M, K, N)[0]; }) * 1000;
  const t4x4  = bench(() => { sink += gemm_4x4(A, B, M, K, N)[0]; }) * 1000;
  const tLine = bench(() => { sink += line.matmul(Anda, Bnda).data[0]; }) * 1000;
  const tAlp  = bench(() => { sink += nat.scope(s => s.matmul(Ant, Bnt).ptr); }) * 1000;

  const bestJs = Math.min(tIkj, t2x2, t2x4, t4x4);
  const ratio = bestJs / tAlp;
  console.log(`| ${String(N).padStart(4)} | ${tIkj.toFixed(2).padStart(7)} | ${t2x2.toFixed(2).padStart(7)} | ${t2x4.toFixed(2).padStart(7)} | ${t4x4.toFixed(2).padStart(7)} | ${tLine.toFixed(2).padStart(7)} | ${tAlp.toFixed(2).padStart(7)} | ${bestJs.toFixed(2).padStart(7)} | ${ratio.toFixed(2)}× |`);
}

console.log('\nsink:', sink.toFixed(2));
