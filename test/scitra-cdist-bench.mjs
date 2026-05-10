// Bench cdist inline vs gemm-accelerated, at varying (n, m, d).
// Runs:
//   node test/scitra-cdist-bench.mjs
//
// Output is a markdown table that should be pasted into a comment in
// ext/scitra/src/util/backend.js to justify GEMM_NM_THRESHOLD.

import { natra } from '../ext/natra/index.js';
import { cdist, setBackend, clearBackend } from '../ext/scitra/index.js';

function _rand(n, d, seed) {
  let s = seed | 0 || 1;
  const out = new Float64Array(n * d);
  for (let i = 0; i < n * d; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s / 0x7fffffff) * 100;
  }
  return out;
}

function _wrap(flat, n, d) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let k = 0; k < d; k++) row.push(flat[i * d + k]);
    arr.push(row);
  }
  return arr;
}

function _bench(label, fn, repeats = 5) {
  // Warm up
  fn();
  const times = [];
  for (let r = 0; r < repeats; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];  // median
}

const nat = await natra({ pages: 1024 });
console.log('natra ready, memory pages:', 1024);

const sizes = [
  { n: 50,   m: 50,   d: 3 },
  { n: 100,  m: 100,  d: 3 },
  { n: 200,  m: 200,  d: 3 },
  { n: 500,  m: 500,  d: 3 },
  { n: 1000, m: 1000, d: 3 },
  { n: 100,  m: 100,  d: 10 },
  { n: 500,  m: 500,  d: 10 },
  { n: 1000, m: 1000, d: 10 },
  { n: 100,  m: 100,  d: 50 },
  { n: 500,  m: 500,  d: 50 },
];

console.log('\n| n × m | d | n*m | inline (ms) | gemm (ms) | speedup |');
console.log('|-------|---|-----|-------------|-----------|---------|');

for (const { n, m, d } of sizes) {
  const Xflat = _rand(n, d, 1);
  const Yflat = _rand(m, d, 2);
  const X = { data: Xflat, shape: [n, d] };
  const Y = { data: Yflat, shape: [m, d] };

  clearBackend();
  const tInline = _bench('inline', () => cdist(X, Y, { backend: 'inline' }));

  setBackend({ natra: nat });
  const tGemm = _bench('gemm', () => cdist(X, Y));

  // Numerical check on first row
  const Di = cdist(X, Y, { backend: 'inline' });
  setBackend({ natra: nat });
  const Dg = cdist(X, Y);
  let maxErr = 0;
  for (let i = 0; i < Math.min(100, Di.length); i++) {
    const e = Math.abs(Di[i] - Dg[i]);
    if (e > maxErr) maxErr = e;
  }
  if (maxErr > 1e-6) {
    console.log(`! n*m mismatch maxErr=${maxErr}`);
  }

  const speedup = tInline / tGemm;
  console.log(`| ${n}×${m} | ${d} | ${(n*m).toLocaleString()} | ${tInline.toFixed(2)} | ${tGemm.toFixed(2)} | ${speedup.toFixed(2)}× |`);
}
