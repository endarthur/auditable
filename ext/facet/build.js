#!/usr/bin/env node
// Bundle ext/facet/src/ into ext/facet/index.js via @gcu/build.
//
// groma's topology is INLINED — facet's bundle should be droppable on its own,
// and the topology is 170 lines. @gcu/bearing is NOT: it is 128 KB of vendored
// stereonet library that micro needs in its own right, so it stays a bare
// specifier and the host resolves one copy through its import map.
import { bundle } from '../build/src/main.js';

const r = await bundle({
  at: import.meta.url,
  inline: ['../groma/src/topology.js'],
  sourcemap: false,
  meta: false,
});
console.log(`Built ext/facet/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
