#!/usr/bin/env node
// Bundle ext/scitra/src/ into ext/scitra/index.js as a single ES module.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// Concat order: util (used by everything) → stats (uses util) → spatial
// (standalone) → optimize (standalone, inline Cholesky).
const files = [
  'util/special.js',
  'util/random.js',
  'util/backend.js',
  'stats/distributions.js',
  'stats/descriptives.js',
  'stats/transform.js',
  'stats/kde.js',
  'spatial/distance.js',
  'spatial/kdtree.js',
  'optimize/lstsq.js',
];

function strip(src) {
  // Remove relative-path imports between src files (./foo or ../foo).
  src = src.replace(/^import\s+\{[^}]*\}\s+from\s+['"]\.{1,2}\/[^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^import\s+.*\s+from\s+['"]\.{1,2}\/[^'"]+['"];?\s*$/gm, '');
  // Remove standalone export blocks like `export { foo, bar };`.
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  // Strip the `export` keyword from declarations.
  src = src.replace(/^export\s+function /gm, 'function ');
  src = src.replace(/^export\s+async\s+function /gm, 'async function ');
  src = src.replace(/^export\s+const /gm, 'const ');
  src = src.replace(/^export\s+let /gm, 'let ');
  src = src.replace(/^export\s+class /gm, 'class ');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

// Rename top-level private helpers (anything starting with `_` declared at
// module top via function/const/let/class) with a per-file suffix to
// prevent collisions in the concat'd bundle. Works on word-boundary so
// substring matches inside identifiers are safe.
function uniqueifyPrivates(src, suffix) {
  const lines = src.split('\n');
  const names = new Set();
  for (const line of lines) {
    let m;
    if ((m = line.match(/^function\s+(_[A-Za-z0-9_]+)/))) names.add(m[1]);
    else if ((m = line.match(/^async\s+function\s+(_[A-Za-z0-9_]+)/))) names.add(m[1]);
    else if ((m = line.match(/^const\s+(_[A-Za-z0-9_]+)\s*=/))) names.add(m[1]);
    else if ((m = line.match(/^let\s+(_[A-Za-z0-9_]+)\s*=/))) names.add(m[1]);
    else if ((m = line.match(/^class\s+(_[A-Za-z0-9_]+)/))) names.add(m[1]);
  }
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    src = src.replace(re, `${name}_${suffix}`);
  }
  return src;
}

const chunks = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
  // Suffix derived from the file path (e.g. "stats/kde.js" → "kde").
  const suffix = file.replace(/\.js$/, '').replace(/.*\//, '');
  chunks.push(`// ── ${file} ──\n\n${uniqueifyPrivates(strip(text), suffix)}`);
}

const header = `// @gcu/scitra — scipy-shaped scientific-computing primitives.
// Auto-generated from ext/scitra/src/ — do not edit directly.
//
// v0.1 API surface:
//   util.special: erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta
//   util.random:  mulberry32, makeRng, makeNormalSampler
//   stats:        norm, lognorm (scipy-shaped frozen + functional)
//                 weighted_mean/var/std/percentile/median, ecdf, histogram, moments
//                 normal_score_transform (with weights, ties, BDL, tail extrap)
//                 gaussian_kde (1D, scipy-parity bw_method)
//   spatial:      cdist, pdist, squareform (9 metrics + custom)
//                 KDTree (k-NN, query_ball_point, query_pairs)
//   optimize:     least_squares (Levenberg-Marquardt), curve_fit
`;

const footer = `
export {
  // util/special
  erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta,
  // util/random
  mulberry32, makeRng, makeNormalSampler,
  // util/backend
  setBackend, clearBackend, getNatra, GEMM_NM_THRESHOLD,
  // stats/distributions
  norm, lognorm,
  // stats/descriptives
  weighted_mean, weighted_var, weighted_std,
  weighted_percentile, weighted_median,
  ecdf, histogram, moments,
  // stats/transform
  normal_score_transform,
  // stats/kde
  gaussian_kde,
  // spatial/distance
  cdist, pdist, squareform,
  // spatial/kdtree
  KDTree,
  // optimize/lstsq
  least_squares, curve_fit,
};

// Namespaced barrel for scipy-style imports.
export const stats = {
  norm, lognorm,
  weighted_mean, weighted_var, weighted_std,
  weighted_percentile, weighted_median,
  ecdf, histogram, moments,
  normal_score_transform,
  gaussian_kde,
};
export const spatial = {
  cdist, pdist, squareform,
  distance: { cdist, pdist, squareform },
  KDTree,
  kdtree: { KDTree },
};
export const optimize = { least_squares, curve_fit };
export const special = { erf, erfc, erfinv, ndtri, lgamma, gamma, lbeta };
export const random = { mulberry32, makeRng, makeNormalSampler };
`;

const output = header + '\n' + chunks.join('\n\n') + '\n' + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
