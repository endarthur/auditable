#!/usr/bin/env node
// Bundle ext/sluice/src/ into ext/sluice/index.js via @gcu/build (the owned AST
// bundler). Sidecars off: index.js stays a clean self-contained ESM (it's inlined
// into Works surfaces + imported into @gcu/proc workers).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/sluice/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
