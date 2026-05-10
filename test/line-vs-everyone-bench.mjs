// line vs TF.js vs alpack vs numpy — comprehensive matmul comparison.
//
// All in μs/call. NumPy is the "floor" reference (mature LAPACK + OpenBLAS,
// single-threaded for fair small-N comparison). TF.js wasm is the
// "well-engineered xnnpack-derived wasm SIMD matmul, the thing the rest
// of the web ML stack uses." alpack is our own atra-compiled f64x2 wasm.
//
// Run:  node test/line-vs-everyone-bench.mjs

import { execSync } from 'node:child_process';
import * as line from '../ext/line/index.js';
import { natra } from '../ext/natra/index.js';
import * as tfNs from '@tensorflow/tfjs-core';
import * as tfWasm from '@tensorflow/tfjs-backend-wasm';

const tf = tfNs.default ?? tfNs;
await tfWasm.setWasmPaths('node_modules/@tensorflow/tfjs-backend-wasm/wasm-out/');
await tf.setBackend('wasm');
await tf.ready();

const nat = await natra({ pages: 4096 });

const sizes = [16, 32, 64, 128, 256, 512, 1024];

// ─── numpy reference (Python subprocess via script file) ─────────────

function runNumpy(mode, sizes) {
  try {
    const out = execSync(`python test/perf_numpy_compare.py ${mode} ${sizes.join(',')}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    console.log(`  numpy ${mode} unavailable — skipping`);
    return null;
  }
}

console.log('Running numpy reference (single-thread OpenBLAS)…');
const numpyResults = runNumpy('matmul', sizes);
if (numpyResults) console.log('  numpy matmul ready\n');

// ─── benchmark harness ───────────────────────────────────────────────

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

// ─── run the bench ───────────────────────────────────────────────────

console.log('## dgemm (square N×N) — μs per call, median of 20 samples\n');
console.log('| N    | line f64 | alpack f64 | alpack f32 | tfjs f32  | numpy f64 | numpy f32 |');
console.log('|------|----------|------------|------------|-----------|-----------|-----------|');

let sink = 0;
for (const N of sizes) {
  const A = new Float64Array(N * N);
  const B = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    A[i] = Math.sin(i * 0.01);
    B[i] = Math.cos(i * 0.01);
  }
  const A32 = new Float32Array(A);
  const B32 = new Float32Array(B);

  const Anda = line.from(A, [N, N]);
  const Bnda = line.from(B, [N, N]);

  const Ant64 = nat.array(A, { shape: [N, N], dtype: 'f64' });
  const Bnt64 = nat.array(B, { shape: [N, N], dtype: 'f64' });
  const Ant32 = nat.array(A32, { shape: [N, N], dtype: 'f32' });
  const Bnt32 = nat.array(B32, { shape: [N, N], dtype: 'f32' });

  const Atf = tf.tensor2d(A32, [N, N]);
  const Btf = tf.tensor2d(B32, [N, N]);

  const innerRepeats = N >= 256 ? 3 : 5;

  const tLine = bench(() => { sink += line.matmul(Anda, Bnda).data[0]; }, innerRepeats) * 1000;
  const tAlp64 = bench(() => { sink += nat.scope(s => s.matmul(Ant64, Bnt64).ptr); }, innerRepeats) * 1000;
  const tAlp32 = bench(() => { sink += nat.scope(s => s.matmul(Ant32, Bnt32).ptr); }, innerRepeats) * 1000;
  const tTfjs  = bench(() => { sink += tf.tidy(() => tf.matMul(Atf, Btf).dataSync()[0]); }, innerRepeats) * 1000;

  Atf.dispose(); Btf.dispose();

  const np64 = numpyResults ? numpyResults[`${N}_f64`] : null;
  const np32 = numpyResults ? numpyResults[`${N}_f32`] : null;

  const fmt = (v) => v === null ? '   n/a   ' : v.toFixed(2).padStart(9);

  console.log(`| ${String(N).padStart(4)} | ${fmt(tLine)}| ${fmt(tAlp64)} | ${fmt(tAlp32)} | ${fmt(tTfjs)} | ${fmt(np64)} | ${fmt(np32)} |`);
}

// Also BLAS-1: just line.dot vs tf.dot vs numpy.dot
console.log('\n## ddot (1D · 1D) — μs per call\n');
console.log('| n      | line f64 | alpack f64 | tfjs f32  | numpy f64 | numpy f32 |');
console.log('|--------|----------|------------|-----------|-----------|-----------|');

const ddotSizes = [128, 1024, 8192, 32768];

const numpyDotResults = runNumpy('ddot', ddotSizes);

for (const n of ddotSizes) {
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = Math.sin(i * 0.1); y[i] = Math.cos(i * 0.1); }
  const x32 = new Float32Array(x), y32 = new Float32Array(y);
  const xL = line.from(x, [n]);
  const yL = line.from(y, [n]);
  const X64 = nat.array(x, { shape: [n], dtype: 'f64' });
  const Y64 = nat.array(y, { shape: [n], dtype: 'f64' });
  const Xtf = tf.tensor1d(x32);
  const Ytf = tf.tensor1d(y32);

  const tLine = bench(() => { sink += line.dot(xL, yL); }, 100) * 1000;
  const tAlp  = bench(() => { sink += nat.scope(s => s.dot(X64, Y64)); }, 100) * 1000;
  const tTfjs = bench(() => { sink += tf.tidy(() => tf.dot(Xtf, Ytf).dataSync()[0]); }, 100) * 1000;

  Xtf.dispose(); Ytf.dispose();

  const np64 = numpyDotResults ? numpyDotResults[`${n}_f64`] : null;
  const np32 = numpyDotResults ? numpyDotResults[`${n}_f32`] : null;

  const fmt = (v) => v === null ? '   n/a   ' : v.toFixed(2).padStart(9);
  console.log(`| ${String(n).padStart(6)} | ${fmt(tLine)}| ${fmt(tAlp)} | ${fmt(tTfjs)} | ${fmt(np64)} | ${fmt(np32)} |`);
}

console.log('\nsink:', sink.toFixed(2));
