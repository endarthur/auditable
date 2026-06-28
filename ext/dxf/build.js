#!/usr/bin/env node
// Bundle ext/dxf/src/ into ext/dxf/index.js via @gcu/build. Sidecars off: index.js is
// a clean self-contained ESM (loadable in lamina / notebooks without dragging in the
// ndarray engine — geometry is plain Float64Array + @gcu/frame, no natra).
import { bundle } from '../build/src/main.js';

// @gcu/frame is the coordinate-frame contract the reader/writer speak; INLINE it
// (collision-safe via the rename pass) so index.js stays a self-contained ESM.
const r = await bundle({
  at: import.meta.url,
  inline: ['../frame/src/frame.js'],
  sourcemap: false,
  meta: false,
});
console.log(`Built ext/dxf/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
