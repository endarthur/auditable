#!/usr/bin/env node
// Bundle ext/gtiff/src/ into ext/gtiff/index.js via @gcu/build. Zero-dep leaf:
// pure JS TIFF parsing; deflate rides the platform's DecompressionStream, so
// the bundle carries no inflate code and no WASM — Sealed profiles keep their
// claim with this inside.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/gtiff/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
