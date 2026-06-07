#!/usr/bin/env node
// Bundle ext/dimensions/src/ into ext/dimensions/index.js via @gcu/build. Zero-dep
// leaf. Sidecars off: index.js stays a clean self-contained ESM (inlined into the
// works-all bundle; over inlines the dimensions.js source directly).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/dimensions/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
