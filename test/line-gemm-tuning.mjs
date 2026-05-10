// Push line.matmul further: cache blocking and f32 path.
//
// Current 4×4 register-tiled matmul ties alpack but TF.js is 5-8× ahead
// at N≥256. Two known levers: cache blocking (panels that fit in L1/L2),
// and f32 (half the bytes, twice the AVX lanes per width if V8 vectorizes).

import { execSync } from 'node:child_process';
import { natra } from '../ext/natra/index.js';
import * as tfNs from '@tensorflow/tfjs-core';
import * as tfWasm from '@tensorflow/tfjs-backend-wasm';
import * as line from '../ext/line/index.js';

const tf = tfNs.default ?? tfNs;
await tfWasm.setWasmPaths('node_modules/@tensorflow/tfjs-backend-wasm/wasm-out/');
await tf.setBackend('wasm');
await tf.ready();

const nat = await natra({ pages: 4096 });

// ─── plain 4×4 (baseline — same as line.matmul) ─────────────────────

function gemm_4x4_f64(A, B, M, K, N) {
  const C = new Float64Array(M * N);
  const M4 = M - (M & 3);
  const N4 = N - (N & 3);
  for (let i = 0; i < M4; i += 4) {
    const a0Row = i * K, a1Row = (i+1) * K, a2Row = (i+2) * K, a3Row = (i+3) * K;
    for (let j = 0; j < N4; j += 4) {
      let c00=0,c01=0,c02=0,c03=0,c10=0,c11=0,c12=0,c13=0;
      let c20=0,c21=0,c22=0,c23=0,c30=0,c31=0,c32=0,c33=0;
      for (let k = 0; k < K; k++) {
        const a0=A[a0Row+k],a1=A[a1Row+k],a2=A[a2Row+k],a3=A[a3Row+k];
        const bRow = k * N;
        const b0=B[bRow+j],b1=B[bRow+j+1],b2=B[bRow+j+2],b3=B[bRow+j+3];
        c00+=a0*b0; c01+=a0*b1; c02+=a0*b2; c03+=a0*b3;
        c10+=a1*b0; c11+=a1*b1; c12+=a1*b2; c13+=a1*b3;
        c20+=a2*b0; c21+=a2*b1; c22+=a2*b2; c23+=a2*b3;
        c30+=a3*b0; c31+=a3*b1; c32+=a3*b2; c33+=a3*b3;
      }
      const c0=i*N+j, c1=(i+1)*N+j, c2=(i+2)*N+j, c3=(i+3)*N+j;
      C[c0]=c00; C[c0+1]=c01; C[c0+2]=c02; C[c0+3]=c03;
      C[c1]=c10; C[c1+1]=c11; C[c1+2]=c12; C[c1+3]=c13;
      C[c2]=c20; C[c2+1]=c21; C[c2+2]=c22; C[c2+3]=c23;
      C[c3]=c30; C[c3+1]=c31; C[c3+2]=c32; C[c3+3]=c33;
    }
    // tail cols
    for (let j = N4; j < N; j++) {
      let c0=0,c1=0,c2=0,c3=0;
      for (let k = 0; k < K; k++) {
        const bv = B[k*N+j];
        c0+=A[a0Row+k]*bv; c1+=A[a1Row+k]*bv;
        c2+=A[a2Row+k]*bv; c3+=A[a3Row+k]*bv;
      }
      C[i*N+j]=c0; C[(i+1)*N+j]=c1; C[(i+2)*N+j]=c2; C[(i+3)*N+j]=c3;
    }
  }
  for (let i = M4; i < M; i++) {
    const aRow=i*K, oRow=i*N;
    for (let k = 0; k < K; k++) {
      const aik = A[aRow+k]; const bRow = k*N;
      for (let j = 0; j < N; j++) C[oRow+j] += aik * B[bRow+j];
    }
  }
  return C;
}

// ─── 4×4 tile inside L1-sized blocks ─────────────────────────────────
//
// Block-major: ii, jj, kk loops outside, 4×4 tile inside. The kernel
// accumulates into C[ii..ii+BS, jj..jj+BS] over kk panels. With BS=64,
// a panel pair fits in L1 (3 × 64*64*8 = 96KB — over but fits in L2).
// BS=32: 3 × 32*32*8 = 24KB, fits in L1.

