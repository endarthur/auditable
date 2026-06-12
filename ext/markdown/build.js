#!/usr/bin/env node
// Bundle ext/markdown/src/ into ext/markdown/index.js via @gcu/build. Zero-dep
// leaf — the engine itself must stay dependency-free (SPEC §2); only the build
// tooling is shared.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/markdown/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
