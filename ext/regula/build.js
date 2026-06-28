#!/usr/bin/env node
// Bundle ext/regula/src/ into ext/regula/index.js via @gcu/build. v0.1 is a zero-dep leaf
// (the transform tier); the curve-ops tiers will pull @gcu/groma's exact predicates, at
// which point this becomes a non-leaf bundle (inline groma, like dxf inlines frame).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/regula/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
