// Bench AIR-emitted vs hand-written ddot_unrolled4 to confirm the fix
// restored V8 auto-vectorization perf.

import * as Acorn from 'acorn';
import tsPlugin from 'acorn-typescript';
import { analyzeCell } from '../ext/air/src/api.js';
import { emitJS } from '../ext/air/src/emit-js.js';

const Parser = Acorn.Parser.extend(tsPlugin());

const source = `
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
`;

// AIR-emitted version
const result = analyzeCell(source, Parser, new Set());
const emitted = emitJS(result.air, [], [], { cellId: 'test', cellName: 'perf' });
const air = new Function(emitted + '\nreturn { ddot_unrolled4 };')().ddot_unrolled4;

// Direct (no AIR)
const raw = new Function('x', 'y', 'n', `
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
`);

function bench(fn, n) {
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = Math.sin(i * 0.1); y[i] = Math.cos(i * 0.1); }
  fn(x, y, n); fn(x, y, n);  // warm
  let s = 0;
  const ts = [];
  for (let r = 0; r < 30; r++) {
    const t0 = performance.now();
    for (let k = 0; k < 100; k++) s += fn(x, y, n);
    ts.push((performance.now() - t0) / 100);
  }
  ts.sort();
  return { time: ts[15] * 1000, sink: s };
}

console.log('| n     | AIR-emitted | new Function | ratio |');
console.log('|-------|-------------|--------------|-------|');
for (const n of [128, 1024, 8192, 32768, 131072]) {
  const a = bench(air, n);
  const r = bench(raw, n);
  console.log(`| ${String(n).padStart(5)} | ${a.time.toFixed(2).padStart(10)} | ${r.time.toFixed(2).padStart(12)} | ${(a.time / r.time).toFixed(2)}× |`);
  if (Math.abs(a.sink - r.sink) > 1e-6) {
    console.log(`  ! sink mismatch: ${a.sink} vs ${r.sink}`);
  }
}
