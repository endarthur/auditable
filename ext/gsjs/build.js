// ext/gsjs/build.js — co-compiles gslib.atra (FROZEN) + gsjs.atra into the gsjs
// wasm bundle, appends api.js, emits ext/gsjs/index.js.
//
// Self-owned on purpose: gslib's dist is currently built by ext/atra/build.js
// reaching across packages (a coupling to undo eventually). gsjs owns its build
// here — it reads gslib.atra only as a static-link dependency (the fork reuses
// gslib's kernels in gsjs's own wasm), never editing it.

import { bundle } from '../atra/atrac.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const gslibSrc = fs.readFileSync(path.join(dir, '..', 'gslib', 'gslib.atra'), 'utf8');
const gsjsSrc = fs.readFileSync(path.join(dir, 'gsjs.atra'), 'utf8');

let out = bundle(gslibSrc + '\n' + gsjsSrc, { name: 'gsjs' });
out += '\n' + fs.readFileSync(path.join(dir, 'api.js'), 'utf8');
// recipe.js is concatenated AFTER api.js — it references kriging/realize/STATUS/
// stats/histogram/swath/gradeTonnage from the bundle's module scope. Its only
// import (@gcu/sift, the serializable `where` selector) survives into index.js;
// a future browser bundle inlines sift (already a /usr/lib builtin).
out += '\n' + fs.readFileSync(path.join(dir, 'recipe.js'), 'utf8');

fs.writeFileSync(path.join(dir, 'index.js'), out);
console.log(`Built ext/gsjs/index.js (${(out.length / 1024).toFixed(1)} KB)`);
