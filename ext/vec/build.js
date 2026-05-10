#!/usr/bin/env node
// Bundle ext/vec/src/ into ext/vec/index.js as a single ES module.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// Concat order: ndarray (depended on by everything) → shape (depends on
// ndarray) → creation (depends on ndarray) → ops (depends on shape +
// ndarray) → reduce (depends on ndarray) → linalg-mul → linalg-solve →
// linalg-lstsq (depends on linalg-mul, linalg-solve) → linalg-eigen →
// index (barrel — drop entirely; replaced by the file-end export block).
const files = [
  'ndarray.js',
  'shape.js',
  'creation.js',
  'ops.js',
  'selection.js',
  'reduce.js',
  'linalg-mul.js',
  'linalg-solve.js',
  'linalg-lstsq.js',
  'linalg-eigen.js',
];

function strip(src) {
  // Remove relative-path imports between src files.
  src = src.replace(/^import\s+\{[^}]*\}\s+from\s+['"]\.\/[^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^import\s+.*\s+from\s+['"]\.\/[^'"]+['"];?\s*$/gm, '');
  // Remove standalone export blocks like `export { foo, bar };`.
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  // Strip the `export` keyword from declarations so they remain as plain decls.
  src = src.replace(/^export\s+function /gm, 'function ');
  src = src.replace(/^export\s+async\s+function /gm, 'async function ');
  src = src.replace(/^export\s+const /gm, 'const ');
  src = src.replace(/^export\s+let /gm, 'let ');
  src = src.replace(/^export\s+class /gm, 'class ');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

const chunks = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
  chunks.push(`// ── ${file} ──\n\n${strip(text)}`);
}

const header = `// @gcu/vec — TypedArray-based numerical library.
// Auto-generated from ext/vec/src/ — do not edit directly.
//
// API surface (named exports below at file end):
//   NdArray, shapeProduct, computeStrides
//   zeros, ones, full, range, linspace, eye, from
//   add, sub, mul, div, pow, neg, abs, sqrt, log, exp, sin, cos, tan
//   reshape, flatten, copy, slice
//   broadcastShapes, broadcastStrides, broadcastBinary, shapesEqual
//   sum, mean, max, min, std, variance, var_, norm, dot
//   matmul, transpose, det2, det3, det4, inv2, inv3, inv4
//   solve, det, inv, cholesky, solveCholesky, lstsq
//   eigSym3, eigSym
`;

const footer = `
export {
  // ndarray
  NdArray, shapeProduct, computeStrides,
  // shape
  reshape, flatten, copy, slice, concat, stack,
  broadcastShapes, broadcastStrides, broadcastBinary, shapesEqual,
  // creation
  zeros, ones, full, range, linspace, eye, from,
  // ops (binary + unary)
  add, sub, mul, div, pow,
  neg, abs, sqrt, log, exp, sin, cos, tan,
  asin, acos, atan,
  floor, ceil, round, sign,
  isnan, isfinite,
  atan2, hypot, maximum, minimum,
  eq, ne, lt, le, gt, ge,
  // selection
  where, clip,
  // reduce
  sum, mean, max, min, std, variance, variance as var_, norm, dot,
  prod, cumsum, cumprod, argmin, argmax, trace,
  // linalg-mul
  matmul, transpose,
  det2, det3, det4,
  inv2, inv3, inv4,
  diag, outer, tril, triu,
  // linalg-solve
  solve, det, inv, cholesky, solveCholesky,
  // linalg-lstsq
  lstsq,
  // linalg-eigen
  eigSym3, eigSym,
};
`;

const output = header + '\n' + chunks.join('\n\n') + '\n' + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
