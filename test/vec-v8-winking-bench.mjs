// vec V8-winking bench — find the optimal hand-tuned shapes for each
// reduction/dot operation, compare against the current vec source AND
// against alpack's wasm SIMD path.
//
// Operations tested:
//   sum(x)     — 1-array reduction
//   norm(x)    — 1-array reduction with x*x
//   dot(x,y)   — 2-array reduction
//   matvec     — n×n · n → n
//   mean(x)    — sum/n
//   variance   — two-pass: sum then sum-of-(x-m)²
//
// For each: naive (vec's current shape), unrolled-4, unrolled-8, alpack.
// Sizes: 8, 64, 512, 4096, 32768, 262144.

import * as vec from '../ext/vec/index.js';
import { natra } from '../ext/natra/index.js';

const nat = await natra({ pages: 2048 });

// ─────────────────────────────────────────────────────────────────────
// Hand-tuned candidates
// ─────────────────────────────────────────────────────────────────────

function sum_naive(d, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += d[i];
  return s;
}

function sum_u4(d, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += d[i  ];
    s1 += d[i+1];
    s2 += d[i+2];
    s3 += d[i+3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (; i < n; i++) s += d[i];
  return s;
}

function sum_u8(d, n) {
  let s0=0,s1=0,s2=0,s3=0,s4=0,s5=0,s6=0,s7=0;
  const n8 = n - (n & 7);
  let i = 0;
  for (; i < n8; i += 8) {
    s0 += d[i  ]; s1 += d[i+1]; s2 += d[i+2]; s3 += d[i+3];
    s4 += d[i+4]; s5 += d[i+5]; s6 += d[i+6]; s7 += d[i+7];
  }
  let s = ((s0+s1) + (s2+s3)) + ((s4+s5) + (s6+s7));
  for (; i < n; i++) s += d[i];
  return s;
}

function norm_naive(d, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += d[i] * d[i];
  return Math.sqrt(s);
}

function norm_u4(d, n) {
  let s0=0, s1=0, s2=0, s3=0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += d[i  ] * d[i  ];
    s1 += d[i+1] * d[i+1];
    s2 += d[i+2] * d[i+2];
    s3 += d[i+3] * d[i+3];
  }
  let s = (s0+s1) + (s2+s3);
  for (; i < n; i++) s += d[i] * d[i];
  return Math.sqrt(s);
}

function dot_naive(a, b, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function dot_u4(a, b, n) {
  let s0=0,s1=0,s2=0,s3=0;
  const n4 = n - (n & 3);
  let i = 0;
  for (; i < n4; i += 4) {
    s0 += a[i  ] * b[i  ];
    s1 += a[i+1] * b[i+1];
    s2 += a[i+2] * b[i+2];
    s3 += a[i+3] * b[i+3];
  }
  let s = (s0+s1) + (s2+s3);
  for (; i < n; i++) s += a[i] * b[i];
  return s;
}

// matrix-vector: y = A·x where A is m×n, x is n
function matvec_naive(A, x, m, n) {
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    const aRow = i * n;
    for (let j = 0; j < n; j++) s += A[aRow + j] * x[j];
    y[i] = s;
  }
  return y;
}

function matvec_u4(A, x, m, n) {
  const y = new Float64Array(m);
  const n4 = n - (n & 3);
  for (let i = 0; i < m; i++) {
    let s0=0, s1=0, s2=0, s3=0;
    const aRow = i * n;
    let j = 0;
    for (; j < n4; j += 4) {
      s0 += A[aRow + j  ] * x[j  ];
      s1 += A[aRow + j+1] * x[j+1];
      s2 += A[aRow + j+2] * x[j+2];
      s3 += A[aRow + j+3] * x[j+3];
    }
    let s = (s0+s1) + (s2+s3);
    for (; j < n; j++) s += A[aRow + j] * x[j];
    y[i] = s;
  }
  return y;
}

// 2-row matvec — process two output rows at once, share the x reads
function matvec_u4_2rows(A, x, m, n) {
  const y = new Float64Array(m);
  const n4 = n - (n & 3);
  let i = 0;
  for (; i + 1 < m; i += 2) {
    let s00=0,s01=0,s02=0,s03=0;
    let s10=0,s11=0,s12=0,s13=0;
    const aRow0 = i * n;
    const aRow1 = (i+1) * n;
    let j = 0;
    for (; j < n4; j += 4) {
      const x0=x[j], x1=x[j+1], x2=x[j+2], x3=x[j+3];
      s00 += A[aRow0 + j  ] * x0;
      s01 += A[aRow0 + j+1] * x1;
      s02 += A[aRow0 + j+2] * x2;
      s03 += A[aRow0 + j+3] * x3;
      s10 += A[aRow1 + j  ] * x0;
      s11 += A[aRow1 + j+1] * x1;
      s12 += A[aRow1 + j+2] * x2;
      s13 += A[aRow1 + j+3] * x3;
    }
    let r0 = (s00+s01) + (s02+s03);
    let r1 = (s10+s11) + (s12+s13);
    for (; j < n; j++) { r0 += A[aRow0 + j] * x[j]; r1 += A[aRow1 + j] * x[j]; }
    y[i  ] = r0;
    y[i+1] = r1;
  }
  // Tail
  for (; i < m; i++) {
    let s = 0;
    const aRow = i * n;
    for (let j = 0; j < n; j++) s += A[aRow + j] * x[j];
    y[i] = s;
  }
  return y;
}

// ─────────────────────────────────────────────────────────────────────
// Bench harness
// ─────────────────────────────────────────────────────────────────────

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

const sizes = [8, 64, 512, 4096, 32768, 262144];

