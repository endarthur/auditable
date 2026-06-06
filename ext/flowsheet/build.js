#!/usr/bin/env node
// Bundle ext/flowsheet/src/ into ext/flowsheet/index.js via @gcu/build (the owned
// AST bundler). Replaces the old hand-written regex-concat. Sidecars off: index.js
// stays a clean self-contained ESM (inlined into Works surfaces).
import { bundle } from '../build/src/main.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const r = await bundle({ dir, entry: 'src/main.js', sourcemap: false, meta: false });
console.log(`Built ext/flowsheet/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
