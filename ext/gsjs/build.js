// ext/gsjs/build.js — @gcu/build bundles the (now pure-JS) gsjs JS layer into a
// self-contained ESM at ext/gsjs/index.js — browser-loadable (`load('@gcu/gsjs')`),
// no relative imports left to resolve.
//
// gsjs used to co-compile a forked atra kernel (gslib.atra + gsjs.atra → src/_wasm.js)
// for the M1 `kriging()` path; that fork was removed (NaN-broken at scale, superseded
// by the pure-JS neighbourhood-driven krige()), so there's no atra/wasm stage anymore —
// gsjs is pure JS. The kt3d oracle it validates against lives in @gcu/gslib (separate
// package, its own build) and is used only by the tests.
//
// gcu-make auto-discovers this as a @gcu/build package and orchestrates it in the
// derived graph (@gcu/sift + scitra's kdtree are inlined collision-safe).

import { bundle } from '../build/src/main.js';

const r = await bundle({
  at: import.meta.url,
  inline: [
    '../sift/src/predicate.js',          // the serializable `where` selector (recipe.js)
    '../scitra/src/spatial/kdtree.js',   // the neighbourhood's spatial index (neigh.js)
  ],
  sourcemap: false,
  meta: false,
});
console.log(`Built ext/gsjs/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