function makeBlocked(BS) {
  return function gemm_block_4x4_f64(A, B, M, K, N) {
    const C = new Float64Array(M * N);
    for (let ii = 0; ii < M; ii += BS) {
      const iEnd = Math.min(ii + BS, M);
      const iEnd4 = iEnd - ((iEnd - ii) & 3) ? iEnd : ii + ((iEnd - ii) & ~3);
      for (let jj = 0; jj < N; jj += BS) {
        const jEnd = Math.min(jj + BS, N);
        const jEnd4 = jj + ((jEnd - jj) & ~3);
        for (let kk = 0; kk < K; kk += BS) {
          const kEnd = Math.min(kk + BS, K);
          // 4×4 tile inside the block, accumulating into C
          for (let i = ii; i + 3 < iEnd; i += 4) {
            const a0Row=i*K, a1Row=(i+1)*K, a2Row=(i+2)*K, a3Row=(i+3)*K;
            for (let j = jj; j + 3 < jEnd; j += 4) {
              const c0=i*N+j, c1=(i+1)*N+j, c2=(i+2)*N+j, c3=(i+3)*N+j;
              let c00=C[c0],c01=C[c0+1],c02=C[c0+2],c03=C[c0+3];
              let c10=C[c1],c11=C[c1+1],c12=C[c1+2],c13=C[c1+3];
              let c20=C[c2],c21=C[c2+1],c22=C[c2+2],c23=C[c2+3];
              let c30=C[c3],c31=C[c3+1],c32=C[c3+2],c33=C[c3+3];
              for (let k = kk; k < kEnd; k++) {
                const a0=A[a0Row+k],a1=A[a1Row+k],a2=A[a2Row+k],a3=A[a3Row+k];
                const bRow=k*N;
                const b0=B[bRow+j],b1=B[bRow+j+1],b2=B[bRow+j+2],b3=B[bRow+j+3];
                c00+=a0*b0; c01+=a0*b1; c02+=a0*b2; c03+=a0*b3;
                c10+=a1*b0; c11+=a1*b1; c12+=a1*b2; c13+=a1*b3;
                c20+=a2*b0; c21+=a2*b1; c22+=a2*b2; c23+=a2*b3;
                c30+=a3*b0; c31+=a3*b1; c32+=a3*b2; c33+=a3*b3;
              }
              C[c0]=c00; C[c0+1]=c01; C[c0+2]=c02; C[c0+3]=c03;
              C[c1]=c10; C[c1+1]=c11; C[c1+2]=c12; C[c1+3]=c13;
              C[c2]=c20; C[c2+1]=c21; C[c2+2]=c22; C[c2+3]=c23;
              C[c3]=c30; C[c3+1]=c31; C[c3+2]=c32; C[c3+3]=c33;
            }
            // Tail j inside this block
            for (let j = jEnd4; j < jEnd; j++) {
              let c0Acc=C[i*N+j], c1Acc=C[(i+1)*N+j], c2Acc=C[(i+2)*N+j], c3Acc=C[(i+3)*N+j];
              for (let k = kk; k < kEnd; k++) {
                const bv = B[k*N+j];
                c0Acc+=A[a0Row+k]*bv; c1Acc+=A[a1Row+k]*bv;
                c2Acc+=A[a2Row+k]*bv; c3Acc+=A[a3Row+k]*bv;
              }
              C[i*N+j]=c0Acc; C[(i+1)*N+j]=c1Acc;
              C[(i+2)*N+j]=c2Acc; C[(i+3)*N+j]=c3Acc;
            }
          }
          // Tail i inside this block (rows that don't divide by 4)
          for (let i = ii + ((iEnd - ii) & ~3); i < iEnd; i++) {
            const aRow = i*K, oRow=i*N;
            for (let k = kk; k < kEnd; k++) {
              const aik = A[aRow+k]; const bRow=k*N;
              for (let j = jj; j < jEnd; j++) C[oRow+j] += aik * B[bRow+j];
            }
          }
        }
      }
    }
    return C;
  };
}

const gemm_block_32 = makeBlocked(32);
const gemm_block_64 = makeBlocked(64);
const gemm_block_128 = makeBlocked(128);

// ─── 4×4 f32 path (same algorithm, Float32Array everywhere) ──────────

