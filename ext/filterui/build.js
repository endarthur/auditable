#!/usr/bin/env node
// Bundle ext/filterui/src/ into ext/filterui/index.js via @gcu/build.
// Zero-dep leaf: @gcu/expr arrives injected ({ parse, validate, quoteIdent }),
// never imported — both hosts (micro, lamina) already carry expr and pass
// their copy in, so the bundle stays import-map-free.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/filterui/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
