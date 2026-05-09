// natra (raw JS API, wasm-backed ndarray) vs CPython numpy.
// natra arrays are allocated outside the scope; the scope only does
// arithmetic. So all comparisons are "op only" — fair vs numpy's
// pre-allocated case. Allocation overhead is documented separately.

import { natra } from '../ext/natra/index.js';

const ctx = await natra({ pages: 256 });

async function time(label, runs, fn) {
  for (let i = 0; i < 3; i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(36)}: ${elapsed.toFixed(1)}ms (${(elapsed/runs).toFixed(3)}ms/run)`);
  return elapsed / runs;
}

console.log('=== 10K vector add (op only) ===');
console.log('CPython pure list:                     0.686ms/run');
console.log('CPython numpy (alloc + op):            0.021ms/run');
console.log('CPython numpy (op only):               0.007ms/run');

await time('JS plain Float64Array (alloc + op)', 1000, async () => {
  const a = new Float64Array(10000);
  const b = new Float64Array(10000);
  for (let i = 0; i < 10000; i++) { a[i] = i; b[i] = i; }
  const c = new Float64Array(10000);
  for (let i = 0; i < 10000; i++) c[i] = a[i] + b[i];
});

const ja10k = new Float64Array(10000);
const jb10k = new Float64Array(10000);
for (let i = 0; i < 10000; i++) { ja10k[i] = i; jb10k[i] = i; }
const jc10k = new Float64Array(10000);
await time('JS plain Float64Array (op only)', 1000, async () => {
  for (let i = 0; i < 10000; i++) jc10k[i] = ja10k[i] + jb10k[i];
});

const a10k = ctx.arange(0, 10000);
const b10k = ctx.arange(0, 10000);
await time('natra (op only)', 1000, async () => {
  ctx.scope(s => s.add(a10k, b10k));
});

console.log('\n=== 100K element sum (op only) ===');
console.log('CPython pure list:                     7.241ms/run');
console.log('CPython numpy (alloc + op):            0.156ms/run');
console.log('CPython numpy (op only):               0.023ms/run');

await time('JS plain Float64Array (alloc + op)', 1000, async () => {
  const a = new Float64Array(100000);
  for (let i = 0; i < 100000; i++) a[i] = i;
  let s = 0;
  for (let i = 0; i < 100000; i++) s += a[i];
});

const ja100k = new Float64Array(100000);
for (let i = 0; i < 100000; i++) ja100k[i] = i;
await time('JS plain Float64Array (op only)', 1000, async () => {
  let s = 0;
  for (let i = 0; i < 100000; i++) s += ja100k[i];
});

const a100k = ctx.arange(0, 100000);
await time('natra (op only)', 1000, async () => {
  ctx.scope(s => s.sum(a100k));
});

console.log('\n=== 10K dot product (op only) ===');
console.log('CPython pure list:                     1.222ms/run');
console.log('CPython numpy (alloc + op):            0.030ms/run');
console.log('CPython numpy (op only):               0.009ms/run');

await time('JS plain Float64Array (alloc + op)', 1000, async () => {
  const a = new Float64Array(10000);
  const b = new Float64Array(10000);
  for (let i = 0; i < 10000; i++) { a[i] = i; b[i] = i; }
  let s = 0;
  for (let i = 0; i < 10000; i++) s += a[i] * b[i];
});

await time('JS plain Float64Array (op only)', 1000, async () => {
  let s = 0;
  for (let i = 0; i < 10000; i++) s += ja10k[i] * jb10k[i];
});

await time('natra (op only)', 1000, async () => {
  ctx.scope(s => s.dot(a10k, b10k));
});
