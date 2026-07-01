#!/usr/bin/env node
// Bundle ext/winding/src/ into ext/winding/index.js via @gcu/build. Sidecars off:
// index.js stays a clean self-contained ESM (inlined into Works surfaces).
import { bundle } from '../build/src/main.js';

// @gcu/frame is the coordinate-frame contract setMesh/evaluate speak; INLINE it
// (collision-safe via the rename pass) so index.js stays a self-contained ESM.
const r = await bundle({ at: import.meta.url, inline: ['../frame/src/frame.js'], sourcemap: false, meta: false });
console.log(`Built ext/winding/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
