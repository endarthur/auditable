#!/usr/bin/env node
// Bundle ext/condenser/src/ into ext/condenser/index.js via @gcu/build. Sidecars
// off: index.js stays a clean self-contained ESM.
import { bundle } from '../build/src/main.js';

// @gcu/frame is the coordinate-frame contract the chunk store speaks; INLINE it
// (collision-safe via the rename pass) so index.js stays a self-contained ESM.
const r = await bundle({ at: import.meta.url, inline: ['../frame/src/frame.js', '../dm/src/dm.js'], sourcemap: false, meta: false });
console.log(`Built ext/condenser/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
