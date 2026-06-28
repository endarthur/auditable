#!/usr/bin/env node
// Bundle ext/wkt/src/ into ext/wkt/index.js via @gcu/build. Zero-dep leaf — the OGC WKT
// codec (the data-bridge serialization). Sidecars off: index.js is a clean self-contained ESM.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/wkt/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
