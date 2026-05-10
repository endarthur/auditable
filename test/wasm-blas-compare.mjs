// Compare alpack's dgemm against TensorFlow.js wasm backend matmul.
//
// IMPORTANT CAVEAT: TF.js wasm uses f32, not f64. f32 has 4 elements per
// 128-bit SIMD register vs f64's 2, so TF.js f32 should be ~2× faster than
// the equivalent f64 implementation would be. Adjust accordingly when
// reading the comparison.
//
// What TF.js represents:
//   - Hand-tuned C++ kernels (xnnpack-derived, used in production for ML)
//   - Compiled to wasm via emscripten with -msimd128
//   - Matrix-multiply is one of their hot paths (used for every neural net
//     dense layer); they care about it
//
// So this is a real proxy for "well-engineered wasm BLAS" performance.

import { natra } from '../ext/natra/index.js';
import { atra } from '../ext/atra/index.js';
import { all as alpackSrc } from '../ext/alpack/src.js';
import * as tfNs from '@tensorflow/tfjs-core';
import * as tfWasm from '@tensorflow/tfjs-backend-wasm';

const tf = tfNs.default ?? tfNs;
await tfWasm.setWasmPaths('node_modules/@tensorflow/tfjs-backend-wasm/wasm-out/');
await tf.setBackend('wasm');
await tf.ready();
console.log('TF.js backend:', tf.getBackend());
console.log('TF.js version:', tf.version_core);
console.log();

const ctx = await natra({ pages: 1024 });

// Compile alpack with all f32 routines included for the s* comparison.
const sgemmMemory = new WebAssembly.Memory({ initial: 2048, maximum: 16384 });
const alpackMod = atra({ __memory: sgemmMemory })`${alpackSrc}`;
const sgemm = alpackMod.alas.sgemm;
const f32mem = new Float32Array(sgemmMemory.buffer);
const f64mem = new Float64Array(sgemmMemory.buffer);

async function time(label, runs, fn) {
  for (let i = 0; i < Math.min(3, runs); i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(48)}: ${(elapsed / runs).toFixed(4)} ms/run`);
  return elapsed / runs;
}

for (const N of [50, 100, 200, 500]) {
  console.log(`\n=== ${N}×${N} matmul ===`);

  // natra (f64 dgemm via alpack)
  const A_f64 = new Float64Array(N * N);
  const B_f64 = new Float64Array(N * N);
  let s = 1;
  for (let i = 0; i < N * N; i++) {
    s = (s * 16807) % 2147483647;
    A_f64[i] = (s - 1) / 2147483646;
    s = (s * 16807) % 2147483647;
    B_f64[i] = (s - 1) / 2147483646;
  }
  const nA = ctx.array(Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => A_f64[i * N + j])));
  const nB = ctx.array(Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => B_f64[i * N + j])));
  const runs = N <= 100 ? 200 : N <= 200 ? 50 : 20;

  await time(`natra f64 (alpack dgemm)`, runs, () => {
    ctx.scope(s => { s.matmul(nA, nB); });
  });

  // atra f32 sgemm — same algorithm shape, f32x4 SIMD (4-wide vs f64x2's 2-wide)
  const aPtr = 0;
  const bPtr = aPtr + N * N * 4;
  const cPtr = bPtr + N * N * 4;
  for (let i = 0; i < N * N; i++) f32mem[(aPtr >> 2) + i] = A_f64[i];
  for (let i = 0; i < N * N; i++) f32mem[(bPtr >> 2) + i] = B_f64[i];
  await time(`alpack.sgemm (f32, in-tree)`, runs, () => {
    sgemm(aPtr, bPtr, cPtr, N, N, N, 1.0, 0.0);
  });

  // TF.js wasm (f32 matmul). Convert to f32 once outside the timing loop.
  const A_f32 = new Float32Array(A_f64);
  const B_f32 = new Float32Array(B_f64);
  const tA = tf.tensor2d(A_f32, [N, N]);
  const tB = tf.tensor2d(B_f32, [N, N]);
  // Warm up + sync to ensure backend kernels are loaded.
  (await tf.matMul(tA, tB)).dispose();

  await time(`TF.js wasm f32 (matMul)`, runs, async () => {
    const r = tf.matMul(tA, tB);
    await r.data();   // ensure execution completes
    r.dispose();
  });

  tA.dispose();
  tB.dispose();
}

console.log('\n');
console.log('Reference: numpy ST f64 dgemm timings from earlier session:');
console.log('  50×50:   0.004 ms     100×100: 0.027 ms');
console.log('  200×200: 0.263 ms     500×500: 4.303 ms');
console.log();
console.log('Reference: numpy MT f64 dgemm timings:');
console.log('  500×500: 1.112 ms');
console.log();
console.log('Note: TF.js timings are f32 (2× per-cycle throughput vs f64),');
console.log('so the f64 wasm-BLAS ceiling is roughly TF.js × 1.5–2×.');
