#!/usr/bin/env node
// Bundle ext/coreutils/src/ into ext/coreutils/index.js via @gcu/build. Sidecars off:
// index.js stays a clean self-contained ESM (it's inlined into auditable + reusable
// by any VFS-backed surface).
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/coreutils/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