function gemm_4x4_f32(A, B, M, K, N) {
  const C = new Float32Array(M * N);
  const M4 = M - (M & 3);
  const N4 = N - (N & 3);
  for (let i = 0; i < M4; i += 4) {
    const a0Row = i * K, a1Row = (i+1) * K, a2Row = (i+2) * K, a3Row = (i+3) * K;
    for (let j = 0; j < N4; j += 4) {
      let c00=0,c01=0,c02=0,c03=0,c10=0,c11=0,c12=0,c13=0;
      let c20=0,c21=0,c22=0,c23=0,c30=0,c31=0,c32=0,c33=0;
      for (let k = 0; k < K; k++) {
        const a0=A[a0Row+k],a1=A[a1Row+k],a2=A[a2Row+k],a3=A[a3Row+k];
        const bRow = k * N;
        const b0=B[bRow+j],b1=B[bRow+j+1],b2=B[bRow+j+2],b3=B[bRow+j+3];
        c00+=a0*b0; c01+=a0*b1; c02+=a0*b2; c03+=a0*b3;
        c10+=a1*b0; c11+=a1*b1; c12+=a1*b2; c13+=a1*b3;
        c20+=a2*b0; c21+=a2*b1; c22+=a2*b2; c23+=a2*b3;
        c30+=a3*b0; c31+=a3*b1; c32+=a3*b2; c33+=a3*b3;
      }
      const c0=i*N+j, c1=(i+1)*N+j, c2=(i+2)*N+j, c3=(i+3)*N+j;
      C[c0]=c00; C[c0+1]=c01; C[c0+2]=c02; C[c0+3]=c03;
      C[c1]=c10; C[c1+1]=c11; C[c1+2]=c12; C[c1+3]=c13;
      C[c2]=c20; C[c2+1]=c21; C[c2+2]=c22; C[c2+3]=c23;
      C[c3]=c30; C[c3+1]=c31; C[c3+2]=c32; C[c3+3]=c33;
    }
    for (let j = N4; j < N; j++) {
      let c0=0,c1=0,c2=0,c3=0;
      for (let k = 0; k < K; k++) {
        const bv = B[k*N+j];
        c0+=A[a0Row+k]*bv; c1+=A[a1Row+k]*bv;
        c2+=A[a2Row+k]*bv; c3+=A[a3Row+k]*bv;
      }
      C[i*N+j]=c0; C[(i+1)*N+j]=c1; C[(i+2)*N+j]=c2; C[(i+3)*N+j]=c3;
    }
  }
  for (let i = M4; i < M; i++) {
    const aRow=i*K, oRow=i*N;
    for (let k = 0; k < K; k++) {
      const aik = A[aRow+k]; const bRow = k*N;
      for (let j = 0; j < N; j++) C[oRow+j] += aik * B[bRow+j];
    }
  }
  return C;
}

// ─── f32 + blocked ──────────────────────────────────────────────────

function makeBlocked_f32(BS) {
  return function gemm_block_f32(A, B, M, K, N) {
    const C = new Float32Array(M * N);
    for (let ii = 0; ii < M; ii += BS) {
      const iEnd = Math.min(ii + BS, M);
      for (let jj = 0; jj < N; jj += BS) {
        const jEnd = Math.min(jj + BS, N);
        const jEnd4 = jj + ((jEnd - jj) & ~3);
        for (let kk = 0; kk < K; kk += BS) {
          const kEnd = Math.min(kk + BS, K);
          for (let i = ii; i + 3 < iEnd; i += 4) {
            const a0Row=i*K, a1Row=(i+1)*K, a2Row=(i+2)*K, a3Row=(i+3)*K;
            for (let j = jj; j + 3 < jEnd; j += 4) {
              const c0=i*N+j, c1=(i+1)*N+j, c2=(i+2)*N+j, c3=(i+3)*N+j;
              let c00=C[c0],c01=C[c0+1],c02=C[c0+2],c03=C[c0+3];
              let c10=C[c1],c11=C[c1+1],c12=C[c1+2],c13=C[c1+3];
              let c20=C[c2],c21=C[c2+1],c22=C[c2+2],c23=C[c2+3];
              let c30=C[c3],c31=C[c3+1],c32=C[c3+2],c33=C[c3+3];
              for (let k = kk; k < kEnd; k++) {
                const a0=A[a0Row+k],a1=A[a1Row+k],a2=A[a2Row+k],a3=A[a3Row+k];
                const bRow=k*N;
                const b0=B[bRow+j],b1=B[bRow+j+1],b2=B[bRow+j+2],b3=B[bRow+j+3];
                c00+=a0*b0; c01+=a0*b1; c02+=a0*b2; c03+=a0*b3;
                c10+=a1*b0; c11+=a1*b1; c12+=a1*b2; c13+=a1*b3;
                c20+=a2*b0; c21+=a2*b1; c22+=a2*b2; c23+=a2*b3;
                c30+=a3*b0; c31+=a3*b1; c32+=a3*b2; c33+=a3*b3;
              }
              C[c0]=c00; C[c0+1]=c01; C[c0+2]=c02; C[c0+3]=c03;
              C[c1]=c10; C[c1+1]=c11; C[c1+2]=c12; C[c1+3]=c13;
              C[c2]=c20; C[c2+1]=c21; C[c2+2]=c22; C[c2+3]=c23;
              C[c3]=c30; C[c3+1]=c31; C[c3+2]=c32; C[c3+3]=c33;
            }
            // tail jj
            for (let j = jEnd4; j < jEnd; j++) {
              let c0=C[i*N+j], c1=C[(i+1)*N+j], c2=C[(i+2)*N+j], c3=C[(i+3)*N+j];
              for (let k = kk; k < kEnd; k++) {
                const bv = B[k*N+j];
                c0+=A[a0Row+k]*bv; c1+=A[a1Row+k]*bv;
                c2+=A[a2Row+k]*bv; c3+=A[a3Row+k]*bv;
              }
              C[i*N+j]=c0; C[(i+1)*N+j]=c1;
              C[(i+2)*N+j]=c2; C[(i+3)*N+j]=c3;
            }
          }
          for (let i = ii + ((iEnd - ii) & ~3); i < iEnd; i++) {
            const aRow=i*K, oRow=i*N;
            for (let k = kk; k < kEnd; k++) {
              const aik = A[aRow+k]; const bRow=k*N;
              for (let j = jj; j < jEnd; j++) C[oRow+j] += aik * B[bRow+j];
            }
          }
        }
      }
    }
    return C;
  };
}