const Nmax = sizes[sizes.length - 1];
const x64 = new Float64Array(Nmax);
const y64 = new Float64Array(Nmax);
for (let i = 0; i < Nmax; i++) { x64[i] = Math.sin(i*0.1); y64[i] = Math.cos(i*0.1); }

let sink = 0;

console.log('\n## sum — single-array reduction\n');
console.log('| n      | vec.sum | naive | u4    | u8    | best  | best/vec |');
console.log('|--------|---------|-------|-------|-------|-------|----------|');

for (const n of sizes) {
  const xs = x64.subarray(0, n);
  const ndarr = vec.from(xs, [n]);

  const tVec   = bench(() => { sink += vec.sum(ndarr); }) * 1000;
  const tNaive = bench(() => { sink += sum_naive(xs, n); }) * 1000;
  const tU4    = bench(() => { sink += sum_u4(xs, n); }) * 1000;
  const tU8    = bench(() => { sink += sum_u8(xs, n); }) * 1000;
  const best = Math.min(tNaive, tU4, tU8);
  const bestName = best === tU4 ? 'u4' : best === tU8 ? 'u8' : 'naive';
  console.log(`| ${String(n).padStart(6)} | ${tVec.toFixed(2).padStart(7)} | ${tNaive.toFixed(2).padStart(5)} | ${tU4.toFixed(2).padStart(5)} | ${tU8.toFixed(2).padStart(5)} | ${bestName.padEnd(5)} | ${(tVec/best).toFixed(2)}× |`);
}

console.log('\n## norm — sqrt(sum(x²))\n');
console.log('| n      | vec.norm | naive | u4    | alpack-f64 | best  | best/vec |');
console.log('|--------|----------|-------|-------|------------|-------|----------|');

for (const n of sizes) {
  const xs = x64.subarray(0, n);
  const ndarr = vec.from(xs, [n]);
  const X64 = nat.array(xs, { shape: [n], dtype: 'f64' });

  const tVec   = bench(() => { sink += vec.norm(ndarr); }) * 1000;
  const tNaive = bench(() => { sink += norm_naive(xs, n); }) * 1000;
  const tU4    = bench(() => { sink += norm_u4(xs, n); }) * 1000;
  const tAlp   = bench(() => { sink += nat.scope(s => s.norm(X64)); }) * 1000;
  const best = Math.min(tNaive, tU4);
  const bestName = best === tU4 ? 'u4' : 'naive';
  console.log(`| ${String(n).padStart(6)} | ${tVec.toFixed(2).padStart(8)} | ${tNaive.toFixed(2).padStart(5)} | ${tU4.toFixed(2).padStart(5)} | ${tAlp.toFixed(2).padStart(10)} | ${bestName.padEnd(5)} | ${(tVec/best).toFixed(2)}× |`);
}

console.log('\n## dot(x, y) — two-array reduction\n');
console.log('| n      | vec.dot | naive | u4    | alpack-f64 | best/vec |');
console.log('|--------|---------|-------|-------|------------|----------|');

for (const n of sizes) {
  const xs = x64.subarray(0, n);
  const ys = y64.subarray(0, n);
  const xa = vec.from(xs, [n]);
  const ya = vec.from(ys, [n]);
  const X64 = nat.array(xs, { shape: [n], dtype: 'f64' });
  const Y64 = nat.array(ys, { shape: [n], dtype: 'f64' });

  const tVec   = bench(() => { sink += vec.dot(xa, ya); }) * 1000;
  const tNaive = bench(() => { sink += dot_naive(xs, ys, n); }) * 1000;
  const tU4    = bench(() => { sink += dot_u4(xs, ys, n); }) * 1000;
  const tAlp   = bench(() => { sink += nat.scope(s => s.dot(X64, Y64)); }) * 1000;
  const best = Math.min(tNaive, tU4);
  console.log(`| ${String(n).padStart(6)} | ${tVec.toFixed(2).padStart(7)} | ${tNaive.toFixed(2).padStart(5)} | ${tU4.toFixed(2).padStart(5)} | ${tAlp.toFixed(2).padStart(10)} | ${(tVec/best).toFixed(2)}× |`);
}

console.log('\n## matvec — y = A·x (square A)\n');
console.log('| n   | vec.dot(2D,1D) | naive | u4    | u4-2rows | best/vec |');
console.log('|-----|----------------|-------|-------|----------|----------|');

for (const n of [16, 64, 256, 1024, 4096]) {
  const A = new Float64Array(n * n);
  const x = new Float64Array(n);
  for (let i = 0; i < n*n; i++) A[i] = Math.sin(i*0.01);
  for (let i = 0; i < n; i++) x[i] = Math.cos(i*0.05);
  const Anda = vec.from(A, [n, n]);
  const xnda = vec.from(x, [n]);

  const tVec    = bench(() => { sink += vec.dot(Anda, xnda).data[0]; }, 50, 20) * 1000;
  const tNaive  = bench(() => { sink += matvec_naive(A, x, n, n)[0]; }, 50, 20) * 1000;
  const tU4     = bench(() => { sink += matvec_u4(A, x, n, n)[0]; }, 50, 20) * 1000;
  const tU42    = bench(() => { sink += matvec_u4_2rows(A, x, n, n)[0]; }, 50, 20) * 1000;
  const best = Math.min(tNaive, tU4, tU42);
  console.log(`| ${String(n).padStart(3)} | ${tVec.toFixed(2).padStart(14)} | ${tNaive.toFixed(2).padStart(5)} | ${tU4.toFixed(2).padStart(5)} | ${tU42.toFixed(2).padStart(8)} | ${(tVec/best).toFixed(2)}× |`);
}

console.log('\nsink (anti-DCE):', sink.toFixed(2));
