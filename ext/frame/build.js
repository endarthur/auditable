#!/usr/bin/env node
// Bundle ext/frame/src/ into ext/frame/index.js via @gcu/build. Zero-dep leaf — the
// coordinate-frame contract every geometry package speaks; everything depends on it,
// so it must stay dependency-free. Sidecars off: index.js is a clean self-contained ESM.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/frame/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
