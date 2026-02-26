#!/usr/bin/env node
// Bundles ext/atra/src/ ES modules into a single index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

// Extract module paths from main.js (imports and re-exports)
const importPaths = [];
for (const line of mainSrc.split('\n')) {
  const m = line.match(/^(?:import|export)\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m) importPaths.push(m[1]);
}

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  // Strip import lines (single-line and multi-line)
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  // Replace export function -> function, export const -> const, etc.
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');

  // Strip export { ... } and export default lines
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  // Trim leading/trailing blank lines
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');

  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// @auditable/atra — Arithmetic TRAnspiler\n'
  + '// Fortran/Pascal hybrid → WebAssembly bytecode. Single-file compiler.\n';

const output = header + '\n' + chunks.join('\n\n') + '\n\nexport { atra };\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/atra/index.js (${(size / 1024).toFixed(1)} KB)`);

// ── Build lib/alpack.src.js from lib/alpack.atra ──

import { buildSrc, formatSrcJs, bundle } from './atrac.js';

const libDir = path.join(__dirname, 'lib');

// ── alpack ──

const alpackPath = path.join(libDir, 'alpack.atra');
if (fs.existsSync(alpackPath)) {
  const atraSrc = fs.readFileSync(alpackPath, 'utf8');
  const libOut = formatSrcJs(buildSrc(atraSrc));
  const libOutPath = path.join(libDir, 'alpack.src.js');
  fs.writeFileSync(libOutPath, libOut);
  const libSize = fs.statSync(libOutPath).size;
  console.log(`Built ext/atra/lib/alpack.src.js (${(libSize / 1024).toFixed(1)} KB)`);

  const bundleOut = bundle(atraSrc, { name: 'alpack' });
  const bundlePath = path.join(libDir, 'alpack.js');
  fs.writeFileSync(bundlePath, bundleOut);
  const bundleSize = fs.statSync(bundlePath).size;
  console.log(`Built ext/atra/lib/alpack.js (${(bundleSize / 1024).toFixed(1)} KB)`);
}

// ── gslib ──

const gslibAtraPath = path.join(__dirname, '..', 'gslib', 'gslib.atra');
if (fs.existsSync(gslibAtraPath)) {
  const gslibSrc = fs.readFileSync(gslibAtraPath, 'utf8');

  let gslibBundleOut = bundle(gslibSrc, { name: 'gslib' });
  const gslibApiPath = path.join(__dirname, '..', 'gslib', 'api.js');
  if (fs.existsSync(gslibApiPath)) {
    gslibBundleOut += '\n' + fs.readFileSync(gslibApiPath, 'utf8');
  }
  const gslibBundlePath = path.join(libDir, 'gslib.js');
  fs.writeFileSync(gslibBundlePath, gslibBundleOut);
  const gslibBundleSize = fs.statSync(gslibBundlePath).size;
  console.log(`Built ext/atra/lib/gslib.js (${(gslibBundleSize / 1024).toFixed(1)} KB)`);
}
