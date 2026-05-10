// V8 JS vs Wasm SIMD — head-to-head on simple BLAS-1 ops.
//
// Question: can hand-tuned JS over Float64Array beat alpack's wasm-SIMD
// kernels (f64x2)? V8 auto-vectorizes simple TypedArray loops on AVX/AVX2
// (4-wide f64) and has no FFI overhead — there's a real chance JS wins
// at small-to-medium n.
//
// Run:  node test/scitra-v8-vs-wasm.mjs
// Tip:  node --allow-natives-syntax test/scitra-v8-vs-wasm.mjs   (more stable)

import { natra } from '../ext/natra/index.js';

const nat = await natra({ pages: 1024 });

// ── JS variants (don't call into wasm at all) ─────────────────────────

function ddot_naive(x, y, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * y[i];
  return s;
}

function ddot_unrolled4(x, y, n) {
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

function ddot_unrolled8(x, y, n) {
  let s0=0, s1=0, s2=0, s3=0, s4=0, s5=0, s6=0, s7=0;
  const n8 = n - (n & 7);
  let i = 0;
  for (; i < n8; i += 8) {
    s0 += x[i  ] * y[i  ];
    s1 += x[i+1] * y[i+1];
    s2 += x[i+2] * y[i+2];
    s3 += x[i+3] * y[i+3];
    s4 += x[i+4] * y[i+4];
    s5 += x[i+5] * y[i+5];
    s6 += x[i+6] * y[i+6];
    s7 += x[i+7] * y[i+7];
  }
  let s = ((s0+s1) + (s2+s3)) + ((s4+s5) + (s6+s7));
  for (; i < n; i++) s += x[i] * y[i];
  return s;
}

function axpy_naive(a, x, y, n) {
  for (let i = 0; i < n; i++) y[i] = a * x[i] + y[i];
}

function axpy_unrolled4(a, x, y, n) {
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    y[i  ] = a * x[i  ] + y[i  ];
    y[i+1] = a * x[i+1] + y[i+1];
    y[i+2] = a * x[i+2] + y[i+2];
    y[i+3] = a * x[i+3] + y[i+3];
  }
  for (; i < n; i++) y[i] = a * x[i] + y[i];
}

function axpy_unrolled8(a, x, y, n) {
  const n8 = n - (n & 7);
  let i = 0;
  for (; i < n8; i += 8) {
    y[i  ] = a * x[i  ] + y[i  ];
    y[i+1] = a * x[i+1] + y[i+1];
    y[i+2] = a * x[i+2] + y[i+2];
    y[i+3] = a * x[i+3] + y[i+3];
    y[i+4] = a * x[i+4] + y[i+4];
    y[i+5] = a * x[i+5] + y[i+5];
    y[i+6] = a * x[i+6] + y[i+6];
    y[i+7] = a * x[i+7] + y[i+7];
  }
  for (; i < n; i++) y[i] = a * x[i] + y[i];
}

function nrm2_naive(x, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * x[i];
  return Math.sqrt(s);
}

