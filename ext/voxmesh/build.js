#!/usr/bin/env node
// Bundle ext/voxmesh/src/ into ext/voxmesh/index.js via @gcu/build. Zero-dep
// leaf. Sidecars off: index.js stays a clean self-contained ESM.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/voxmesh/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
