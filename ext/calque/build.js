#!/usr/bin/env node
// Bundle ext/calque/src/ into ext/calque/index.js via @gcu/build. Sidecars off:
// index.js stays a clean self-contained ESM (inlined into Works surfaces).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/calque/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