const gemm_block_64_f32 = makeBlocked_f32(64);

// ─── correctness check ──────────────────────────────────────────────

function verify(N) {
  const A = new Float64Array(N * N);
  const B = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) { A[i] = Math.sin(i*0.123); B[i] = Math.cos(i*0.456); }
  const ref = gemm_4x4_f64(A, B, N, N, N);
  for (const [name, fn] of [
    ['block-32', gemm_block_32],
    ['block-64', gemm_block_64],
    ['block-128', gemm_block_128],
  ]) {
    const C = fn(A, B, N, N, N);
    let me = 0;
    for (let i = 0; i < ref.length; i++) {
      const e = Math.abs(C[i] - ref[i]); if (e > me) me = e;
    }
    if (me > 1e-9) throw new Error(`${name} mismatch at N=${N}: ${me}`);
  }
  // f32 looser tolerance
  const A32 = new Float32Array(A), B32 = new Float32Array(B);
  const ref32 = gemm_4x4_f32(A32, B32, N, N, N);
  const C32b = gemm_block_64_f32(A32, B32, N, N, N);
  let me = 0;
  for (let i = 0; i < ref32.length; i++) {
    const e = Math.abs(C32b[i] - ref32[i]); if (e > me) me = e;
  }
  if (me > 1e-4) throw new Error(`f32 block mismatch at N=${N}: ${me}`);
}
verify(7);
verify(50);
verify(128);
console.log('correctness verified\n');

// ─── bench ──────────────────────────────────────────────────────────

function bench(fn, innerRepeats = 5, outerSamples = 15) {
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

function runNumpy(sizes) {
  try {
    const out = execSync(`python test/perf_numpy_compare.py matmul ${sizes.join(',')}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) { return null; }
}

const sizes = [128, 256, 512, 1024];
const np = runNumpy(sizes);

let sink = 0;

console.log('## matmul — μs/call, lower is better\n');
console.log('| N    | 4x4 f64 | blk32 f64 | blk64 f64 | blk128 f64 | 4x4 f32 | blk64 f32 | tfjs f32 | numpy f64 | numpy f32 |');
console.log('|------|---------|-----------|-----------|------------|---------|-----------|----------|-----------|-----------|');

for (const N of sizes) {
  const A = new Float64Array(N * N);
  const B = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) { A[i] = Math.sin(i*0.01); B[i] = Math.cos(i*0.01); }
  const A32 = new Float32Array(A), B32 = new Float32Array(B);

  const Atf = tf.tensor2d(A32, [N, N]);
  const Btf = tf.tensor2d(B32, [N, N]);

  const inner = N >= 512 ? 3 : 5;

  const t44   = bench(() => { sink += gemm_4x4_f64(A, B, N, N, N)[0]; }, inner) * 1000;
  const tB32  = bench(() => { sink += gemm_block_32(A, B, N, N, N)[0]; }, inner) * 1000;
  const tB64  = bench(() => { sink += gemm_block_64(A, B, N, N, N)[0]; }, inner) * 1000;
  const tB128 = bench(() => { sink += gemm_block_128(A, B, N, N, N)[0]; }, inner) * 1000;
  const t44f  = bench(() => { sink += gemm_4x4_f32(A32, B32, N, N, N)[0]; }, inner) * 1000;
  const tB64f = bench(() => { sink += gemm_block_64_f32(A32, B32, N, N, N)[0]; }, inner) * 1000;
  const tTf   = bench(() => { sink += tf.tidy(() => tf.matMul(Atf, Btf).dataSync()[0]); }, inner) * 1000;
  Atf.dispose(); Btf.dispose();

  const np64 = np ? np[`${N}_f64`] : null;
  const np32 = np ? np[`${N}_f32`] : null;
  const f = (v) => v === null ? '   n/a   ' : v.toFixed(2).padStart(9);

  console.log(`| ${String(N).padStart(4)} | ${f(t44)}| ${f(tB32)} | ${f(tB64)} | ${f(tB128)}  | ${f(t44f)}| ${f(tB64f)} | ${f(tTf)}| ${f(np64)} | ${f(np32)} |`);
}

console.log('\nsink:', sink.toFixed(2));
