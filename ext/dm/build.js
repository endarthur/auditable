#!/usr/bin/env node
// Bundle ext/dm/src/ into ext/dm/index.js via @gcu/build. Zero-dep leaf —
// a self-contained ESM the notebook / lamina / BMA can all inline.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/dm/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
