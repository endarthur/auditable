// V8 (JS) vs alpack (Wasm SIMD via natra) vs TensorFlow.js (Wasm SIMD,
// hand-tuned C++/xnnpack), at both f64 and f32 precisions.
//
// Question: does V8's auto-vectorization win consistently, or do
// well-engineered wasm BLAS kernels still rule at large n?
//
// Sizes: 8 → 131072 (4 orders of magnitude).
// Ops:   ddot, nrm2 (BLAS-1 reductions; bandwidth-bound at large n).

import { natra } from '../ext/natra/index.js';
import * as tfNs from '@tensorflow/tfjs-core';
import * as tfWasm from '@tensorflow/tfjs-backend-wasm';

const tf = tfNs.default ?? tfNs;
await tfWasm.setWasmPaths('node_modules/@tensorflow/tfjs-backend-wasm/wasm-out/');
await tf.setBackend('wasm');
await tf.ready();

const nat = await natra({ pages: 1024 });

// ── JS f64 variants ───────────────────────────────────────────────────

function ddot_f64_unrolled4(x, y, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += x[i  ] * y[i  ];
    s1 += x[i+1] * y[i+1];
    s2 += x[i+2] * y[i+2];
    s3 += x[i+3] * y[i+3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) s += x[i] * y[i];
  return s;
}

function nrm2_f64_unrolled4(x, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += x[i  ] * x[i  ];
    s1 += x[i+1] * x[i+1];
    s2 += x[i+2] * x[i+2];
    s3 += x[i+3] * x[i+3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) s += x[i] * x[i];
  return Math.sqrt(s);
}

// ── JS f32 variants — Math.fround locks values to single precision ───

function ddot_f32_naive(x, y, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s = Math.fround(s + Math.fround(x[i] * y[i]));
  return s;
}

function ddot_f32_unrolled4(x, y, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 = Math.fround(s0 + Math.fround(x[i  ] * y[i  ]));
    s1 = Math.fround(s1 + Math.fround(x[i+1] * y[i+1]));
    s2 = Math.fround(s2 + Math.fround(x[i+2] * y[i+2]));
    s3 = Math.fround(s3 + Math.fround(x[i+3] * y[i+3]));
  }
  let s = Math.fround(Math.fround(s0 + s1) + Math.fround(s2 + s3));
  for (; i < n; i++) s = Math.fround(s + Math.fround(x[i] * y[i]));
  return s;
}

function nrm2_f32_unrolled4(x, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 = Math.fround(s0 + Math.fround(x[i  ] * x[i  ]));
    s1 = Math.fround(s1 + Math.fround(x[i+1] * x[i+1]));
    s2 = Math.fround(s2 + Math.fround(x[i+2] * x[i+2]));
    s3 = Math.fround(s3 + Math.fround(x[i+3] * x[i+3]));
  }
  let s = Math.fround(Math.fround(s0 + s1) + Math.fround(s2 + s3));
  for (; i < n; i++) s = Math.fround(s + Math.fround(x[i] * x[i]));
  return Math.fround(Math.sqrt(s));
}

// ── Wasm wrappers ────────────────────────────────────────────────────

function ddot_alpack_f64(X, Y) { return nat.scope(s => s.dot(X, Y)); }
function nrm2_alpack_f64(X)    { return nat.scope(s => s.norm(X)); }
function ddot_alpack_f32(X, Y) { return nat.scope(s => s.dot(X, Y)); }
function nrm2_alpack_f32(X)    { return nat.scope(s => s.norm(X)); }

// TF.js wrappers — assume tensors are pre-allocated, dataSync() to force
// the kernel to run.
function ddot_tfjs(a, b) { return tf.tidy(() => tf.dot(a, b).dataSync()[0]); }
function nrm2_tfjs(a)    { return tf.tidy(() => tf.norm(a).dataSync()[0]); }

// ── Bench harness ─────────────────────────────────────────────────────

