#!/usr/bin/env node
// Bundle ext/flowsheet/src/ into ext/flowsheet/index.js via @gcu/build (the owned
// AST bundler). Sidecars off: index.js stays a clean self-contained ESM (inlined
// into Works surfaces).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/flowsheet/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
