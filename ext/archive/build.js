#!/usr/bin/env node
// Bundle ext/archive/src/ into ext/archive/index.js.
//
// Same concat pattern as @gcu/licenses and @gcu/yaml — imports/exports are
// stripped, every source file concatenated into a single scope, and a
// declarative footer re-exports the public surface. fflate is vendored at
// ext/archive/vendor/fflate.module.mjs and prepended verbatim (with its
// own exports rewritten to live in the bundle scope).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');
const vendorDir = path.join(__dirname, 'vendor');

const files = ['detect.js', 'source.js', 'sink.js', 'zip.js', 'tar.js', 'api.js'];

const chunks = [];

// ── Vendor: fflate ────────────────────────────────────────────────────
// Prepended before our own code. The vendored copy is the prebuilt ESM
// bundle from npm — pinned by version + sha tracked in vendor-licenses.json.
// Strip its `export ` keywords so the consts/functions land in the same
// scope our src/zip.js will reference them from.
const fflatePath = path.join(vendorDir, 'fflate.module.mjs');
if (fs.existsSync(fflatePath)) {
  let src = fs.readFileSync(fflatePath, 'utf8');
  // fflate's ESM build does `export {a, b, c, ...}` at the end and uses
  // `export function`/`export const` throughout. Same strip rules as ours.
  src = src.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export default /gm, 'const __fflate_default__ = ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- vendor/fflate.module.mjs (MIT, see ext/archive/vendor/LICENSE-fflate) --\n\n${src}`);
} else {
  console.warn('archive: vendor/fflate.module.mjs not found — zip support will not work in the bundle');
}

for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/archive — archive format handling for the GCU stack
// Auto-generated from ext/archive/src/ + ext/archive/vendor/ — do not edit directly.
// fflate (MIT) vendored at ext/archive/vendor/fflate.module.mjs.
`;

const footer = `
export {
  detectFormat, magicForFormat,
  normalizeSource, normalizeSink,
  listZip, readZip,
  listTar, readTar, writeTar,
  archive,
};
`;

const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