function bench(fn, innerRepeats = 100, outerSamples = 30) {
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

const sizes = [8, 32, 128, 512, 2048, 8192, 32768, 131072];
let sink = 0;

// Pre-allocate at the largest size; subarray for smaller benches.
const Nmax = sizes[sizes.length - 1];
const x64 = new Float64Array(Nmax), y64 = new Float64Array(Nmax);
const x32 = new Float32Array(Nmax), y32 = new Float32Array(Nmax);
for (let i = 0; i < Nmax; i++) {
  const v = Math.sin(i * 0.1);
  const w = Math.cos(i * 0.1);
  x64[i] = v; y64[i] = w;
  x32[i] = v; y32[i] = w;
}

console.log('\n===== ddot — dot product =====\n');
console.log('| n      | js-f64-u4 | alpack-f64 | js-f32-u4 | alpack-f32 | tfjs-f32 | best | best/2nd |');
console.log('|--------|-----------|------------|-----------|------------|----------|------|----------|');

for (const n of sizes) {
  const xs64 = x64.subarray(0, n);
  const ys64 = y64.subarray(0, n);
  const xs32 = x32.subarray(0, n);
  const ys32 = y32.subarray(0, n);

  const X64 = nat.array(xs64, { shape: [n], dtype: 'f64' });
  const Y64 = nat.array(ys64, { shape: [n], dtype: 'f64' });
  const X32 = nat.array(xs32, { shape: [n], dtype: 'f32' });
  const Y32 = nat.array(ys32, { shape: [n], dtype: 'f32' });
  const Xtf = tf.tensor1d(xs32);
  const Ytf = tf.tensor1d(ys32);

  const t1 = bench(() => { sink += ddot_f64_unrolled4(xs64, ys64, n); }) * 1000;
  const t2 = bench(() => { sink += ddot_alpack_f64(X64, Y64); }) * 1000;
  const t3 = bench(() => { sink += ddot_f32_unrolled4(xs32, ys32, n); }) * 1000;
  const t4 = bench(() => { sink += ddot_alpack_f32(X32, Y32); }) * 1000;
  const t5 = bench(() => { sink += ddot_tfjs(Xtf, Ytf); }) * 1000;

  Xtf.dispose(); Ytf.dispose();

  const all = [
    { name: 'js-f64-u4', t: t1 },
    { name: 'alpack-f64', t: t2 },
    { name: 'js-f32-u4', t: t3 },
    { name: 'alpack-f32', t: t4 },
    { name: 'tfjs-f32', t: t5 },
  ].sort((a, b) => a.t - b.t);
  const best = all[0];
  const second = all[1];
  const ratio = (second.t / best.t).toFixed(2);

  console.log(`| ${String(n).padStart(6)} | ${t1.toFixed(2).padStart(9)} | ${t2.toFixed(2).padStart(10)} | ${t3.toFixed(2).padStart(9)} | ${t4.toFixed(2).padStart(10)} | ${t5.toFixed(2).padStart(8)} | ${best.name.padEnd(11)} | ${ratio}× |`);
}

console.log('\n===== nrm2 — L2 norm =====\n');
console.log('| n      | js-f64-u4 | alpack-f64 | js-f32-u4 | alpack-f32 | tfjs-f32 | best | best/2nd |');
console.log('|--------|-----------|------------|-----------|------------|----------|------|----------|');

for (const n of sizes) {
  const xs64 = x64.subarray(0, n);
  const xs32 = x32.subarray(0, n);

  const X64 = nat.array(xs64, { shape: [n], dtype: 'f64' });
  const X32 = nat.array(xs32, { shape: [n], dtype: 'f32' });
  const Xtf = tf.tensor1d(xs32);

  const t1 = bench(() => { sink += nrm2_f64_unrolled4(xs64, n); }) * 1000;
  const t2 = bench(() => { sink += nrm2_alpack_f64(X64); }) * 1000;
  const t3 = bench(() => { sink += nrm2_f32_unrolled4(xs32, n); }) * 1000;
  const t4 = bench(() => { sink += nrm2_alpack_f32(X32); }) * 1000;
  const t5 = bench(() => { sink += nrm2_tfjs(Xtf); }) * 1000;

  Xtf.dispose();

  const all = [
    { name: 'js-f64-u4', t: t1 },
    { name: 'alpack-f64', t: t2 },
    { name: 'js-f32-u4', t: t3 },
    { name: 'alpack-f32', t: t4 },
    { name: 'tfjs-f32', t: t5 },
  ].sort((a, b) => a.t - b.t);
  const best = all[0];
  const second = all[1];
  const ratio = (second.t / best.t).toFixed(2);

  console.log(`| ${String(n).padStart(6)} | ${t1.toFixed(2).padStart(9)} | ${t2.toFixed(2).padStart(10)} | ${t3.toFixed(2).padStart(9)} | ${t4.toFixed(2).padStart(10)} | ${t5.toFixed(2).padStart(8)} | ${best.name.padEnd(11)} | ${ratio}× |`);
}

// Throughput at largest n
const N = sizes[sizes.length - 1];
const xN = x64.subarray(0, N), yN = y64.subarray(0, N);
const t = bench(() => { sink += ddot_f64_unrolled4(xN, yN, N); }) * 1000;
const flops = 2 * N;
const bytes = N * 16;
console.log(`\n## Throughput at n=${N} (js-f64 unrolled4 ddot)\n`);
console.log(`time:        ${t.toFixed(2)} μs`);
console.log(`compute:     ${(flops / (t * 1e3)).toFixed(2)} GFLOP/s`);
console.log(`bandwidth:   ${(bytes / (t * 1e3)).toFixed(2)} GB/s`);

console.log('\nsink (anti-DCE):', sink);
