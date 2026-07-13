#!/usr/bin/env node
// Bundle ext/dispatch/src/ into ext/dispatch/index.js via @gcu/build.
// Zero-dep leaf — the session-trained NL → tool-call dispatcher; browser-pure
// so hosts can train in the tab. Sidecars off: index.js is clean ESM.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/dispatch/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
