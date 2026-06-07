#!/usr/bin/env node
// Bundle ext/over/src/ into ext/over/index.js via @gcu/build (the owned AST
// bundler). @gcu/dimensions is the zero-dep dimension algebra under units.js;
// it's INLINED (collision-safe via the rename pass) — its symbols enter bundle
// scope, and units.js re-exports the two over surfaces (dimEq/dimFormat) it needs.
// Sidecars off: index.js stays a clean self-contained ESM (inlined into Works
// surfaces + the works-all bundle).
import { bundle } from '../build/src/main.js';

const r = await bundle({
  at: import.meta.url,
  inline: ['../dimensions/src/dimensions.js'],
  sourcemap: false,
  meta: false,
});
console.log(`Built ext/over/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
