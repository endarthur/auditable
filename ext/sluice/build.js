#!/usr/bin/env node
// Bundle ext/sluice/src/ into ext/sluice/index.js via @gcu/build (the owned AST
// bundler — rename-on-collision, import-graph manifest, lint). Replaces the old
// hand-written regex-concat. Sidecars off for now: index.js stays a clean
// self-contained ESM (it's inlined into Works surfaces + imported into workers).
import { bundle } from '../build/src/main.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const r = await bundle({ dir, entry: 'src/main.js', sourcemap: false, meta: false });
console.log(`Built ext/sluice/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
