#!/usr/bin/env node
// Bundle ext/expr/src/ into ext/expr/index.js via @gcu/build. Zero-dep leaf —
// a self-contained CSP-safe ESM the notebook / lamina / strata can all inline.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/expr/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