function nrm2_unrolled4(x, n) {
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

// ── Wasm-side wrappers (via natra scope) ──────────────────────────────

function ddot_wasm(X, Y) { return nat.scope(s => s.dot(X, Y)); }
function nrm2_wasm(X)    { return nat.scope(s => s.norm(X)); }
// natra doesn't expose axpy directly; we use add() with a scaled copy as
// a proxy. Skip axpy wasm comparison for cleanliness.

// ── Bench harness ─────────────────────────────────────────────────────

function bench(fn, innerRepeats = 100, outerSamples = 30) {
  // Two warm-up runs
  fn(); fn();
  const ts = [];
  for (let r = 0; r < outerSamples; r++) {
    const t0 = performance.now();
    for (let k = 0; k < innerRepeats; k++) fn();
    ts.push((performance.now() - t0) / innerRepeats);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];  // median ms per call
}

// Sizes carefully chosen: small-n where FFI dominates (8, 64), middle
// range where auto-vec might shine (256-4096), large where wasm SIMD
// should win (16k+).
const sizes = [8, 32, 128, 512, 2048, 8192, 32768, 131072];

const x = new Float64Array(sizes[sizes.length-1]);
const y = new Float64Array(sizes[sizes.length-1]);
for (let i = 0; i < x.length; i++) { x[i] = Math.sin(i*0.1); y[i] = Math.cos(i*0.1); }

let sink = 0;  // prevent DCE

console.log('\n## ddot — dot product (cheaper of two reductions)\n');
console.log('| n      | naive (μs) | unroll4 (μs) | unroll8 (μs) | wasm (μs) | best/wasm |');
console.log('|--------|------------|--------------|--------------|-----------|-----------|');
for (const n of sizes) {
  const xs = x.subarray(0, n);
  const ys = y.subarray(0, n);
  const X = nat.array(xs, { shape: [n] });
  const Y = nat.array(ys, { shape: [n] });

  const t1 = bench(() => { sink += ddot_naive(xs, ys, n); }) * 1000;
  const t2 = bench(() => { sink += ddot_unrolled4(xs, ys, n); }) * 1000;
  const t3 = bench(() => { sink += ddot_unrolled8(xs, ys, n); }) * 1000;
  const t4 = bench(() => { sink += ddot_wasm(X, Y); }) * 1000;
  const best = Math.min(t1, t2, t3);
  const ratio = (best / t4).toFixed(2);
  const winner = best < t4 ? '**JS wins**' : 'wasm';
  console.log(`| ${String(n).padStart(6)} | ${t1.toFixed(3).padStart(10)} | ${t2.toFixed(3).padStart(12)} | ${t3.toFixed(3).padStart(12)} | ${t4.toFixed(3).padStart(9)} | ${ratio}× ${winner} |`);
}

console.log('\n## axpy — y[i] = a*x[i] + y[i] (FMA-friendly)\n');
console.log('| n      | naive (μs) | unroll4 (μs) | unroll8 (μs) | (no wasm) |');
console.log('|--------|------------|--------------|--------------|-----------|');
for (const n of sizes) {
  const xs = x.subarray(0, n);
  // Each axpy mutates y, so we need fresh copies — bench cost includes setup
  const t1 = bench(() => {
    const ys = new Float64Array(y.subarray(0, n));
    axpy_naive(0.5, xs, ys, n);
    sink += ys[0];
  }) * 1000;
  const t2 = bench(() => {
    const ys = new Float64Array(y.subarray(0, n));
    axpy_unrolled4(0.5, xs, ys, n);
    sink += ys[0];
  }) * 1000;
  const t3 = bench(() => {
    const ys = new Float64Array(y.subarray(0, n));
    axpy_unrolled8(0.5, xs, ys, n);
    sink += ys[0];
  }) * 1000;
  console.log(`| ${String(n).padStart(6)} | ${t1.toFixed(3).padStart(10)} | ${t2.toFixed(3).padStart(12)} | ${t3.toFixed(3).padStart(12)} | (skipped)  |`);
}

console.log('\n## nrm2 — sqrt of sum of squares\n');
console.log('| n      | naive (μs) | unroll4 (μs) | wasm (μs) | best/wasm |');
console.log('|--------|------------|--------------|-----------|-----------|');
for (const n of sizes) {
  const xs = x.subarray(0, n);
  const X = nat.array(xs, { shape: [n] });
  const t1 = bench(() => { sink += nrm2_naive(xs, n); }) * 1000;
  const t2 = bench(() => { sink += nrm2_unrolled4(xs, n); }) * 1000;
  const t3 = bench(() => { sink += nrm2_wasm(X); }) * 1000;
  const best = Math.min(t1, t2);
  const ratio = (best / t3).toFixed(2);
  const winner = best < t3 ? '**JS wins**' : 'wasm';
  console.log(`| ${String(n).padStart(6)} | ${t1.toFixed(3).padStart(10)} | ${t2.toFixed(3).padStart(12)} | ${t3.toFixed(3).padStart(9)} | ${ratio}× ${winner} |`);
}

// Print throughput estimates for the largest n — useful to see if we're
// memory-bound or compute-bound.
const N = sizes[sizes.length - 1];
const xN = x.subarray(0, N);
const yN = y.subarray(0, N);
const t = bench(() => { sink += ddot_unrolled4(xN, yN, N); }) * 1000;  // μs
const flops = 2 * N;  // mul + add per element
const gflops = flops / (t * 1e3);  // (FLOPs) / (μs * 1000) = GFLOPs/s
const bytes = N * 16;  // 8 bytes each from x and y
const gbps = bytes / (t * 1e3);
console.log(`\n## Throughput at n=${N} (unrolled4 ddot)\n`);
console.log(`time:        ${t.toFixed(2)} μs`);
console.log(`compute:     ${gflops.toFixed(2)} GFLOP/s`);
console.log(`bandwidth:   ${gbps.toFixed(2)} GB/s`);

console.log('\nsink (anti-DCE):', sink);
