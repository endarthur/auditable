#!/usr/bin/env node
// Bundle ext/sift/src/ into ext/sift/index.js via @gcu/build. Zero-dep leaf.
// Sidecars off: index.js stays a clean self-contained ESM (a Works surface lib;
// strata + plate inline it).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/sift/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
