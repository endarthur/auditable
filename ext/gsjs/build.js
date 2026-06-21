// ext/gsjs/build.js — two stages, self-owned (gsjs is the model for undoing
// atra's cross-package build reach):
//
//   1. atra → wasm module. gslib.atra (FROZEN, static-link dep — the fork reuses
//      its kernels) + gsjs.atra are compiled by atrac's `bundleRecipe` (a pure
//      gcu-make recipe) into src/_wasm.js (instantiate/alloc/read·write helpers +
//      embedded bytes). gslib is read only as a dependency — ext/gslib is never
//      edited. _wasm.js is a generated build intermediate (gitignored).
//   2. JS layer → @gcu/build. realize/aggregate/backend/api/recipe (+ @gcu/sift,
//      inlined collision-safe via the rename pass, the over↔dimensions pattern)
//      bundle into a self-contained ESM at ext/gsjs/index.js — browser-loadable
//      (`load('@gcu/gsjs')`), no relative imports left to resolve.
//
// gcu-make auto-discovers this as a @gcu/build package (stage 2) and orchestrates
// it in the derived graph. A .atra edit isn't tracked as a bundle input, so run
// `node ext/gsjs/build.js` (or gcu-make --force) after editing the atra sources.

import { bundle } from '../build/src/main.js';
import { bundleRecipe } from '../atra/atrac.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf8');

// ── stage 1: atra → src/_wasm.js (same recipe gcu-make would run) ──
const wasmInputs = [
  { path: '../gslib/gslib.atra', text: read('..', 'gslib', 'gslib.atra') },
  { path: 'gsjs.atra', text: read('gsjs.atra') },
];
fs.writeFileSync(
  path.join(dir, 'src', '_wasm.js'),
  '// ⚠ GENERATED — atra→wasm bundle (gslib.atra + gsjs.atra). Regenerate: node ext/gsjs/build.js\n'
    + bundleRecipe(wasmInputs, { name: 'gsjs' }),
);

// ── stage 2: @gcu/build the JS layer, inlining @gcu/sift ──
const r = await bundle({
  at: import.meta.url,
  inline: ['../sift/src/predicate.js'],
  sourcemap: false,
  meta: false,
});
console.log(`Built ext/gsjs/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
