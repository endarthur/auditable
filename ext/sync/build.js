#!/usr/bin/env node
// Bundle ext/sync/src/ into ext/sync/index.js via @gcu/build. Zero-dep leaf.
// Sidecars off: index.js stays a clean self-contained ESM (inlined into surfaces;
// imported in node).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/sync/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
