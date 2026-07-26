#!/usr/bin/env node
// Bundle ext/condenser/src/ into ext/condenser/index.js via @gcu/build. Sidecars
// off: index.js stays a clean self-contained ESM.
import { bundle } from '../build/src/main.js';

// @gcu/frame is the coordinate-frame contract the chunk store speaks; INLINE it
// (collision-safe via the rename pass) so index.js stays a self-contained ESM.
const r = await bundle({ at: import.meta.url, inline: ['../frame/src/frame.js', '../dm/src/dm.js', '../drillhole/src/desurvey.js', '../drillhole/src/validate.js', '../drillhole/src/samples.js', '../msh/msh.js'], sourcemap: false, meta: false });
console.log(`Built ext/condenser/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);

// the engine-only bundle — proves the core layer carries zero I/O (its only
// inline is @gcu/frame); the anywidget / embed tier consumes this alone.
const c = await bundle({ at: import.meta.url, entry: 'src/core.js', outFile: 'core.js', inline: ['../frame/src/frame.js'], sourcemap: false, meta: false });
console.log(`Built ext/condenser/core.js (${(c.code.length / 1024).toFixed(1)} KB, ${c.meta.exports.length} exports)`);
