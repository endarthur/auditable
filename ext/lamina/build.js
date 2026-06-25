#!/usr/bin/env node
// Bundle ext/lamina/src/ into ext/lamina/index.js via @gcu/build. Zero-dep leaf
// (loom's PENDING is injected, not imported — see provider.js).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/lamina/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
