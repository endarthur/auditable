#!/usr/bin/env node
// Bundle ext/strata/src/ into ext/strata/index.js via @gcu/build (the owned AST
// bundler). predicate.js was extracted to @gcu/sift; strata's src/predicate.js is
// a dev/node re-export stub (`export * from ../../sift/src/predicate.js`). We INLINE
// sift's predicate.js (a zero-dep leaf) so the bundle stays self-contained and
// re-exports the same symbols. Sidecars off: index.js stays a clean self-contained
// ESM (the standalone tool loads it, Works surfaces inline it).
import { bundle } from '../build/src/main.js';

const r = await bundle({
  at: import.meta.url,
  inline: ['../sift/src/predicate.js'],
  sourcemap: false,
  meta: false,
});
console.log(`Built ext/strata/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
