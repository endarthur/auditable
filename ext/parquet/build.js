#!/usr/bin/env node
// Bundle vendored hyparquet + hyparquet-writer + WASM-free codecs (fflate gzip,
// fzstd zstd) into ext/parquet/index.js — a single self-contained ESM for
// @gcu/parquet. Pure JS, no WASM, so Sealed builds keep their claim.
import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const bundle = await rollup({
  input: join(__dirname, 'entry.mjs'),
  plugins: [resolve(), terser({ compress: { passes: 2 }, mangle: true })],
});
const out = join(__dirname, 'index.js');
await bundle.write({ file: out, format: 'es' });
await bundle.close();
console.log(`Built ext/parquet/index.js (${(statSync(out).size / 1024).toFixed(1)} KB)`);
